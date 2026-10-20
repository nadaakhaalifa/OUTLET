/** Minimum cell size before a seller may see an aggregate (spec section 19.1, k-anonymity >= 50). */
export const K_ANONYMITY_MIN = 50;

export interface DemandCell {
  readonly productType: string;
  readonly sizeLabel: string;
  readonly week: string;
  readonly demandCount: number;
}

/** Drops every cell below k. The cut happens before any rows leave the module. */
export function suppressSmallCells<T extends { readonly demandCount: number }>(
  cells: readonly T[],
  k: number = K_ANONYMITY_MIN,
): T[] {
  return cells.filter((c) => Number.isInteger(c.demandCount) && c.demandCount >= k);
}
