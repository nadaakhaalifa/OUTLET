import type { Queryable } from "@outlet/db";
import { asStore, WatchError } from "./watch-env.js";
import type { WatchEnv } from "./watch-env.js";

export interface LiveClaim {
  /** An active claim row exists for the SKU. When false, callers fall back to the internal-history evidence (no external channel). */
  readonly exists: boolean;
  /** false when the claim says no % (including a claim whose evidence validity has passed). */
  readonly displayAllowed: boolean;
  readonly vrpMinor: bigint | null;
  /** true when `valid_until < now`: the evidence is older than 72 h and the claim is treated as plain until the sweeper re-scores it (A3). */
  readonly expired: boolean;
  /** price_events / channel_snapshots ids behind the claim (the evidence trail). */
  readonly evidenceIds: readonly string[];
}
const NONE: LiveClaim = { exists: false, displayAllowed: false, vrpMinor: null, expired: false, evidenceIds: [] };

/** Shopper read path: an expired claim is the plain price at once, without waiting for the sweeper (fail closed). */
export const readLiveClaim = async (q: Queryable, skuId: string, marketId: string, now: Date): Promise<LiveClaim> => {
  const r = await q.query<{ display_allowed: boolean; vrp_minor: string | null; valid_until: Date | string | null; evidence_ids: string[] }>(
    "SELECT display_allowed, vrp_minor::text, valid_until, evidence_ids FROM price_claims WHERE sku_id = $1 AND market_id = $2 AND status = 'active'", [skuId, marketId]);
  const c = r.rows[0];
  if (c === undefined) return NONE;
  const expired = c.valid_until !== null && new Date(c.valid_until).getTime() < now.getTime();
  return { exists: true, displayAllowed: c.display_allowed && !expired, vrpMinor: c.vrp_minor === null ? null : BigInt(c.vrp_minor), expired, evidenceIds: c.evidence_ids };
};

/** Seller Center: the "was" price the seller types in. Stored, never shown; the scorer compares it with the verified reference (A1). */
export class ClaimedReferenceService {
  constructor(private readonly env: WatchEnv) {}

  async set(storeId: string, userId: string, skuId: string, claimedMinor: bigint): Promise<void> {
    if (claimedMinor <= 0n) throw new WatchError("invalid", "claimed reference must be positive");
    await asStore(this.env, storeId, userId, async (tx) => {
      await tx.query(
        `INSERT INTO sku_claimed_reference (sku_id, store_id, market_id, claimed_minor, set_by, set_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sku_id, market_id) DO UPDATE SET claimed_minor = EXCLUDED.claimed_minor, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
        [skuId, storeId, this.env.marketId, claimedMinor.toString(), userId, this.env.now()]);
    });
  }

  async clear(storeId: string, userId: string, skuId: string): Promise<void> {
    await asStore(this.env, storeId, userId, async (tx) => {
      await tx.query("DELETE FROM sku_claimed_reference WHERE sku_id = $1 AND market_id = $2", [skuId, this.env.marketId]);
    });
  }
}
