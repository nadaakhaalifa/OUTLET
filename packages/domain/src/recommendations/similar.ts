import type { Candidate } from "./types";

export interface Neighbor {
  readonly productId: string;
  readonly score: number;
}

/** Cosine similarity. Zero vectors give 0. Mismatched dimensions are a programming error. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new RangeError(`dimension mismatch ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Items a shopper may see: active store, in stock, in the shopper's size when sizes are known. */
export function isVisible(c: Candidate, userSizes: readonly string[] | null): boolean {
  if (!c.storeActive || !c.inStock) return false;
  if (userSizes === null || userSizes.length === 0 || c.sizesInStock.length === 0) return true;
  return c.sizesInStock.some((s) => userSizes.includes(s));
}

/**
 * "Similar for less": strictly cheaper than the anchor AND a verified claim (price integrity
 * `claim_allowed`). A cheaper item without a verified claim is never shown in this module.
 */
export function isSimilarForLess(anchorPriceMinor: bigint, c: Candidate): boolean {
  return c.priceMinor < anchorPriceMinor && c.claimAllowed;
}

export interface RestockPurchase {
  readonly productId: string;
  readonly boughtAtMs: number;
  readonly returned: boolean;
}

/** Basics bought and kept whose replenishment interval has elapsed. One reminder per product. */
export function restockDue(
  purchases: readonly RestockPurchase[],
  intervalDaysByProduct: ReadonlyMap<string, number>,
  nowMs: number,
): string[] {
  const latest = new Map<string, RestockPurchase>();
  for (const p of purchases) {
    const cur = latest.get(p.productId);
    if (cur === undefined || p.boughtAtMs > cur.boughtAtMs) latest.set(p.productId, p);
  }
  const out: string[] = [];
  for (const [id, p] of latest) {
    const days = intervalDaysByProduct.get(id);
    if (days === undefined || p.returned) continue;
    if (nowMs - p.boughtAtMs >= days * 86_400_000) out.push(id);
  }
  return out.sort();
}

export interface PriceDrop {
  readonly productId: string;
  readonly seenMinor: bigint;
  readonly nowMinor: bigint;
  readonly dropMinor: bigint;
  /** floor integer percent of the price the shopper saw. Not a "% off" claim (spec 9). */
  readonly dropPct: number;
}

export function priceDrops(
  seen: readonly { productId: string; priceMinor: bigint | null }[],
  current: ReadonlyMap<string, bigint>,
): PriceDrop[] {
  const out: PriceDrop[] = [];
  for (const s of seen) {
    const now = current.get(s.productId);
    if (s.priceMinor === null || now === undefined || s.priceMinor <= 0n || now >= s.priceMinor) continue;
    const drop = s.priceMinor - now;
    out.push({
      productId: s.productId,
      seenMinor: s.priceMinor,
      nowMinor: now,
      dropMinor: drop,
      dropPct: Number((drop * 100n) / s.priceMinor),
    });
  }
  return out;
}
