/**
 * k-anonymity for seller-facing demographics and geography (spec 19.1: "aggregated with
 * k-anonymity >= 50"). The unit counted is the DISTINCT shopper, never events or orders: one
 * shopper placing 60 orders is still one shopper.
 *
 * The threshold is a constant, not a parameter: no caller can lower it.
 */
export const K_ANONYMITY_MIN = 50;

export interface KCell<V> {
  readonly key: string;
  /** Distinct shoppers in the cell. Used for the decision and NEVER released with a suppressed cell. */
  readonly distinctShoppers: number;
  readonly value: V;
  /** True when suppressed cells were folded into this released cell (see kAnonymizeAdditive). */
  readonly includesSuppressed?: boolean;
}

export interface KAnonymized<V> {
  /** Cells with at least K_ANONYMITY_MIN distinct shoppers, sorted by key. */
  readonly released: readonly KCell<V>[];
  /** How many cells were withheld. Their keys, sizes and values are not disclosed. */
  readonly suppressedCells: number;
}

export function kAnonymize<V>(cells: readonly KCell<V>[]): KAnonymized<V> {
  const released: KCell<V>[] = [];
  let suppressedCells = 0;
  for (const cell of cells) {
    if (!Number.isInteger(cell.distinctShoppers) || cell.distinctShoppers < 0) {
      throw new RangeError("distinctShoppers must be a non-negative integer");
    }
    if (cell.distinctShoppers >= K_ANONYMITY_MIN) released.push(cell);
    else suppressedCells += 1;
  }
  released.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { released, suppressedCells };
}

/** A single statistic that is released only when its population has at least K_ANONYMITY_MIN shoppers. */
export type KGated<T> = { readonly suppressed: false; readonly value: T } | { readonly suppressed: true };

export function gateByShoppers<T>(distinctShoppers: number, value: T): KGated<T> {
  return distinctShoppers >= K_ANONYMITY_MIN ? { suppressed: false, value } : { suppressed: true };
}

/**
 * Differencing-safe release for ADDITIVE cells whose total is also exposed elsewhere (traffic by
 * source, geography). Plain suppression leaks: total - sum(released) = the suppressed cells.
 *
 * Option chosen (b): every suppressed cell is merged (via `merge`) into the SMALLEST released cell
 * (ties: smallest key), so sum(released) === sum(all cells) and total - sum(released) = 0. No
 * separate "other" bucket is shown, because per-cell shopper counts cannot prove the union of
 * suppressed cells reaches k (shoppers may overlap across cells). The merged cell has >= k
 * distinct shoppers on its own, and carries `includesSuppressed: true`.
 *
 * If nothing is released there is no cell to subtract from; cells then stay suppressed and the
 * caller's totals describe the whole population, not a single isolated cell.
 */
export function kAnonymizeAdditive<V>(
  cells: readonly KCell<V>[],
  merge: (a: V, b: V) => V,
): KAnonymized<V> {
  const base = kAnonymize(cells);
  if (base.suppressedCells === 0 || base.released.length === 0) return base;
  const suppressed = cells
    .filter((c) => c.distinctShoppers < K_ANONYMITY_MIN)
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let target = base.released[0] as KCell<V>;
  for (const c of base.released) {
    if (c.distinctShoppers < target.distinctShoppers) target = c;
  }
  let value = target.value;
  let shoppers = target.distinctShoppers;
  for (const s of suppressed) {
    value = merge(value, s.value);
    shoppers += s.distinctShoppers;
  }
  const merged: KCell<V> = { key: target.key, distinctShoppers: shoppers, value, includesSuppressed: true };
  return {
    released: base.released.map((c) => (c === target ? merged : c)),
    suppressedCells: base.suppressedCells,
  };
}

/** Minimum window granularity: one UTC day. Ranges are snapped outward to day boundaries. */
export const MIN_WINDOW_MS = 86_400_000;
export function snapToDays(fromMs: number, toMs: number): { readonly fromMs: number; readonly toMs: number } {
  return {
    fromMs: Math.floor(fromMs / MIN_WINDOW_MS) * MIN_WINDOW_MS,
    toMs: Math.ceil(toMs / MIN_WINDOW_MS) * MIN_WINDOW_MS,
  };
}
