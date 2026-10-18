/**
 * Shared listing-filter model (round-2 item 6). Pure: no React, no UI imports.
 * One state shape for Shop all, Home product filters, Search results and Saved; a draft lives in the sheet and is applied explicitly.
 *
 * Budget is P3 financial-behaviour data (section 12): `fitsBudget` is a request-time flag only. It is never written to a route,
 * to storage, to analytics or to ranking, and logged-out shoppers get no Budget section at all.
 */
import { CONDITIONS, EMPTY_FILTER, isShopDepartment, type Condition, type FacetCounts, type SearchFilter, type ShopDepartment } from "../search/model";
import { filterToWire } from "../search/api";
import type { StoreSummary } from "../worlds/model";
import {
  DISCOUNT_STEPS, SHOP_SORTS, descendantIds, foldSearchText, hasBudget, parseEgpToPiastres, piastresToField, resolveCategoryParam,
  type CategoryNode, type DiscountStep, type ShopSort,
} from "../shop-all/model";

export { DISCOUNT_STEPS, SHOP_SORTS };
export type { DiscountStep, ShopSort };

/** API4: at most 30 values per facet list. */
export const MAX_FACET_VALUES = 30;
export const COUNT_DEBOUNCE_MS = 250;
/** Selected + searchable rows shown in the Brand section. */
export const MAX_BRAND_ROWS = 30;

export type ListingFlag = "lowest30d" | "freeDelivery" | "newArrivals";

export interface ListingFilters {
  /** Stores shown as "Brand" until product brands exist on the wire. Unique, at most 30, pick order. */
  readonly storeIds: readonly string[];
  /** Categories as picked (not expanded). Unique, at most 30. */
  readonly categoryIds: readonly string[];
  /** Integer piastres. */
  readonly priceMin: bigint | null;
  readonly priceMax: bigint | null;
  /** Request-time "fits my remaining budget" flag. Never persisted or placed in a route. */
  readonly fitsBudget: boolean;
  readonly minDiscountPct: DiscountStep | null;
  readonly lowest30d: boolean;
  readonly conditions: readonly Condition[];
  readonly department: ShopDepartment | null;
  readonly freeDelivery: boolean;
  readonly newArrivals: boolean;
  readonly sort: ShopSort;
}

export const EMPTY_LISTING_FILTERS: ListingFilters = {
  storeIds: [], categoryIds: [], priceMin: null, priceMax: null, fitsBudget: false, minDiscountPct: null, lowest30d: false,
  conditions: [], department: null, freeDelivery: false, newArrivals: false, sort: "relevance",
};

export type ListingAction =
  | { readonly type: "toggleStore"; readonly id: string }
  | { readonly type: "toggleCategory"; readonly id: string }
  | { readonly type: "setPrice"; readonly min: bigint | null; readonly max: bigint | null }
  | { readonly type: "setFitsBudget"; readonly value: boolean }
  | { readonly type: "setMinDiscount"; readonly pct: DiscountStep | null }
  | { readonly type: "toggleFlag"; readonly flag: ListingFlag }
  | { readonly type: "toggleCondition"; readonly condition: Condition }
  | { readonly type: "setDepartment"; readonly department: ShopDepartment | null }
  | { readonly type: "setSort"; readonly sort: ShopSort }
  | { readonly type: "removeChip"; readonly chip: AppliedChip }
  | { readonly type: "reset" }
  | { readonly type: "replace"; readonly filters: ListingFilters };

