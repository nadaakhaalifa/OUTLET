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
    return asStore(this.env, i.storeId, i.userId, async (tx) => {
      const prior = await tx.query<{ id: string; status: AppealStatus }>("SELECT id, status FROM price_appeals WHERE idempotency_key = $1 AND store_id = $2", [i.idempotencyKey, i.storeId]);
      if (prior.rows[0] !== undefined) return prior.rows[0];
      const f = await tx.query<{ id: string }>("SELECT id FROM price_findings WHERE id = $1 AND store_id = $2 AND status IN ('open', 'appealed')", [i.findingId, i.storeId]);
      if (f.rows[0] === undefined) throw new WatchError("not_found", "finding not found");
      if (i.connectionId !== undefined) {
        const c = await tx.query<{ id: string }>("SELECT id FROM channel_connections WHERE id = $1 AND store_id = $2 AND status = 'active' AND verified_at IS NOT NULL", [i.connectionId, i.storeId]);
        if (c.rows[0] === undefined) throw new WatchError("unverified", "the connection must be active and verified");
      }
      const review = await tx.query<{ id: string }>("SELECT id FROM enforcement_actions WHERE finding_id = $1 AND human_review_required AND status = 'pending_review'", [i.findingId]);
      const status: AppealStatus = review.rows.length > 0 || i.connectionId === undefined ? "ops_queue" : "pending_rescore";
      const id = this.env.newId();
      await tx.query(
        "INSERT INTO price_appeals (id, finding_id, store_id, market_id, submitted_by, evidence_media_id, connection_id, claimed_reference_minor, status, idempotency_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        [id, i.findingId, i.storeId, this.env.marketId, i.userId, i.evidenceMediaId ?? null, i.connectionId ?? null, i.claimedReferenceMinor?.toString() ?? null, status, i.idempotencyKey, this.env.now()]);
      return { id, status };
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
        await tx.query("UPDATE price_appeals SET status = $2, resolved_at = $3 WHERE id = $1", [a.id, upheld ? "upheld" : "rejected", now]);
        await emit(this.env, tx, "price_appeal.resolved", "price_appeal", a.id, { store_id: a.store_id, finding_id: a.finding_id, outcome: upheld ? "upheld" : "rejected" });
        if (upheld) out.upheld++;
        else out.rejected++;
      });
    }
    return out;
  }
}
