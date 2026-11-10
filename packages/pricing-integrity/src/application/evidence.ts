import { toWire } from "@outlet/money";
import type { Currency, MoneyWire } from "@outlet/money";
import { money } from "@outlet/money";
import { displayDecision } from "../domain/display.js";
import type { BrandMode, PriceLabel, Viewer } from "../domain/display.js";
import { vrpFromInternal } from "../domain/vrp.js";
import { readLiveClaim } from "./claims.js";
import { isKilled, loadHistory, windowFor } from "./env.js";
import type { Env } from "./env.js";

/** Public proof summary. No actor ids, no event ids, no seller internals (P0 only). */
export interface PublicPriceEvidence {
  readonly skuId: string;
  readonly currentPrice: MoneyWire | null;
  readonly label: PriceLabel;
  readonly discountPct: number | null;
  readonly referencePrice: MoneyWire | null;
  readonly lowest30d: MoneyWire | null;
  readonly launchPrice: boolean;
  readonly history: readonly { price: MoneyWire; validFrom: string; validTo: string | null }[];
  readonly computedAt: string;
}

export class PriceEvidencePublic {
  constructor(private readonly env: Env) {}

  async get(skuId: string, opts: { brandMode?: BrandMode; viewer?: Viewer } = {}): Promise<PublicPriceEvidence | null> {
    const now = this.env.now();
    const h = await loadHistory(this.env.client, skuId, this.env.marketId, now);
    const w = windowFor(h, now);
    if (w.currentPrice === null || h.currency === undefined) return null;
    const cur = h.currency as Currency;
    const wire = (v: bigint): MoneyWire => toWire(money(v, cur));
    const base = { skuId, currentPrice: wire(w.currentPrice), computedAt: now.toISOString() };
    if (await isKilled(this.env)) {
      return { ...base, label: "plain", discountPct: null, referencePrice: null, lowest30d: null, launchPrice: false, history: [] };
    }
    const internal = vrpFromInternal(w, now);
    // A scored claim can only tighten the internal reference: no % when it says so or its evidence expired; an external-lowered VRP wins.
    const live = await readLiveClaim(this.env.client, skuId, this.env.marketId, now);
    const vrp = !live.exists || internal === null ? internal : !live.displayAllowed ? null : live.vrpMinor !== null && live.vrpMinor < internal ? live.vrpMinor : internal;
    const d = displayDecision({ vrp, price: w.currentPrice, launch: w.launchPrice, brandMode: opts.brandMode ?? "public", viewer: opts.viewer ?? "anonymous", isLowest30d: w.isLowest30d });
    return {
      ...base,
      label: d.label,
      discountPct: d.showPercent && d.pct !== undefined ? d.pct : null,
      referencePrice: d.showPercent && vrp !== null ? wire(vrp) : null,
      lowest30d: w.low30d === null ? null : wire(w.low30d),
      launchPrice: w.launchPrice,
      history: h.rows.map((r) => ({ price: wire(r.priceMinor), validFrom: r.validFrom.toISOString(), validTo: r.validTo === null ? null : r.validTo.toISOString() })),
    };
  }
}
