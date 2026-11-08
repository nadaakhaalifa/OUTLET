import { TAU_BP } from "../domain/external.js";
import type { ExternalProductView, MatchCandidate, MatchStage } from "./ports.js";
import { asStore, asWatchWorker, WatchError } from "./watch-env.js";
import type { WatchEnv } from "./watch-env.js";

export type MatchOutcome = "auto" | "needs_confirmation" | "none" | "kept";

/** Seller-confirmed matches count as full-confidence evidence: confirming can only LOWER a VRP (external evidence never raises it). */
export const effectiveConfidenceBp = (status: string, confidenceBp: number): number => (status === "seller_confirmed" ? 10_000 : status === "auto" ? confidenceBp : 0);

export class MatchingService {
  constructor(private readonly env: WatchEnv, private readonly stages: readonly MatchStage[], private readonly tauBp = TAU_BP) {}

  /** Waterfall over the ports in order: the first candidate at or above tau becomes an AUTO match; otherwise the best sub-tau candidate awaits one-tap confirmation. */
  async matchProduct(externalProductId: string): Promise<MatchOutcome> {
    return asWatchWorker(this.env, async (tx) => {
      const r = await tx.query<{ id: string; store_id: string; title: string | null; gtin: string | null; image_phash: Uint8Array | null }>("SELECT id, store_id, title, gtin, image_phash FROM external_products WHERE id = $1", [externalProductId]);
      const p = r.rows[0];
      if (p === undefined) throw new WatchError("not_found", "external product not found");
      const view: ExternalProductView = { id: p.id, storeId: p.store_id, title: p.title, gtin: p.gtin, imagePhash: p.image_phash === null ? null : new Uint8Array(p.image_phash) };
      let best: (MatchCandidate & { stage: MatchStage }) | null = null;
      let winner: (MatchCandidate & { stage: MatchStage }) | null = null;
      for (const stage of this.stages) {
        const c: MatchCandidate | null = await stage.find(view).catch(() => null); // a failing stage never produces evidence
        if (c === null) continue;
        if (c.confidenceBp >= this.tauBp) {
          winner = { ...c, stage };
          break;
        }
        if (best === null || c.confidenceBp > best.confidenceBp) best = { ...c, stage };
      }
      const pick = winner ?? best;
      if (pick === null) return "none";
      const status = winner === null ? "needs_confirmation" : "auto";
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO product_matches (id, sku_id, store_id, market_id, external_product_id, method, confidence_bp, model_version, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (sku_id, external_product_id) DO UPDATE SET method = EXCLUDED.method, confidence_bp = EXCLUDED.confidence_bp, model_version = EXCLUDED.model_version, status = EXCLUDED.status
           WHERE product_matches.status = 'needs_confirmation' RETURNING id`,
        [this.env.newId(), pick.skuId, p.store_id, this.env.marketId, p.id, pick.stage.method, pick.confidenceBp, pick.stage.modelVersion, status],
      );
      return ins.rows.length === 0 ? "kept" : status;
    });
  }

  /** One-tap seller confirmation of an uncertain match. */
  async confirm(storeId: string, userId: string, matchId: string): Promise<void> {
    await this.decide(storeId, userId, matchId, "seller_confirmed");
  }
  /** A seller may reject only an UNCERTAIN match: rejecting a match at or above tau would let a seller hide a cheaper site (that is Ops-only). */
  async reject(storeId: string, userId: string, matchId: string): Promise<void> {
    await this.decide(storeId, userId, matchId, "rejected");
  }

  private async decide(storeId: string, userId: string, matchId: string, to: "seller_confirmed" | "rejected"): Promise<void> {
    await asStore(this.env, storeId, userId, async (tx) => {
      const r = await tx.query<{ status: string }>("SELECT status FROM product_matches WHERE id = $1 AND store_id = $2", [matchId, storeId]);
      const m = r.rows[0];
      if (m === undefined) throw new WatchError("not_found", "match not found");
      if (m.status !== "needs_confirmation") throw new WatchError("forbidden", "only an uncertain match can be confirmed or rejected by the seller");
      await tx.query("UPDATE product_matches SET status = $2, confirmed_by = $3, confirmed_at = $4 WHERE id = $1", [matchId, to, userId, this.env.now()]);
    });
  }
}
