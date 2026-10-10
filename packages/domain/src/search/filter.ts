/**
 * Domain SearchFilter (spec 4). Money is bigint piastres. The wire shape and Zod schema live in the
 * API module; this file holds the pure rules: facet counting, canonical form, relaxation.
 */

export const MAX_FACETS = 30;
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_QUERY_LENGTH = 300;

export const WORLDS = ["local", "global", "everything", "my_stores"] as const;
export type World = (typeof WORLDS)[number];

export const CONDITIONS = ["new_with_tags", "new_without_tags", "sample", "minor_defect"] as const;
export type Condition = (typeof CONDITIONS)[number];

export interface SearchFilter {
  readonly budgetMax?: bigint;
  readonly fitsRemainingBudget?: boolean;
  readonly installmentsAvailable?: boolean;
  readonly monthlyMax?: bigint;
  readonly payableWithStoreCredit?: boolean;
  readonly codAvailable?: boolean;
  readonly mySizeOnly?: boolean;
  readonly world?: World;
  readonly storeIds?: readonly string[];
  readonly categoryIds?: readonly string[];
  readonly minVerifiedDiscountPct?: number;
  readonly priceMin?: bigint;
  readonly priceMax?: bigint;
  /** Canonical English colour ids (lexicon). */
  readonly colors?: readonly string[];
  readonly materials?: readonly string[];
  readonly conditions?: readonly Condition[];
  readonly freeDeliveryEligible?: boolean;
  readonly verifiedDiscountOnly?: boolean;
  readonly lowest30dOnly?: boolean;
  readonly newArrivals?: boolean;
  readonly minRating?: number;
}

export type FilterKey = keyof SearchFilter;

const ARRAY_KEYS = ["storeIds", "categoryIds", "colors", "materials", "conditions"] as const satisfies readonly FilterKey[];

export function isArrayKey(k: FilterKey): k is (typeof ARRAY_KEYS)[number] {
  return (ARRAY_KEYS as readonly string[]).includes(k);
}

function keysOf(f: SearchFilter): FilterKey[] {
  return (Object.keys(f) as FilterKey[]).filter((k) => f[k] !== undefined);
}

/** Facets = set scalar fields (1 each) + array elements (1 each). */
export function countFacets(f: SearchFilter): number {
  let n = 0;
  for (const k of keysOf(f)) {
    const v = f[k];
    n += Array.isArray(v) ? v.length : 1;
  }
  return n;
}

export const isEmptyFilter = (f: SearchFilter): boolean => keysOf(f).length === 0;

/** Sorted, deduplicated arrays and no undefined members: two equal filters compare equal. */
export function canonicalizeFilter(f: SearchFilter): SearchFilter {
  const out: Record<string, unknown> = {};
  for (const k of keysOf(f).sort()) {
    const v = f[k];
    out[k] = Array.isArray(v) ? [...new Set(v as readonly string[])].sort() : v;
  }
  return out as SearchFilter;
}

/** Least important first. Keys absent here are hard constraints and are never relaxed. */
export const RELAXATION_ORDER = [
  "newArrivals",
  "lowest30dOnly",
  "minRating",
  "materials",
  "colors",
  "freeDeliveryEligible",
  "conditions",
  "minVerifiedDiscountPct",
  "verifiedDiscountOnly",
  "installmentsAvailable",
  "monthlyMax",
  "codAvailable",
  "payableWithStoreCredit",
  "priceMin",
  "categoryIds",
] as const satisfies readonly FilterKey[];
export type RelaxableKey = (typeof RELAXATION_ORDER)[number];

export const MAX_RELAXATION_STEPS = 5;

export interface Relaxed {
  readonly filter: SearchFilter;
  readonly dropped: RelaxableKey;
}

/** Drops the single least important set filter; null when nothing relaxable remains. */
export function relaxOnce(f: SearchFilter): Relaxed | null {
  for (const key of RELAXATION_ORDER) {
    if (f[key] === undefined) continue;
    const rest: Record<string, unknown> = { ...f };
    delete rest[key];
    return { filter: rest as SearchFilter, dropped: key };
  }
  return null;
}
