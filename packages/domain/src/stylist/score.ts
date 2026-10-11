import { embeddingSimilarity, pairCompat } from "./compat";
import type { Candidate, OutfitRequest } from "./types";

/** Score weights. Everything is an integer; a 0..1000 compat is worth up to 1000 points. */
export const SCORE = {
  /** Points per verified discount percent (verified only, spec 9). */
  discountPerPct: 5,
  /** One point per 20 EGP of price (2000 piastres). */
  piastresPerPenaltyPoint: 2000n,
  formalityMiss: 100,
  freeDeliveryBonus: 50,
} as const;

/** Affinity 0..1000: style vector cosine when available and personalization is on, else popularity/2. */
export function affinity(c: Candidate, styleVector: readonly number[] | null): number {
  if (styleVector !== null && c.embedding !== undefined) return embeddingSimilarity(styleVector, c.embedding);
  return Math.floor(c.popularity / 2);
}

export function unaryValue(c: Candidate, req: OutfitRequest): number {
  const penalty = Number(c.pricePiastres / SCORE.piastresPerPenaltyPoint);
  const fit = 200 - SCORE.formalityMiss * Math.abs(c.formality - req.occasionFormality);
  return affinity(c, req.styleVector) + c.verifiedDiscountPct * SCORE.discountPerPct - penalty + fit;
}

export function storeSubtotals(items: readonly Candidate[]): ReadonlyMap<string, bigint> {
  const m = new Map<string, bigint>();
  for (const i of items) m.set(i.storeId, (m.get(i.storeId) ?? 0n) + i.pricePiastres);
  return m;
}

export function freeDeliveryStores(items: readonly Candidate[], threshold: bigint): readonly string[] {
  return [...storeSubtotals(items)].filter(([, v]) => v >= threshold).map(([k]) => k).sort();
}

/** Exact objective of a complete or partial item set: unary + pairwise + same-store delivery bonus. */
export function scoreItems(items: readonly Candidate[], req: OutfitRequest): number {
  let s = 0;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a === undefined) continue;
    s += unaryValue(a, req);
    for (let j = 0; j < i; j++) {
      const b = items[j];
      if (b === undefined) continue;
      s += pairCompat(a, b, req.season) ?? 0;
    }
  }
  return s + SCORE.freeDeliveryBonus * freeDeliveryStores(items, req.freeDeliveryThresholdPiastres).length;
}
