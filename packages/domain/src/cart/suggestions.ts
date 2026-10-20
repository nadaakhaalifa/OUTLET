import type { Money } from "../money";

export interface SuggestionCandidate {
  readonly skuId: string;
  readonly unitPrice: Money;
}

/**
 * Orders candidates to close a free-delivery gap with the fewest items: first those that
 * unlock on their own (cheapest first), then the rest by descending price. Stable on skuId.
 */
export function rankSuggestions<T extends SuggestionCandidate>(
  remaining: Money,
  candidates: readonly T[],
  limit: number,
): readonly T[] {
  if (remaining.amount <= 0n || limit <= 0) return [];
  const byPrice = (a: T, b: T, dir: 1 | -1): number =>
    a.unitPrice.amount === b.unitPrice.amount
      ? a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0
      : a.unitPrice.amount < b.unitPrice.amount ? -dir : dir;
  const unlocks = candidates.filter((c) => c.unitPrice.amount >= remaining.amount).sort((a, b) => byPrice(a, b, 1));
  const partial = candidates.filter((c) => c.unitPrice.amount < remaining.amount).sort((a, b) => byPrice(a, b, -1));
  return [...unlocks, ...partial].slice(0, limit);
}
