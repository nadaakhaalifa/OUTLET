import { money } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { claimTypeOf } from "../domain/display.js";
import type { ClaimType } from "../domain/display.js";
import { vrpFromInternal } from "../domain/vrp.js";
import { readLiveClaim } from "./claims.js";
import { isKilled, loadHistory, windowFor } from "./env.js";
import type { Env } from "./env.js";

export interface PriceSnapshot {
  /** Verified reference price at the moment of the order line; null = no verified reference. */
  readonly vrp: Money | null;
  /** price_events ids that justify the reference (evidence trail for Consumer Protection Agency inquiries). */
  readonly evidenceIds: readonly string[];
  readonly claimType: ClaimType;
}

const PLAIN: PriceSnapshot = { vrp: null, evidenceIds: [], claimType: "plain" };

export class PriceSnapshotService {
  constructor(private readonly env: Env) {}

  /** Fails closed: kill switch engaged or unreadable, no history, or any doubt returns the plain snapshot. */
  async snapshotForOrderLine(skuId: string): Promise<PriceSnapshot> {
    if (await isKilled(this.env)) return PLAIN;
    const now = this.env.now();
    const h = await loadHistory(this.env.client, skuId, this.env.marketId, now);
    const w = windowFor(h, now);
    if (w.currentPrice === null || h.currency === undefined) return PLAIN;
    const internal = vrpFromInternal(w, now);
    const live = await readLiveClaim(this.env.client, skuId, this.env.marketId, now);
    const vrp = !live.exists || internal === null ? internal : !live.displayAllowed ? null : live.vrpMinor !== null && live.vrpMinor < internal ? live.vrpMinor : internal;
    const claimType = claimTypeOf({ vrp, price: w.currentPrice, launch: w.launchPrice, isLowest30d: w.isLowest30d });
    if (claimType !== "verified_discount" || vrp === null) return { ...PLAIN, claimType };
    const lowered = internal !== null && vrp < internal;
    return { vrp: money(vrp, h.currency as Currency), evidenceIds: lowered ? [...new Set([...w.referenceEvidenceIds, ...live.evidenceIds])] : w.referenceEvidenceIds, claimType };
  }
}
