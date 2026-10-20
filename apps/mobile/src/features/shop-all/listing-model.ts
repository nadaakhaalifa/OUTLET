/**
 * Pure screen model of Shop all (round-2 items 3 and 6): the route, the applied filters and the search text are one state, and every
 * filter control lives in the shared FilterSheet. No React, no UI imports.
 *
 * Budget is P3 financial-behaviour data (section 12): `fitsBudget` is never written to the route, to storage or to analytics.
 */
import { EMPTY_LISTING_FILTERS, badgeCount, parseRouteParams, toRouteParams, type ListingFilters, type ListingRouteParams } from "../filters/model";
import { MAX_FILTER_QUERY, type CategoryNode } from "./model";

/** Every route key the screen reads or writes (also used to clear stale keys with `setParams`). */
export const LISTING_ROUTE_KEYS = ["store", "stores", "category", "min", "max", "discount", "lowest", "condition", "department", "free", "new", "sort", "q"] as const;

export interface ListingState {
  readonly filters: ListingFilters;
  /** Applied search text, trimmed and at most 100 characters. */
  readonly q: string;
}

export const EMPTY_LISTING: ListingState = { filters: EMPTY_LISTING_FILTERS, q: "" };

const clean = (v: string | undefined): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

/** Legacy `stores=a,b` and `store=a` both feed one `store` list. Only known keys survive. */
export function normalizeRoute(p: ListingRouteParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of LISTING_ROUTE_KEYS) {
    const v = clean(p[k]);
    if (v !== undefined && k !== "stores") out[k] = v;
  }
  const stores = [clean(p["store"]), clean(p["stores"])].filter((x): x is string => x !== undefined).join(",");
  if (stores.length > 0) out["store"] = stores;
  return out;
}

/** True when the route carries any filter or query (a plain /shop-all falls back to the saved store selection). */
export function hasListingParams(p: ListingRouteParams): boolean {
  return Object.keys(normalizeRoute(p)).length > 0;
}

/** Bad parts are ignored, never thrown. */
export function parseListing(p: ListingRouteParams, tree: readonly CategoryNode[] = []): ListingState {
  const n = normalizeRoute(p);
  return { filters: parseRouteParams(n, tree), q: (n["q"] ?? "").slice(0, MAX_FILTER_QUERY) };
}

/** The route of a state: filters plus `q`. `fitsBudget` is deliberately absent. */
export function listingToParams(s: ListingState): Record<string, string> {
  const p = toRouteParams(s.filters);
  const q = s.q.trim().slice(0, MAX_FILTER_QUERY);
  if (q.length > 0) p["q"] = q;
  return p;
}

/** Params for `router.setParams`: every known key, `undefined` for the ones to clear. */
export function paramsPatch(s: ListingState): Record<string, string | undefined> {
  const next = listingToParams(s);
  const patch: Record<string, string | undefined> = {};
  for (const k of LISTING_ROUTE_KEYS) patch[k] = next[k];
  return patch;
}

/** Two states are the same listing when they serialise to the same route (so a route we wrote ourselves is not re-hydrated). */
export function routeKeyOf(p: ListingRouteParams, tree: readonly CategoryNode[] = []): string {
  return JSON.stringify(sortedEntries(listingToParams(parseListing(p, tree))));
}
export function sameListing(a: ListingState, b: ListingState): boolean {
  return JSON.stringify(sortedEntries(listingToParams(a))) === JSON.stringify(sortedEntries(listingToParams(b)));
}
function sortedEntries(o: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(o).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
}

/** Badge on the one filter icon. The search text is visible in its own field and is not counted. */
export function listingBadge(s: ListingState): number {
  return badgeCount(s.filters);
}

/** Request identity: changes exactly when a new search must run. The remaining budget (device-held) only matters while `fitsBudget` is on. */
export function requestKey(s: ListingState, remainingBudget: bigint | null): string {
  const base = JSON.stringify(sortedEntries(listingToParams(s)));
  return s.filters.fitsBudget ? `${base}|fits:${remainingBudget === null ? "none" : remainingBudget.toString()}` : base;
}

export type ListingEmptyAction = "resetFilters" | "clearQuery";

/** What the empty state offers: undo the filters, undo the search text. Nothing when neither is set. */
export function emptyActions(s: ListingState): readonly ListingEmptyAction[] {
  const out: ListingEmptyAction[] = [];
  if (listingBadge(s) > 0) out.push("resetFilters");
  if (s.q.trim().length > 0) out.push("clearQuery");
  return out;
}

/** Reset clears the filters and keeps the search text (the text has its own clear button). */
export function resetFilters(s: ListingState): ListingState {
  return { filters: EMPTY_LISTING_FILTERS, q: s.q };
}

/** The saved per-device store selection changes only when the shopper's own action changed the stores. */
export function storesChanged(before: ListingFilters, after: ListingFilters): boolean {
  return before.storeIds.length !== after.storeIds.length || before.storeIds.some((id, i) => after.storeIds[i] !== id);
}
