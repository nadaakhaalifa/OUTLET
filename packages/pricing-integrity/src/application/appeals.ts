import type { ClaimScorer } from "./scorer.js";
import { asStore, asWatchWorker, emit, WatchError } from "./watch-env.js";
import type { WatchEnv } from "./watch-env.js";

export interface AppealInput {
  readonly storeId: string;
  readonly userId: string;
  readonly findingId: string;
  readonly idempotencyKey: string;
  /** Machine-readable evidence: a newly connected, verified channel. Uploaded documents alone go to Ops. */
  readonly connectionId?: string;
  readonly evidenceMediaId?: string;
  /** The "was" price the seller asserts (re-checked, never trusted). */
  readonly claimedReferenceMinor?: bigint;
}
export type AppealStatus = "pending_rescore" | "ops_queue" | "upheld" | "rejected";

export class AppealService {
  constructor(private readonly env: WatchEnv, private readonly scorer: ClaimScorer) {}

  /** Idempotent per key. Suspensions (human-review actions) go straight to the Ops queue; everything else is re-scored automatically. */
  async submit(i: AppealInput): Promise<{ id: string; status: AppealStatus }> {
    if (i.connectionId === undefined && i.evidenceMediaId === undefined) throw new WatchError("invalid", "evidence is required");
    const res = await asStore(this.env, i.storeId, i.userId, async (tx) => {
      // One key per (store, key): the same key with a different finding is a different request (422), never a database error.
      const prior = await tx.query<{ id: string; status: AppealStatus; finding_id: string }>("SELECT id, status, finding_id FROM price_appeals WHERE idempotency_key = $1 AND store_id = $2", [i.idempotencyKey, i.storeId]);
      if (prior.rows[0] !== undefined) return { ...this.replay(prior.rows[0], i), fresh: false };
      const f = await tx.query<{ id: string }>("SELECT id FROM price_findings WHERE id = $1 AND store_id = $2 AND status IN ('open', 'appealed')", [i.findingId, i.storeId]);
      if (f.rows[0] === undefined) throw new WatchError("not_found", "finding not found");
      if (i.connectionId !== undefined) {
        const c = await tx.query<{ id: string }>("SELECT id FROM channel_connections WHERE id = $1 AND store_id = $2 AND status = 'active' AND verified_at IS NOT NULL", [i.connectionId, i.storeId]);
        if (c.rows[0] === undefined) throw new WatchError("unverified", "the connection must be active and verified");
      }
      const review = await tx.query<{ id: string }>("SELECT id FROM enforcement_actions WHERE finding_id = $1 AND human_review_required AND status = 'pending_review'", [i.findingId]);
      const status: AppealStatus = review.rows.length > 0 || i.connectionId === undefined ? "ops_queue" : "pending_rescore";
      const id = this.env.newId();
      const ins = await tx.query<{ id: string }>(
        "INSERT INTO price_appeals (id, finding_id, store_id, market_id, submitted_by, evidence_media_id, connection_id, claimed_reference_minor, status, idempotency_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (store_id, idempotency_key) DO NOTHING RETURNING id",
        [id, i.findingId, i.storeId, this.env.marketId, i.userId, i.evidenceMediaId ?? null, i.connectionId ?? null, i.claimedReferenceMinor?.toString() ?? null, status, i.idempotencyKey, this.env.now()]);
      if (ins.rows[0] === undefined) {
        const raced = await tx.query<{ id: string; status: AppealStatus; finding_id: string }>("SELECT id, status, finding_id FROM price_appeals WHERE idempotency_key = $1 AND store_id = $2", [i.idempotencyKey, i.storeId]);
        return { ...this.replay(raced.rows[0], i), fresh: false };
      }
      return { id, status, fresh: true };
    });
    // The seller role cannot write findings: the worker marks the finding as under appeal (idempotent).
    if (res.fresh) await asWatchWorker(this.env, (tx) => tx.query("UPDATE price_findings SET status = 'appealed' WHERE id = $1 AND status = 'open'", [i.findingId]));
    return { id: res.id, status: res.status };
  }

  private replay(prior: { id: string; status: AppealStatus; finding_id: string } | undefined, i: AppealInput): { id: string; status: AppealStatus } {
    if (prior?.finding_id !== i.findingId) throw new WatchError("invalid", "idempotency key was already used for a different appeal");
    return { id: prior.id, status: prior.status };
  }

