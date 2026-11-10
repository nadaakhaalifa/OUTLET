import type { Queryable } from "@outlet/db";
import { HOUR_MS, resolveDeps } from "./deps.js";
import type { PrivacyDeps, ResolvedDeps } from "./deps.js";
import { DuplicateOpenRequestError, RequestNotFoundError, UserNotFoundError } from "./errors.js";
import type { ExportField } from "./inventory.js";
import { assertTransition } from "./machine.js";
import type { RequestStatus } from "./machine.js";

export const EXPORT_SLA_HOURS = 72;
export const EXPORT_LINK_HOURS = 24;

/** Builds the AR/EN ZIP and returns its object key. The real implementation is a worker (later). */
export interface ExportBuilderPort {
  build(subject: { readonly userId: string; readonly marketId: string }, fields: readonly ExportField[]): Promise<{ objectKey: string }>;
}

export interface ExportRequestView {
  readonly id: string;
  readonly status: RequestStatus;
  readonly dueAt: Date;
}

interface ReqRow {
  id: string;
  user_id: string;
  market_id: string;
  status: RequestStatus;
  due_at: Date;
}

export class ExportService {
  private readonly d: ResolvedDeps;
  constructor(
    deps: PrivacyDeps,
    private readonly fields: () => Promise<readonly ExportField[]>,
    private readonly builder?: ExportBuilderPort,
  ) {
    this.d = resolveDeps(deps);
  }

  async request(userId: string, idempotencyKey?: string): Promise<ExportRequestView> {
    return this.d.db.transaction(async (tx) => {
      const u = await tx.query<{ market_id: string }>("SELECT market_id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const marketId = u.rows[0]?.market_id;
      if (marketId === undefined) throw new UserNotFoundError(userId);
      const key = idempotencyKey ?? this.d.newId();
      const prior = await tx.query<ReqRow>(
        "SELECT id, user_id, market_id, status, due_at FROM privacy_requests WHERE user_id = $1 AND idempotency_key = $2",
        [userId, key],
      );
      const existing = prior.rows[0];
      if (existing) return { id: existing.id, status: existing.status, dueAt: existing.due_at };
      const open = await tx.query("SELECT 1 FROM privacy_requests WHERE user_id = $1 AND kind = 'export' AND status IN ('RECEIVED','IN_PROGRESS')", [userId]);
      if (open.rows.length > 0) throw new DuplicateOpenRequestError("export");
      const now = this.d.now();
      const dueAt = new Date(now.getTime() + EXPORT_SLA_HOURS * HOUR_MS);
      const id = this.d.newId();
      await tx.query(
        `INSERT INTO privacy_requests (id, user_id, market_id, kind, status, due_at, idempotency_key, created_at, updated_at)
         VALUES ($1,$2,$3,'export','RECEIVED',$4,$5,$6,$6)`,
        [id, userId, marketId, dueAt, key, now],
      );
      return { id, status: "RECEIVED" as const, dueAt };
    });
  }

  /** Worker picked the request up. */
  async start(requestId: string): Promise<void> {
    await this.d.db.transaction(async (tx) => {
      const r = await this.load(tx, requestId);
      assertTransition("export", r.status, "IN_PROGRESS");
      await tx.query("UPDATE privacy_requests SET status = 'IN_PROGRESS', updated_at = $2 WHERE id = $1", [requestId, this.d.now()]);
    });
  }

  /** Marks the export ready; the signed link expires 24 hours later. */
  async complete(requestId: string, objectKey: string): Promise<{ expiresAt: Date }> {
    return this.d.db.transaction(async (tx) => {
      const r = await this.load(tx, requestId);
      assertTransition("export", r.status, "COMPLETED");
      const now = this.d.now();
      const expiresAt = new Date(now.getTime() + EXPORT_LINK_HOURS * HOUR_MS);
      await tx.query(
        "UPDATE privacy_requests SET status = 'COMPLETED', export_object_key = $2, export_expires_at = $3, completed_at = $4, updated_at = $4 WHERE id = $1",
        [requestId, objectKey, expiresAt, now],
      );
      await this.d.outbox.append(tx, {
        id: this.d.newId(),
        type: "privacy.export_ready",
        aggregateType: "privacy_request",
        aggregateId: requestId,
        marketId: r.market_id,
        occurredAt: now.toISOString(),
        payload: { requestId, userId: r.user_id, expiresAt: expiresAt.toISOString() },
      });
      return { expiresAt };
    });
  }

  /** Worker entry point: start, build with the inventory-derived field list, complete. */
  async run(requestId: string): Promise<{ expiresAt: Date }> {
    if (!this.builder) throw new Error("no ExportBuilderPort configured");
    await this.start(requestId);
    const r = await this.d.db.query<ReqRow>("SELECT id, user_id, market_id, status, due_at FROM privacy_requests WHERE id = $1", [requestId]);
    const row = r.rows[0];
    if (!row) throw new RequestNotFoundError(requestId);
    const { objectKey } = await this.builder.build({ userId: row.user_id, marketId: row.market_id }, await this.fields());
    return this.complete(requestId, objectKey);
  }

  private async load(tx: Queryable, id: string): Promise<ReqRow> {
    const r = await tx.query<ReqRow>(
      "SELECT id, user_id, market_id, status, due_at FROM privacy_requests WHERE id = $1 AND kind = 'export' FOR UPDATE",
      [id],
    );
    const row = r.rows[0];
    if (!row) throw new RequestNotFoundError(id);
    return row;
  }
}