function toggled(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * Server cap (API4, packages/domain search/filter.ts): the TOTAL of set scalar fields (1 each) plus array elements, across all facets, is at most 30.
 * Counted over the real wire filter (single source of truth: `filterToWire`). Categories are counted as picked (unexpanded), the `world`
 * scalar is always reserved, and `fitsBudget` reserves the budget ceiling, so a state that passes here also passes the server.
 */
export function countWireFacets(w: ReturnType<typeof filterToWire>): number {
  let n = 0;
  for (const v of Object.values(w)) {
    if (v === undefined) continue;
    n += Array.isArray(v) ? v.length : 1;
  }
  return n;
}

export function facetTotal(f: ListingFilters): number {
  return countWireFacets(filterToWire(toSearchFilter(f, [], { world: "everything", remainingBudget: f.fitsBudget ? 1n : null })));
}

/** True when the draft is at the total facet cap: the next pick of ANY facet (store, category, condition, flag...) would be refused. */
export function atFacetCap(f: ListingFilters, _facet?: "store" | "category"): boolean {
  return facetTotal(f) >= MAX_FACET_VALUES;
}

/** Keeps min <= max: an inverted pair is rejected (state unchanged). Negative bounds are rejected. */
function validPrice(min: bigint | null, max: bigint | null): boolean {
  return (min === null || min >= 0n) && (max === null || max >= 0n) && (min === null || max === null || min <= max);
}

/** Applies the action, then refuses it (returns the old state) if it would ADD facets beyond the 30 total. Removals always succeed. */
export function listingReducer(s: ListingFilters, a: ListingAction): ListingFilters {
  const next = step(s, a);
  if (a.type === "replace" || a.type === "reset" || a.type === "removeChip") return next;
  return facetTotal(next) > MAX_FACET_VALUES && facetTotal(next) > facetTotal(s) ? s : next;
}

function step(s: ListingFilters, a: ListingAction): ListingFilters {
  switch (a.type) {
    case "toggleStore": return { ...s, storeIds: toggled(s.storeIds, a.id) };
    case "toggleCategory": return { ...s, categoryIds: toggled(s.categoryIds, a.id) };
    case "setPrice": return validPrice(a.min, a.max) ? { ...s, priceMin: a.min, priceMax: a.max } : s;
    case "setFitsBudget": return { ...s, fitsBudget: a.value };
    case "setMinDiscount": return { ...s, minDiscountPct: a.pct !== null && (DISCOUNT_STEPS as readonly number[]).includes(a.pct) ? a.pct : null };
    case "toggleFlag": return { ...s, [a.flag]: !s[a.flag] };
    case "toggleCondition":
      return { ...s, conditions: s.conditions.includes(a.condition) ? s.conditions.filter((c) => c !== a.condition) : CONDITIONS.filter((c) => c === a.condition || s.conditions.includes(c)) };
    // "unisex" is the catalogue's internal value, never a shopper choice.
    case "setDepartment": return { ...s, department: a.department === "unisex" ? null : a.department };
    case "setSort": return { ...s, sort: (SHOP_SORTS as readonly string[]).includes(a.sort) ? a.sort : "relevance" };
    case "removeChip": return removeChip(s, a.chip);
    case "reset": return EMPTY_LISTING_FILTERS;
    case "replace": return normalize(a.filters);
  }
}

/** Defensive copy: dedupes and caps lists, drops invalid values. Idempotent. */
export function normalize(f: ListingFilters): ListingFilters {
  let out: ListingFilters = {
    ...f,
    storeIds: [...new Set(f.storeIds)].slice(0, MAX_FACET_VALUES),
    categoryIds: [...new Set(f.categoryIds)].slice(0, MAX_FACET_VALUES),
    ...(validPrice(f.priceMin, f.priceMax) ? {} : { priceMin: null, priceMax: null }),
    department: f.department === "unisex" ? null : f.department,
    conditions: CONDITIONS.filter((c) => f.conditions.includes(c)),
  };
  // Over the total cap (a hostile route or old saved state): drop from the end, categories first, then stores.
  while (facetTotal(out) > MAX_FACET_VALUES) {
    if (out.categoryIds.length > 0) out = { ...out, categoryIds: out.categoryIds.slice(0, -1) };
    else if (out.storeIds.length > 0) out = { ...out, storeIds: out.storeIds.slice(0, -1) };
    else break;
  }
  return out;
}

/* ---- applied chips ---- */

export type AppliedChip =
  | { readonly key: "store"; readonly id: string }
  | { readonly key: "category"; readonly id: string }
  | { readonly key: "price" }
  | { readonly key: "fitsBudget" }
  | { readonly key: "discount"; readonly pct: DiscountStep }
  | { readonly key: "lowest30d" }
  | { readonly key: "condition"; readonly condition: Condition }
  | { readonly key: "department"; readonly department: ShopDepartment }
  | { readonly key: "freeDelivery" }
  | { readonly key: "newArrivals" }
  | { readonly key: "sort"; readonly sort: ShopSort };

/** Every applied filter in display order (sort is a chip only when it is not the default). Chips map 1:1 to the applied state. */
export function appliedChips(f: ListingFilters, opts: { readonly fitsBudgetActive?: boolean } = {}): readonly AppliedChip[] {
  const out: AppliedChip[] = [];
  if (f.sort !== "relevance") out.push({ key: "sort", sort: f.sort });
  f.storeIds.forEach((id) => out.push({ key: "store", id }));
  f.categoryIds.forEach((id) => out.push({ key: "category", id }));
  if (hasPrice(f)) out.push({ key: "price" });
  // Screens pass fitsBudgetActive=false when there is no positive remaining budget: the ceiling is then not sent, so no chip claims it.
  if (f.fitsBudget && opts.fitsBudgetActive !== false) out.push({ key: "fitsBudget" });
  if (f.minDiscountPct !== null) out.push({ key: "discount", pct: f.minDiscountPct });
  if (f.lowest30d) out.push({ key: "lowest30d" });
  f.conditions.forEach((condition) => out.push({ key: "condition", condition }));
  if (f.department !== null) out.push({ key: "department", department: f.department });
  if (f.freeDelivery) out.push({ key: "freeDelivery" });
  if (f.newArrivals) out.push({ key: "newArrivals" });
  return out;
}

export function removeChip(f: ListingFilters, c: AppliedChip): ListingFilters {
  switch (c.key) {
    case "store": return { ...f, storeIds: f.storeIds.filter((x) => x !== c.id) };
    case "category": return { ...f, categoryIds: f.categoryIds.filter((x) => x !== c.id) };
    case "price": return { ...f, priceMin: null, priceMax: null };
    case "fitsBudget": return { ...f, fitsBudget: false };
    case "discount": return { ...f, minDiscountPct: null };
    case "lowest30d": return { ...f, lowest30d: false };
    case "condition": return { ...f, conditions: f.conditions.filter((x) => x !== c.condition) };
    case "department": return { ...f, department: null };
    case "freeDelivery": return { ...f, freeDelivery: false };
    case "newArrivals": return { ...f, newArrivals: false };
    case "sort": return { ...f, sort: "relevance" };
  }
}

function hasPrice(f: ListingFilters): boolean {
  return hasBudget({ min: f.priceMin, max: f.priceMax });
}

/** Analytics filter_key for a chip (code field, no values). */
export function chipFilterKey(c: AppliedChip): string {
  switch (c.key) {
    case "fitsBudget": return "fits_budget";
    case "lowest30d": return "lowest_30d";
    case "freeDelivery": return "free_delivery";
    case "newArrivals": return "new_arrivals";
    default: return c.key;
  }
}

/** Number on the filter icon badge: every applied chip except sort (sort is not a filter). */
export function badgeCount(f: ListingFilters, opts: { readonly fitsBudgetActive?: boolean } = {}): number {
  return appliedChips(f, opts).filter((c) => c.key !== "sort").length;
}

export function isEmptyListing(f: ListingFilters): boolean {
  return appliedChips(f).length === 0;
}

/* ---- wire mapping ---- */

const WIRE_SORT: Readonly<Record<ShopSort, SearchFilter["sort"]>> = { relevance: undefined, priceLow: "priceLow", priceHigh: "priceHigh", discount: "discount" };

/**
 * ListingFilters to the existing SearchFilter. Stores AND categories (expanded to subtrees) AND price AND flags.
 * `fitsBudget` is applied by the caller as a request-time price ceiling (`budgetMax`), because the remaining budget is device-held data.
 */
export function toSearchFilter(f: ListingFilters, tree: readonly CategoryNode[], opts: { readonly remainingBudget?: bigint | null; readonly world?: SearchFilter["world"] } = {}): SearchFilter {
  const sort = WIRE_SORT[f.sort];
  const budgetMax = f.fitsBudget && opts.remainingBudget !== undefined && opts.remainingBudget !== null && opts.remainingBudget > 0n ? opts.remainingBudget : null;
  const build = (cats: readonly string[]): SearchFilter => ({
    ...EMPTY_FILTER,
    ...(opts.world !== undefined ? { world: opts.world } : {}),
    ...(budgetMax !== null ? { budgetMax } : {}),
    ...(f.storeIds.length > 0 ? { storeIds: f.storeIds } : {}),
    ...(cats.length > 0 ? { categoryIds: cats } : {}),
    ...(f.priceMin !== null ? { priceMin: f.priceMin } : {}),
    ...(f.priceMax !== null ? { priceMax: f.priceMax } : {}),
    ...(f.department !== null ? { department: f.department } : {}),
    ...(f.minDiscountPct !== null ? { minVerifiedDiscountPct: f.minDiscountPct } : {}),
    ...(f.lowest30d ? { lowest30dOnly: true } : {}),
    ...(f.freeDelivery ? { freeDeliveryEligible: true } : {}),
    ...(f.newArrivals ? { newArrivals: true } : {}),
    ...(f.conditions.length > 0 ? { conditions: f.conditions } : {}),
    ...(sort !== undefined ? { sort } : {}),
  });
  const picked = build(f.categoryIds);
  const expanded = expandedCategories(f, tree);
  if (expanded.length === f.categoryIds.length) return picked;
  const withSubtree = build(expanded);
  return countWireFacets(filterToWire(withSubtree)) <= MAX_FACET_VALUES ? withSubtree : picked;
}

function expandedCategories(f: ListingFilters, tree: readonly CategoryNode[]): readonly string[] {
  const out = new Set<string>();
  for (const id of f.categoryIds) for (const d of descendantIds(tree, id)) out.add(d);
  return [...out];
}

/**
 * True when the sent category filter includes the picked categories' subcategories. False when it would exceed the 30-facet cap, in which
 * case only the picked categories are sent and the UI says so (never a silent truncation).
 */
export function categoriesIncludeSubtree(f: ListingFilters, tree: readonly CategoryNode[], opts: { readonly remainingBudget?: bigint | null; readonly world?: SearchFilter["world"] } = {}): boolean {
  if (f.categoryIds.length === 0) return true;
  const sent = toSearchFilter(f, tree, opts).categoryIds ?? [];
  return sent.length === expandedCategories(f, tree).length;
}

/** The session decides whether the budget switch can mean anything: logged out or without a budget it is always off. */
export function sanitizeForSession(f: ListingFilters, session: { readonly signedIn: boolean; readonly budgetReady: boolean }): ListingFilters {
  return session.signedIn && session.budgetReady || !f.fitsBudget ? f : { ...f, fitsBudget: false };
}

/* ---- route params round-trip (strings only; fitsBudget is deliberately never serialised) ---- */

export type ListingRouteParams = Readonly<Record<string, string | undefined>>;

export function toRouteParams(f: ListingFilters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.storeIds.length > 0) p["store"] = f.storeIds.join(",");
  if (f.categoryIds.length > 0) p["category"] = f.categoryIds.join(",");
  if (f.priceMin !== null) p["min"] = piastresToField(f.priceMin);
  if (f.priceMax !== null) p["max"] = piastresToField(f.priceMax);
  if (f.minDiscountPct !== null) p["discount"] = String(f.minDiscountPct);
  if (f.lowest30d) p["lowest"] = "1";
  if (f.conditions.length > 0) p["condition"] = f.conditions.join(",");
  if (f.department !== null) p["department"] = f.department;
  if (f.freeDelivery) p["free"] = "1";
  if (f.newArrivals) p["new"] = "1";
  if (f.sort !== "relevance") p["sort"] = f.sort;
  return p;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Invalid parts are ignored, never thrown. Category params accept ids or slugs (resolved against the tree when it is loaded). */
export const MAX_ROUTE_PARAM_LENGTH = 4096;

/** Array-valued (repeated) params, non-strings and unknown keys are ignored. Each string is cut to 4 KB before it is split. */
export function parseRouteParams(p: ListingRouteParams, tree: readonly CategoryNode[] = []): ListingFilters {
  const list = (raw: string | undefined): string[] => (typeof raw === "string" ? raw.slice(0, MAX_ROUTE_PARAM_LENGTH).split(",").map((x) => x.trim()).filter((x) => x.length > 0) : []);
  const storeIds = [...new Set(list(p["store"]).filter((x) => ID_RE.test(x)))].slice(0, MAX_FACET_VALUES);
  const categoryIds = [...new Set(list(p["category"]).map((c) => (tree.length > 0 ? resolveCategoryParam(tree, c) : ID_RE.test(c) ? c : null)).filter((c): c is string => c !== null))].slice(0, MAX_FACET_VALUES);
  const min = typeof p["min"] === "string" ? parseEgpToPiastres(p["min"]) : null;
  const max = typeof p["max"] === "string" ? parseEgpToPiastres(p["max"]) : null;
  const disc = Number(p["discount"]);
  const dept = p["department"];
  const sort = p["sort"];
  return normalize({
    ...EMPTY_LISTING_FILTERS,
    storeIds, categoryIds, priceMin: min, priceMax: max,
    minDiscountPct: (DISCOUNT_STEPS as readonly number[]).includes(disc) ? (disc as DiscountStep) : null,
    lowest30d: p["lowest"] === "1",
    conditions: list(p["condition"]).filter((c): c is Condition => (CONDITIONS as readonly string[]).includes(c)),
    department: isShopDepartment(dept) && dept !== "unisex" ? dept : null,
    freeDelivery: p["free"] === "1",
    newArrivals: p["new"] === "1",
    sort: (SHOP_SORTS as readonly string[]).includes(sort ?? "") ? (sort as ShopSort) : "relevance",
  });
}

/* ---- sections ---- */

export type FilterSectionId = "sort" | "world" | "brand" | "price" | "budget" | "categories" | "discount" | "more";

export interface SectionContext {
  readonly signedIn: boolean;
  /** Monthly budget set and the `budget_insights` consent granted. */
  readonly budgetReady: boolean;
  readonly storeCount: number;
  readonly categoryCount: number;
  /** Show the native "world" section (Local / Global / All / My stores). The world is screen state, not part of ListingFilters. */
  readonly world?: boolean;
  /** Visible-section allow-list (canonical order is kept). Default: every section the data supports. */
  readonly only?: readonly FilterSectionId[];
  /** Saved-only: hide sections that make no sense for a wishlist. */
  readonly surface?: "shop_all" | "home" | "search" | "saved" | "discover";
}

export interface SectionView {
  readonly id: FilterSectionId;
  /** "setup" = Budget row that links to /budget instead of a switch. */
  readonly mode: "normal" | "setup";
}

/** Sections in spec order. Only what the data supports is listed; Budget is absent when logged out. */
export function visibleSections(ctx: SectionContext): readonly SectionView[] {
  const out: SectionView[] = [{ id: "sort", mode: "normal" }];
  if (ctx.world === true) out.push({ id: "world", mode: "normal" });
  if (ctx.storeCount > 0) out.push({ id: "brand", mode: "normal" });
  out.push({ id: "price", mode: "normal" });
  if (ctx.signedIn) out.push({ id: "budget", mode: ctx.budgetReady ? "normal" : "setup" });
  if (ctx.categoryCount > 0) out.push({ id: "categories", mode: "normal" });
  out.push({ id: "discount", mode: "normal" }, { id: "more", mode: "normal" });
  const only = ctx.only;
  return only === undefined ? out : out.filter((x) => only.includes(x.id));
}

/** Selected count for a section header ("Brand, 2 selected"); null when nothing is selected there. */
export function sectionSelectedCount(f: ListingFilters, id: FilterSectionId): number | null {
  const n = ((): number => {
    switch (id) {
      case "sort": return f.sort !== "relevance" ? 1 : 0;
      case "world": return 0;
      case "brand": return f.storeIds.length;
      case "price": return hasPrice(f) ? 1 : 0;
      case "budget": return f.fitsBudget ? 1 : 0;
      case "categories": return f.categoryIds.length;
      case "discount": return (f.minDiscountPct !== null ? 1 : 0) + (f.lowest30d ? 1 : 0);
      case "more": return f.conditions.length + (f.department !== null ? 1 : 0) + (f.freeDelivery ? 1 : 0) + (f.newArrivals ? 1 : 0);
    }
  })();
  return n > 0 ? n : null;
}

/* ---- Brand (stores) rows ---- */

export interface BrandRow {
  readonly id: string;
  readonly name: string;
  readonly selected: boolean;
  /** Selected but suspended or not in the loaded list: shown (as "unavailable") so the shopper can clear it. */
  readonly unavailable?: true;
  /** From the server `facet_counts.store_ids` only; undefined = show no number. */
  readonly count?: number;
}

const foldedNames = new WeakMap<readonly StoreSummary[], ReadonlyMap<string, string>>();
function foldedFor(stores: readonly StoreSummary[]): ReadonlyMap<string, string> {
  let m = foldedNames.get(stores);
  if (m === undefined) { m = new Map(stores.map((s) => [s.id, foldSearchText(s.name)] as const)); foldedNames.set(stores, m); }
  return m;
}

/**
 * Selected stores pinned on top (pick order), then the rest in server order, filtered by `query`; at most `max` rows.
 * A selected store that is suspended or missing from the loaded list is still pinned (flagged `unavailable`) so it can be cleared.
 */
export function brandRows(stores: readonly StoreSummary[], selectedIds: readonly string[], query: string, counts?: FacetCounts, max: number = MAX_BRAND_ROWS): readonly BrandRow[] {
  const q = foldSearchText(query);
  const folded = foldedFor(stores);
  const active = stores.filter((s) => s.status === "active");
  const byId = new Map(active.map((s) => [s.id, s] as const));
  const known = new Map(stores.map((s) => [s.id, s] as const));
  const count = (id: string): { count?: number } => { const c = counts?.storeIds?.[id]; return c !== undefined ? { count: c } : {}; };
  const pinned = selectedIds.map((id): BrandRow => {
    const live = byId.get(id);
    return live !== undefined
      ? { id, name: live.name, selected: true, ...count(id) }
      : { id, name: known.get(id)?.name ?? "", selected: true, unavailable: true, ...count(id) };
  });
  const sel = new Set(selectedIds);
  const rest = active.filter((s) => !sel.has(s.id) && (q.length === 0 || (folded.get(s.id) ?? "").includes(q))).map((s): BrandRow => ({ id: s.id, name: s.name, selected: false, ...count(s.id) }));
  return [...pinned, ...rest].slice(0, Math.max(0, max));
}

/* ---- live count sequencing ---- */

export interface CountState {
  /** Id of the most recent request. */
  readonly latest: number;
  /** Highest request id whose answer was accepted. */
  readonly accepted: number;
  /** Last confirmed `total_estimate`; null until one arrives. */
  readonly value: number | null;
  /** The latest request failed: keep `value` and show "Count unavailable". */
  readonly failed: boolean;
}
export const INITIAL_COUNT: CountState = { latest: 0, accepted: 0, value: null, failed: false };

export function beginCount(s: CountState): { readonly state: CountState; readonly id: number } {
  const id = s.latest + 1;
  return { state: { ...s, latest: id }, id };
}

/**
 * Only the answer to the LATEST request is accepted: an older answer is dropped even while the newer one is still pending.
 * Non-finite or negative counts are treated as failures.
 */
export function resolveCount(s: CountState, id: number, n: number): CountState {
  if (id !== s.latest || id <= s.accepted) return s;
  if (!Number.isFinite(n) || n < 0) return failCount(s, id);
  return { latest: s.latest, accepted: id, value: Math.floor(n), failed: id === s.latest ? false : s.failed };
}

/**
 * Close or reopen: invalidates every pending request (ids keep increasing, they are never reset to 0), clears the old value.
 * A late answer from the previous open can therefore never be accepted.
 */
export function cancelCount(s: CountState): CountState {
  const id = s.latest + 1;
  return { latest: id, accepted: id, value: null, failed: false };
}

export function failCount(s: CountState, id: number): CountState {
  return id === s.latest && id > s.accepted ? { ...s, failed: true } : s;
}

/** Footer N: the last confirmed count (kept after a failed request), or null so the label says "Show items". */
export function footerCount(s: CountState): number | null {
  return s.value;
}

/** True when the latest request failed: show "Count unavailable" next to the kept N. */
export function countUnavailable(s: CountState): boolean {
  return s.failed;
}

/** Sheet events for the screen to forward to ClientAnalytics (filter_sheet_opened, filter_applied per key, filter_reset, filter_chip_removed). */
export type FilterEvent =
  | { readonly type: "opened" }
  | { readonly type: "applied"; readonly keys: readonly string[]; readonly resultCount: number | null }
  | { readonly type: "reset" }
  | { readonly type: "chipRemoved"; readonly filterKey: string };

/** Filter keys that differ between two states, as analytics codes (one filter_applied per key). */
export function changedKeys(before: ListingFilters, after: ListingFilters): readonly string[] {
  const a = new Set(appliedChips(before).map((c) => chipFilterKey(c)));
  const b = new Set(appliedChips(after).map((c) => chipFilterKey(c)));
  const keys = new Set<string>();
  for (const k of b) if (!a.has(k)) keys.add(k);
  const sig = (f: ListingFilters, k: string): string => JSON.stringify(appliedChips(f).filter((c) => chipFilterKey(c) === k), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  for (const k of b) if (a.has(k) && sig(before, k) !== sig(after, k)) keys.add(k);
  return [...keys];
}

/** How many values a filter key holds now (analytics value_count). */
export function valueCount(f: ListingFilters, key: string): number {
  return appliedChips(f).filter((c) => chipFilterKey(c) === key).length;
}