  /**
   * Ops decision on a queued appeal (suspensions and document-only appeals; a human reviews within 5 business days, master 9.5). `upheld` lifts the finding and its
   * enforcement actions (a pending suspension is lifted); `rejected` re-opens the finding and confirms a pending suspension (it becomes active). Authorization of
   * `adminActor` (Ops / Trust & Safety, dual control where configured) is the caller's guard; the actor id is stored for the audit trail.
   */
  async processOpsDecision(adminActor: string, appealId: string, decision: "upheld" | "rejected"): Promise<{ status: AppealStatus }> {
    return asWatchWorker(this.env, async (tx) => {
      const a = await tx.query<{ id: string; finding_id: string; store_id: string }>("SELECT id, finding_id, store_id FROM price_appeals WHERE id = $1 AND status = 'ops_queue' AND market_id = $2 FOR UPDATE", [appealId, this.env.marketId]);
      const row = a.rows[0];
      if (row === undefined) throw new WatchError("not_found", "no queued appeal with that id");
      const now = this.env.now();
      if (decision === "upheld") {
        await tx.query("UPDATE price_findings SET status = 'upheld', resolved_at = $2 WHERE id = $1", [row.finding_id, now]);
        await tx.query("UPDATE enforcement_actions SET status = 'lifted', reviewed_by = $2, reviewed_at = $3 WHERE finding_id = $1 AND status IN ('active', 'pending_review')", [row.finding_id, adminActor, now]);
      } else {
        await tx.query("UPDATE price_findings SET status = 'open' WHERE id = $1 AND status = 'appealed'", [row.finding_id]);
        await tx.query("UPDATE enforcement_actions SET status = 'active', reviewed_by = $2, reviewed_at = $3 WHERE finding_id = $1 AND status = 'pending_review'", [row.finding_id, adminActor, now]);
      }
      await tx.query("UPDATE price_appeals SET status = $2, decided_by = $3, resolved_at = $4 WHERE id = $1", [row.id, decision, adminActor, now]);
      await emit(this.env, tx, "price_appeal.resolved", "price_appeal", row.id, { store_id: row.store_id, finding_id: row.finding_id, outcome: decision, decided_by_ops: true });
      return { status: decision };
    });
  }

  /** Worker: re-scores each pending appeal. The finding is upheld only when the fresh evidence no longer triggers its rule. */
  async processPending(limit = 25): Promise<{ upheld: number; rejected: number }> {
    const rows = await asWatchWorker(this.env, async (tx) =>
      (await tx.query<{ id: string; finding_id: string; store_id: string; sku_id: string | null; claimed: string | null }>(
        "SELECT a.id, a.finding_id, a.store_id, f.sku_id, a.claimed_reference_minor::text AS claimed FROM price_appeals a JOIN price_findings f ON f.id = a.finding_id WHERE a.status = 'pending_rescore' AND a.market_id = $1 ORDER BY a.created_at LIMIT $2", [this.env.marketId, limit])).rows);
    const out = { upheld: 0, rejected: 0 };
    for (const a of rows) {
      if (a.sku_id !== null) await this.scorer.scoreSku({ storeId: a.store_id, skuId: a.sku_id, ...(a.claimed === null ? {} : { claimedReferenceMinor: BigInt(a.claimed) }) });
      await asWatchWorker(this.env, async (tx) => {
        const f = await tx.query<{ status: string }>("SELECT status FROM price_findings WHERE id = $1", [a.finding_id]);
        const upheld = f.rows[0]?.status === "resolved";
        const now = this.env.now();
        if (upheld) await tx.query("UPDATE price_findings SET status = 'upheld', resolved_at = COALESCE(resolved_at, $2) WHERE id = $1", [a.finding_id, now]);
        else await tx.query("UPDATE price_findings SET status = 'open' WHERE id = $1 AND status = 'appealed'", [a.finding_id]);
        await tx.query("UPDATE price_appeals SET status = $2, resolved_at = $3 WHERE id = $1", [a.id, upheld ? "upheld" : "rejected", now]);
        await emit(this.env, tx, "price_appeal.resolved", "price_appeal", a.id, { store_id: a.store_id, finding_id: a.finding_id, outcome: upheld ? "upheld" : "rejected" });
        if (upheld) out.upheld++;
        else out.rejected++;
      });
    }
    return out;
  }
}
