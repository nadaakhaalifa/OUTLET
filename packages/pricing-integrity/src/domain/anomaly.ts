import { DAY_MS } from "./window.js";

export type AnomalyKind = "pre_drop_spike" | "ping_pong" | "duplicate_reset" | "image_reuse" | "sudden_discount";
export interface AnomalySignal {
  readonly kind: AnomalyKind;
  /** 0-100 severity input for review; the Price Trust Score counts each signal. */
  readonly score: number;
}
export interface PricePoint {
  readonly at: Date;
  readonly priceMinor: bigint;
}
/** delta is at least pct percent of base (integer maths, no division). */
const atLeastPct = (delta: bigint, base: bigint, pct: number): boolean => delta * 100n >= BigInt(pct) * base;
const sorted = (s: readonly PricePoint[]): PricePoint[] => [...s].sort((a, b) => a.at.getTime() - b.at.getTime());

/** Price raised by >= minRisePct within `lookbackDays` before `dropAt`, then cut to <= the pre-rise level (classic fake reference). */
export const detectPreDropSpike = (series: readonly PricePoint[], dropAt: Date, minRisePct = 10, lookbackDays = 30): AnomalySignal | null => {
  const s = sorted(series).filter((p) => p.at.getTime() <= dropAt.getTime());
  const from = dropAt.getTime() - lookbackDays * DAY_MS;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1];
    const b = s[i];
    const last = s[s.length - 1];
    if (a === undefined || b === undefined || last === undefined || b.at.getTime() < from) continue;
    if (atLeastPct(b.priceMinor - a.priceMinor, a.priceMinor, minRisePct) && last.priceMinor <= a.priceMinor) return { kind: "pre_drop_spike", score: 80 };
  }
  return null;
};

/** At least `minFlips` direction changes of >= minMovePct within `windowDays`. */
export const detectPingPong = (series: readonly PricePoint[], minFlips = 3, minMovePct = 5, windowDays = 14): AnomalySignal | null => {
  const s = sorted(series);
  const end = s[s.length - 1];
  if (end === undefined) return null;
  const w = s.filter((p) => p.at.getTime() >= end.at.getTime() - windowDays * DAY_MS);
  let flips = 0;
  let dir = 0;
  for (let i = 1; i < w.length; i++) {
    const a = w[i - 1];
    const b = w[i];
    if (a === undefined || b === undefined || b.priceMinor === a.priceMinor) continue;
    const move = atLeastPct(b.priceMinor > a.priceMinor ? b.priceMinor - a.priceMinor : a.priceMinor - b.priceMinor, a.priceMinor, minMovePct);
    if (!move) continue;
    const d = b.priceMinor > a.priceMinor ? 1 : -1;
    if (dir !== 0 && d !== dir) flips++;
    dir = d;
  }
  return flips >= minFlips ? { kind: "ping_pong", score: 60 } : null;
};

export const hamming = (a: Uint8Array, b: Uint8Array): number => {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = (a[i] ?? 0) ^ (b[i] ?? 0);
    while (x > 0) { d += x & 1; x >>= 1; }
  }
  return d;
};
export interface ListingFingerprint {
  readonly id: string;
  readonly storeId: string;
  readonly phash: Uint8Array;
  readonly brand: string;
  readonly color: string;
  readonly category: string;
  readonly active: boolean;
}
const sameAttrs = (a: ListingFingerprint, b: ListingFingerprint): boolean => a.brand === b.brand && a.color === b.color && a.category === b.category;

/** A new listing that matches an older INACTIVE listing of the same store (pHash within maxDist plus attributes) inherits its history. */
export const detectDuplicateReset = (listing: ListingFingerprint, others: readonly ListingFingerprint[], maxDist = 6): { signal: AnomalySignal; inheritsFrom: string } | null => {
  const hit = others.find((o) => o.id !== listing.id && o.storeId === listing.storeId && !o.active && hamming(o.phash, listing.phash) <= maxDist && sameAttrs(o, listing));
  return hit === undefined ? null : { signal: { kind: "duplicate_reset", score: 70 }, inheritsFrom: hit.id };
};

/** The same image on another store's listing (counterfeit signal); attributes are not required. */
export const detectImageReuse = (listing: ListingFingerprint, others: readonly ListingFingerprint[], maxDist = 4): AnomalySignal | null =>
  others.some((o) => o.storeId !== listing.storeId && hamming(o.phash, listing.phash) <= maxDist) ? { kind: "image_reuse", score: 75 } : null;

export interface MegaEvent {
  readonly startsAt: Date;
}
/** Discount of >= minPct that began within `daysBefore` days before a mega event on an SKU with sell-through under maxSellThroughPct. */
export const detectSuddenDiscount = (series: readonly PricePoint[], events: readonly MegaEvent[], sellThroughPct: number, minPct = 30, daysBefore = 14, maxSellThroughPct = 20): AnomalySignal | null => {
  const s = sorted(series);
  if (sellThroughPct >= maxSellThroughPct) return null;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1];
    const b = s[i];
    if (a === undefined || b === undefined || b.priceMinor >= a.priceMinor) continue;
    if (!atLeastPct(a.priceMinor - b.priceMinor, a.priceMinor, minPct)) continue;
    if (events.some((e) => e.startsAt.getTime() - b.at.getTime() >= 0 && e.startsAt.getTime() - b.at.getTime() <= daysBefore * DAY_MS)) return { kind: "sudden_discount", score: 65 };
  }
  return null;
};

export interface AnomalyInput {
  readonly series: readonly PricePoint[];
  readonly dropAt: Date;
  readonly listing?: ListingFingerprint;
  readonly sameStoreListings?: readonly ListingFingerprint[];
  readonly otherStoreListings?: readonly ListingFingerprint[];
  readonly megaEvents?: readonly MegaEvent[];
  readonly sellThroughPct?: number;
}
export const anomalySignals = (i: AnomalyInput): AnomalySignal[] => {
  const out: (AnomalySignal | null)[] = [detectPreDropSpike(i.series, i.dropAt), detectPingPong(i.series), detectSuddenDiscount(i.series, i.megaEvents ?? [], i.sellThroughPct ?? 100)];
  if (i.listing !== undefined) out.push(detectDuplicateReset(i.listing, i.sameStoreListings ?? [])?.signal ?? null, detectImageReuse(i.listing, i.otherStoreListings ?? []));
  return out.filter((x): x is AnomalySignal => x !== null);
};
