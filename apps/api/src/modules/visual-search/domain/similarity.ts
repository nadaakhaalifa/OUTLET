import type { Neighbor, QueryAttributes, VisualCandidate } from "./ports";

export function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a));
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  const d = norm(a) * norm(b);
  return d === 0 ? 0 : dot(a, b) / d;
}

/** A usable query vector: finite numbers, non-zero, bounded dimension. */
export function validVector(v: readonly number[], dim: number): boolean {
  return v.length === dim && v.every((x) => Number.isFinite(x)) && norm(v) > 0;
}

export interface Ranked {
  readonly candidate: VisualCandidate;
  readonly similarity: number;
  readonly score: number;
}

const COLOUR_BONUS = 0.05;
const PATTERN_BONUS = 0.03;
/** Verified discount depth nudges ties only; it is bounded so it can never beat a visibly closer item. */
const DISCOUNT_BONUS_MAX = 0.02;

/**
 * Re-rank by attribute match (colour, pattern) and verified discount value (spec rule 5). The
 * attribute check also dampens adversarial embedding collisions: a colour or pattern clash costs the
 * bonus. A discount counts only when price integrity allowed the claim.
 */
export function rerank(neighbors: readonly Neighbor[], byId: ReadonlyMap<string, VisualCandidate>, query: QueryAttributes | undefined): Ranked[] {
  const out: Ranked[] = [];
  for (const n of neighbors) {
    const c = byId.get(n.productId);
    if (c === undefined) continue;
    let score = n.similarity;
    if (query?.colour !== undefined && c.colour !== null && c.colour === query.colour) score += COLOUR_BONUS;
    if (query?.pattern !== undefined && c.pattern !== null && c.pattern === query.pattern) score += PATTERN_BONUS;
    if (c.claimAllowed) score += (Math.min(70, Math.max(0, c.verifiedDiscountPct)) / 70) * DISCOUNT_BONUS_MAX;
    out.push({ candidate: c, similarity: n.similarity, score });
  }
  return out.sort((a, b) => b.score - a.score || (a.candidate.productId < b.candidate.productId ? -1 : a.candidate.productId > b.candidate.productId ? 1 : 0));
}

/** At most `maxConsecutive` items from one store in a row; skipped items follow when nothing else fits. */
export function diversify<T extends { readonly candidate: { readonly storeId: string } }>(items: readonly T[], maxConsecutive = 2): T[] {
  const out: T[] = [];
  const pending = [...items];
  while (pending.length > 0) {
    let idx = 0;
    const tail = out.slice(-maxConsecutive);
    if (tail.length === maxConsecutive && tail.every((t) => t.candidate.storeId === pending[0]?.candidate.storeId)) {
      const alt = pending.findIndex((p) => p.candidate.storeId !== tail[0]?.candidate.storeId);
      if (alt > 0) idx = alt;
    }
    const [next] = pending.splice(idx, 1);
    if (next !== undefined) out.push(next);
  }
  return out;
}
