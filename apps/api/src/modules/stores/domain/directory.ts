import type { Sort, Store, World } from "./store";

export type SortKey = number | string | null;

export interface DirectoryItem {
  readonly store: Store;
  /** Position in the caller's favourites, for my_stores default ordering. */
  readonly favoritePosition: number | null;
}

/** `asc` sorts small first. Nulls always last. */
const SORT_SPEC: Record<Sort, { readonly dir: "asc" | "desc"; readonly key: (s: Store) => SortKey }> = {
  trending: { dir: "desc", key: (s) => s.stats.trendingScore },
  biggest_verified_discount: { dir: "desc", key: (s) => s.stats.maxVerifiedDiscountPct },
  new_drops: { dir: "desc", key: (s) => s.stats.lastDropAtMs },
  fastest_delivery: { dir: "asc", key: (s) => s.stats.p80DeliveryHours },
  name: { dir: "asc", key: (s) => s.nameAr },
};

/** Ordering mode used by the keyset: a Sort, or the user's own favourite order. */
export type Ordering = Sort | "favorite_position";

function keyOf(ordering: Ordering, item: DirectoryItem): SortKey {
  if (ordering === "favorite_position") return item.favoritePosition;
  return SORT_SPEC[ordering].key(item.store);
}

function dirOf(ordering: Ordering): "asc" | "desc" {
  return ordering === "favorite_position" ? "asc" : SORT_SPEC[ordering].dir;
}

function cmpValues(a: SortKey, b: SortKey, dir: "asc" | "desc"): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a === b) return 0;
  const raw = a < b ? -1 : 1;
  return dir === "asc" ? raw : -raw;
}

/** Total order: sort key (nulls last) then id ascending. */
export function compareItems(ordering: Ordering, a: DirectoryItem, b: DirectoryItem): number {
  const c = cmpValues(keyOf(ordering, a), keyOf(ordering, b), dirOf(ordering));
  if (c !== 0) return c;
  return a.store.id < b.store.id ? -1 : a.store.id > b.store.id ? 1 : 0;
}

export interface Position {
  readonly key: SortKey;
  readonly id: string;
}

export function positionOf(ordering: Ordering, item: DirectoryItem): Position {
  return { key: keyOf(ordering, item), id: item.store.id };
}

export function worldFilter(world: World, item: DirectoryItem): boolean {
  switch (world) {
    case "local":
      return item.store.kind === "local";
    case "global":
      return item.store.kind === "global";
    case "everything":
      return true;
    case "my_stores":
      return item.favoritePosition !== null;
  }
}

export interface Page {
  readonly items: readonly DirectoryItem[];
  readonly hasMore: boolean;
  readonly last: Position | null;
}

/** Keyset page over an unsorted candidate set: stable under inserts, never repeats or skips. */
export function pageOf(
  candidates: readonly DirectoryItem[],
  ordering: Ordering,
  after: Position | null,
  limit: number,
): Page {
  const sorted = [...candidates].sort((a, b) => compareItems(ordering, a, b));
  const start =
    after === null
      ? 0
      : sorted.findIndex((it) => {
          const c = cmpValues(keyOf(ordering, it), after.key, dirOf(ordering));
          return c > 0 || (c === 0 && it.store.id > after.id);
        });
  if (start === -1) return { items: [], hasMore: false, last: null };
  const items = sorted.slice(start, start + limit);
  const last = items.length > 0 ? positionOf(ordering, items[items.length - 1] as DirectoryItem) : null;
  return { items, hasMore: start + limit < sorted.length, last };
}

export interface WidenHint {
  readonly kind: "widen_world";
  readonly suggestedWorld: "everything";
}

/** My Stores with zero visible results suggests widening to everything (spec 3). */
export function widenHint(world: World, resultCount: number): WidenHint | null {
  return world === "my_stores" && resultCount === 0 ? { kind: "widen_world", suggestedWorld: "everything" } : null;
}
