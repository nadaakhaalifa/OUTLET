import type { Queryable } from "@outlet/db";
import type { Logger } from "@outlet/logger";
import { DAY_MS, resolveDeps } from "./deps.js";
import type { PrivacyDeps, ResolvedDeps } from "./deps.js";
import { DeletionBlockedError, DuplicateOpenRequestError, RequestNotFoundError, UserNotFoundError } from "./errors.js";
import type { DeletionBlocker } from "./errors.js";
import { assertTransition } from "./machine.js";
import type { RequestStatus } from "./machine.js";

export const COOLING_DAYS = 14;

/** Reports open orders, returns and disputes for a user (implemented by the orders/returns modules later). */
export interface BlockerPort {
  findBlockers(userId: string): Promise<readonly DeletionBlocker[]>;
}

/**
 * Erases PII and pseudonymises financial/tax rows (V77). Runs inside the caller's transaction so a failure
 * leaves the request in COOLING and the data untouched.
 */
export interface PseudonymizerPort {
  pseudonymize(tx: Queryable, subject: { readonly userId: string; readonly marketId: string }): Promise<void>;
}

export interface DeletionRequestView {
  readonly id: string;
  readonly userId: string;
  readonly status: RequestStatus;
  readonly coolingUntil: Date;
}

export interface ExecuteReport {
  readonly completed: readonly string[];
  /** Due requests skipped because a blocker appeared during cooling; they stay in COOLING. */
  readonly blocked: readonly string[];
  readonly failed: readonly string[];
}

interface ReqRow {
  id: string;
  user_id: string;
  market_id: string;
  status: RequestStatus;
  cooling_until: Date | null;
}

export class DeletionService {
  private readonly d: ResolvedDeps;
  constructor(
    deps: PrivacyDeps,
    private readonly blockers: BlockerPort,
    private readonly pseudonymizer: PseudonymizerPort,
    private readonly logger?: Logger,
  ) {
    this.d = resolveDeps(deps);
  }

  async request(userId: string, idempotencyKey?: string): Promise<DeletionRequestView> {
    const blockers = (await this.blockers.findBlockers(userId)).filter((b) => b.count > 0);
    if (blockers.length > 0) throw new DeletionBlockedError(blockers);
    return this.d.db.transaction(async (tx) => {
      const u = await tx.query<{ market_id: string }>("SELECT market_id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const marketId = u.rows[0]?.market_id;
      if (marketId === undefined) throw new UserNotFoundError(userId);
      const key = idempotencyKey ?? this.d.newId();
      const prior = await tx.query<ReqRow>(
        "SELECT id, user_id, market_id, status, cooling_until FROM privacy_requests WHERE user_id = $1 AND idempotency_key = $2",
        [userId, key],
      );
      const existing = prior.rows[0];
      if (existing?.cooling_until) {
        return { id: existing.id, userId, status: existing.status, coolingUntil: existing.cooling_until };
      }
      const open = await tx.query("SELECT 1 FROM privacy_requests WHERE user_id = $1 AND kind = 'delete' AND status IN ('RECEIVED','VERIFIED','COOLING','IN_PROGRESS')", [userId]);
      if (open.rows.length > 0) throw new DuplicateOpenRequestError("delete");
      const now = this.d.now();
      const coolingUntil = new Date(now.getTime() + COOLING_DAYS * DAY_MS);
      const id = this.d.newId();
      await tx.query(
        `INSERT INTO privacy_requests (id, user_id, market_id, kind, status, due_at, cooling_until, idempotency_key, created_at, updated_at)
         VALUES ($1,$2,$3,'delete','COOLING',$4,$4,$5,$6,$6)`,
        [id, userId, marketId, coolingUntil, key, now],
      );
      await tx.query("UPDATE users SET status = 'deletion_pending', updated_at = $2 WHERE id = $1 AND status = 'active'", [userId, now]);
      await this.emit(tx, "privacy.deletion_requested", id, marketId, now, { userId, coolingUntil: coolingUntil.toISOString() });
      return { id, userId, status: "COOLING" as const, coolingUntil };
    });
  }

  /** Cancels a deletion while it is still cooling. */
  async cancel(userId: string, requestId: string): Promise<void> {
    await this.d.db.transaction(async (tx) => {
      const r = await this.load(tx, requestId, userId);
      assertTransition("delete", r.status, "CANCELLED");
      const now = this.d.now();
      await tx.query("UPDATE privacy_requests SET status = 'CANCELLED', updated_at = $2 WHERE id = $1", [requestId, now]);
      await tx.query("UPDATE users SET status = 'active', updated_at = $2 WHERE id = $1 AND status = 'deletion_pending'", [userId, now]);
    });
  }

  /** Runs every deletion whose cooling period has ended. Each request is its own transaction. */
  async execute(): Promise<ExecuteReport> {
    const now = this.d.now();
    const due = await this.d.db.query<ReqRow>(
      "SELECT id, user_id, market_id, status, cooling_until FROM privacy_requests WHERE kind = 'delete' AND status = 'COOLING' AND cooling_until <= $1 ORDER BY cooling_until, id",
      [now],
    );
    const completed: string[] = [];
    const blocked: string[] = [];
    const failed: string[] = [];
    for (const row of due.rows) {
      const open = (await this.blockers.findBlockers(row.user_id)).filter((b) => b.count > 0);
      if (open.length > 0) {
        blocked.push(row.id);
        continue;
      }
      try {
        await this.d.db.transaction(async (tx) => {
          const cur = await this.load(tx, row.id, row.user_id);
          assertTransition("delete", cur.status, "IN_PROGRESS");
          await tx.query("UPDATE privacy_requests SET status = 'IN_PROGRESS', updated_at = $2 WHERE id = $1", [row.id, now]);
          await this.pseudonymizer.pseudonymize(tx, { userId: row.user_id, marketId: row.market_id });
          assertTransition("delete", "IN_PROGRESS", "COMPLETED");
          await tx.query("UPDATE privacy_requests SET status = 'COMPLETED', completed_at = $2, updated_at = $2 WHERE id = $1", [row.id, now]);
          // Free the phone/email for re-registration: blind indexes are the lookup keys (0003: users.phone_bidx, email_bidx).
          await tx.query("UPDATE users SET phone_bidx = NULL, email_bidx = NULL WHERE id = $1", [row.user_id]);
          await tx.query("UPDATE users SET status = 'deleted', deleted_at = $2, updated_at = $2 WHERE id = $1", [row.user_id, now]);
          await this.emit(tx, "privacy.deletion_completed", row.id, row.market_id, now, { userId: row.user_id });
        });
        completed.push(row.id);
      } catch (e) {
        failed.push(row.id);
        this.logger?.error("deletion execution failed", { requestId: row.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { completed, blocked, failed };
  }

  private async load(tx: Queryable, id: string, userId: string): Promise<ReqRow> {
    const r = await tx.query<ReqRow>(
      "SELECT id, user_id, market_id, status, cooling_until FROM privacy_requests WHERE id = $1 AND user_id = $2 AND kind = 'delete' FOR UPDATE",
      [id, userId],
    );
    const row = r.rows[0];
    if (!row) throw new RequestNotFoundError(id);
    return row;
  }

  private emit(tx: Queryable, type: string, id: string, marketId: string, at: Date, payload: Record<string, string>): Promise<unknown> {
    return this.d.outbox.append(tx, {
      id: this.d.newId(),
      type,
      aggregateType: "privacy_request",
      aggregateId: id,
      marketId,
      occurredAt: at.toISOString(),
      payload: { requestId: id, ...payload },
    });
  }
}
