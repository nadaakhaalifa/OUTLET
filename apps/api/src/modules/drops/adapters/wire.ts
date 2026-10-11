import { ladderPriceAt, type Drop, type SocialProof } from "../domain/bridge";
import { unitPrice } from "../application/purchase";

const iso = (ms: number): string => new Date(ms).toISOString();

const common = (d: Drop, nowMs: number) => ({
  id: d.id,
  store_id: d.storeId,
  type: d.type,
  state: d.state,
  paused: d.paused,
  title: d.title,
  starts_at: iso(d.startsAtMs),
  early_access_at: d.earlyAccessAtMs === null ? null : iso(d.earlyAccessAtMs),
  ends_at: iso(d.endsAtMs),
  limits: { per_user: d.limits.perUser, per_device: d.limits.perDevice },
  mystery:
    d.mystery === null
      ? null
      : {
          min_value: d.mystery.minValuePiastres.toString(),
          max_value: d.mystery.maxValuePiastres.toString(),
          guaranteed_min: d.mystery.guaranteedMinPiastres.toString(),
          currency: "EGP",
        },
  // The ladder is published before the start: it is shown in full, with server time for the ring.
  ladder: d.ladder.map((s) => ({
    at: iso(s.atMs),
    prices: d.items.map((i) => ({ sku_id: i.skuId, price: ladderPriceAt(d.ladder, i.pricePiastres, s.atMs).toString() })),
  })),
  server_time: iso(nowMs),
  currency: "EGP",
});

/** Public shape. No strike-through, no "% off": a drop price is a price, not a reference claim. */
export function publicDropWire(d: Drop, nowMs: number) {
  return {
    ...common(d, nowMs),
    items: d.items.map((i) => ({ sku_id: i.skuId, price: (unitPrice(d, i.skuId, nowMs) ?? i.pricePiastres).toString() })),
  };
}

export function publicDropDetailWire(d: Drop, social: SocialProof, waitlistSize: number, nowMs: number) {
  return {
    ...publicDropWire(d, nowMs),
    social_proof: {
      bought_24h: social.boughtToday,
      viewing_now: social.viewingNow,
      remaining: social.remaining,
    },
    waitlist_size: d.state === "SOLD_OUT" ? waitlistSize : null,
  };
}

export function sellerDropWire(d: Drop, nowMs: number) {
  return {
    ...common(d, nowMs),
    admit_per_sec: d.admitPerSec,
    version: d.version,
    items: d.items.map((i) => ({ sku_id: i.skuId, stock_cap: i.stockCap, price: i.pricePiastres.toString() })),
    created_at: iso(d.createdAtMs),
    updated_at: iso(d.updatedAtMs),
  };
}
