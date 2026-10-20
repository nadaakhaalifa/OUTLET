/** Shop everything (route /shop-all): catalogue across all stores with a multi-store filter. Pure logic, no UI imports. */
import { CONDITIONS, EMPTY_FILTER, isShopDepartment, type Condition, type SearchFilter, type SearchItem, type ShopDepartment } from "../search/model";
import type { StoreSummary } from "../worlds/model";
import { pluralForm, type PluralForm } from "../../i18n/plural";

/** Wire limit for `store_ids` (spec §3/§4, API4). */
export const MAX_STORE_FILTER = 30;
/** Chips shown above the grid before the "+N" overflow chip. */
export const MAX_VISIBLE_CHIPS = 3;
export const SELECTION_KEY = "shopAll.stores";

export interface Selection {
  /** Selected store ids in the order they were picked, unique, at most MAX_STORE_FILTER. */
  readonly ids: readonly string[];
  /** True when the last action was refused or truncated by the limit (UI shows the limit message). */
  readonly limitHit: boolean;
}

export const EMPTY_SELECTION: Selection = { ids: [], limitHit: false };

export type SelectionAction =
  | { readonly type: "toggle"; readonly id: string }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "selectAll"; readonly ids: readonly string[] }
  | { readonly type: "set"; readonly ids: readonly string[] }
  | { readonly type: "clear" };

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function selectionReducer(state: Selection, action: SelectionAction, limit: number = MAX_STORE_FILTER): Selection {
  switch (action.type) {
    case "toggle": {
      if (state.ids.includes(action.id)) return { ids: state.ids.filter((x) => x !== action.id), limitHit: false };
      if (state.ids.length >= limit) return { ids: state.ids, limitHit: true };
      return { ids: [...state.ids, action.id], limitHit: false };
    }
    case "remove":
      return { ids: state.ids.filter((x) => x !== action.id), limitHit: false };
    case "selectAll": {
      const merged = unique([...state.ids, ...action.ids]);
      return merged.length > limit ? { ids: merged.slice(0, limit), limitHit: true } : { ids: merged, limitHit: false };
    }
    case "set": {
      const u = unique(action.ids);
      return u.length > limit ? { ids: u.slice(0, limit), limitHit: true } : { ids: u, limitHit: false };
    }
    case "clear":
      return EMPTY_SELECTION;
  }
}

export interface ChipsView {
  readonly visible: readonly string[];
  /** Number of selected stores hidden behind the "+N" chip (0 = no overflow chip). */
  readonly overflow: number;
}

export function chipsOverflow(ids: readonly string[], maxVisible: number = MAX_VISIBLE_CHIPS): ChipsView {
  const max = Math.max(0, Math.floor(maxVisible));
  return { visible: ids.slice(0, max), overflow: Math.max(0, ids.length - max) };
}

/* ---- persistence (per device, SecureStorage string) ---- */

/** Where the current selection came from. Only the shopper's own changes may overwrite the saved selection. */
export type SelectionOrigin = "route" | "storage" | "prune" | "user";

/**
 * A store opened from a route (deep link, store row, "see all") must not replace the saved per-device selection,
 * and neither may an automatic prune of ids the loaded store list no longer contains.
 */
export function shouldPersistSelection(origin: SelectionOrigin): boolean {
  return origin === "user";
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeSelection(ids: readonly string[]): string {
  return `v1|${unique(ids).filter((x) => ID_RE.test(x)).slice(0, MAX_STORE_FILTER).join(",")}`;
}

export function decodeSelection(raw: string | null): readonly string[] {
  if (raw === null || !raw.startsWith("v1|")) return [];
  const body = raw.slice(3);
  if (body.length === 0) return [];
  return unique(body.split(",").filter((x) => ID_RE.test(x))).slice(0, MAX_STORE_FILTER);
}

/* ---- store list helpers ---- */

/** Case-insensitive name match; Arabic is compared as typed (no folding beyond case and surrounding spaces). */
export function filterStoresByQuery(stores: readonly StoreSummary[], query: string): readonly StoreSummary[] {
  const q = query.trim().toLowerCase();
  const active = stores.filter((s) => s.status === "active");
  return q.length === 0 ? active : active.filter((s) => s.name.toLowerCase().includes(q));
}

/** Drops ids that are not in the (loaded, non-empty) store list, so a suspended or removed store never filters silently. */
export function pruneSelection(ids: readonly string[], stores: readonly StoreSummary[]): readonly string[] {
  if (stores.length === 0) return ids;
  const known = new Set(stores.filter((s) => s.status === "active").map((s) => s.id));
  return ids.filter((id) => known.has(id));
}

/** "Only my stores": the user's favourite active stores, capped at the limit. */
export function favouriteIds(stores: readonly StoreSummary[]): { readonly ids: readonly string[]; readonly truncated: boolean } {
  const all = stores.filter((s) => s.isFavourite && s.status === "active").map((s) => s.id);
  return { ids: all.slice(0, MAX_STORE_FILTER), truncated: all.length > MAX_STORE_FILTER };
}

export function isOnlyMyStores(ids: readonly string[], stores: readonly StoreSummary[]): boolean {
  const fav = favouriteIds(stores).ids;
  return fav.length > 0 && ids.length === fav.length && fav.every((id) => ids.includes(id));
}

export function storeName(stores: readonly StoreSummary[], id: string): string | null {
  return stores.find((s) => s.id === id)?.name ?? null;
}

/* ---- request and ordering ---- */

export function buildShopAllFilter(ids: readonly string[]): SearchFilter {
  return { ...EMPTY_FILTER, world: "everything", ...(ids.length > 0 ? { storeIds: ids.slice(0, MAX_STORE_FILTER) } : {}) };
}

/** The wire has no sort parameter: these orders apply to the pages loaded so far (docs/plan/api-client-gap.md). */
export type ShopSort = "relevance" | "priceLow" | "priceHigh" | "discount";
export const SHOP_SORTS: readonly ShopSort[] = ["relevance", "priceLow", "priceHigh", "discount"];

export function sortItems(items: readonly SearchItem[], sort: ShopSort): readonly SearchItem[] {
  if (sort === "relevance") return items;
  const idx = new Map(items.map((it, i) => [it.id, i] as const));
  const stable = (a: SearchItem, b: SearchItem) => (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0);
  const copy = [...items];
  switch (sort) {
    case "priceLow":
      return copy.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : stable(a, b)));
    case "priceHigh":
      return copy.sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : stable(a, b)));
    case "discount":
      return copy.sort((a, b) => (b.verifiedDiscountPct ?? -1) - (a.verifiedDiscountPct ?? -1) || stable(a, b));
  }
}

/** Appends a page and drops ids already shown (cursor overlap must not duplicate cards). */
export function mergePages(current: readonly SearchItem[], next: readonly SearchItem[]): readonly SearchItem[] {
  const seen = new Set(current.map((x) => x.id));
  return [...current, ...next.filter((x) => !seen.has(x.id))];
}

/** Home "Stores" list: at most 5 active stores, one per row, live drops first then server trending order. */
export function homeStoreRows(stores: readonly StoreSummary[], max: number = 5): readonly StoreSummary[] {
  return stores
    .filter((s) => s.status === "active")
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(b.s.liveDrop) - Number(a.s.liveDrop) || a.s.trendingRank - b.s.trendingRank || a.i - b.i)
    .slice(0, max)
    .map((x) => x.s);
}

/* ======================================================================================
 * Category + budget + text filters (owner request: "I need a tshirt within this budget").
 * Budget is P3 financial-behaviour data: it lives only in component state, is sent only as
 * `price_min`/`price_max` query filters, is never persisted, logged or used for ranking.
 * ====================================================================================== */

/** Wire limit for `category_ids` (API4, spec section 4). */
export const MAX_CATEGORY_FILTER = 30;
/** Largest accepted budget bound in whole EGP (7 digits), keeps bigint math and the wire sane. */
export const MAX_BUDGET_EGP = 9_999_999n;
/** Category chips shown in the row before the "More" chip. */
export const MAX_CATEGORY_CHIPS = 8;
export const BUDGET_STEP_EGP = 50n;

/* ---- digits and money ---- */

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Folds Arabic-Indic and Persian digits and Arabic separators to ASCII; drops grouping and spaces. */
export function foldDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(EXT_ARABIC_INDIC.indexOf(d)))
    .replace(/٫/g, ".")
    .replace(/[٬,\s\u00a0\u200e\u200f]/g, "");
}

/** "1,250.50" / "١٢٥٠" to integer piastres. Null for empty, malformed, negative or above the cap. Never uses floats. */
export function parseEgpToPiastres(raw: string): bigint | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(foldDigits(raw));
  if (m === null) return null;
  const whole = BigInt(m[1] ?? "0");
  if (whole > MAX_BUDGET_EGP) return null;
  const frac = BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return whole * 100n + frac;
}

/** Piastres to a plain editable field string: whole EGP, with decimals only when non-zero. */
export function piastresToField(p: bigint): string {
  const whole = p / 100n;
  const frac = p % 100n;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, "0")}`;
}

/* ---- budget ---- */

export interface Budget {
  readonly min: bigint | null;
  readonly max: bigint | null;
}
export const NO_BUDGET: Budget = { min: null, max: null };

export type BudgetError = "invalid" | "minAboveMax";

export interface BudgetParse {
  readonly budget: Budget;
  /** Field-level problems; empty when the budget can be applied. */
  readonly errors: { readonly min?: BudgetError; readonly max?: BudgetError; readonly range?: BudgetError };
  readonly ok: boolean;
}

/** Validates the two text fields. Empty field = open bound. Negative or non-numeric text is `invalid`. */
export function parseBudgetFields(minRaw: string, maxRaw: string): BudgetParse {
  const read = (raw: string): { v: bigint | null; bad: boolean } => {
    if (foldDigits(raw).length === 0) return { v: null, bad: false };
    const v = parseEgpToPiastres(raw);
    return { v, bad: v === null };
  };
  const a = read(minRaw);
  const b = read(maxRaw);
  const errors: { min?: BudgetError; max?: BudgetError; range?: BudgetError } = {};
  if (a.bad) errors.min = "invalid";
  if (b.bad) errors.max = "invalid";
  if (!a.bad && !b.bad && a.v !== null && b.v !== null && a.v > b.v) errors.range = "minAboveMax";
  const ok = Object.keys(errors).length === 0;
  return { budget: ok ? { min: a.v, max: b.v } : NO_BUDGET, errors, ok };
}

export function hasBudget(b: Budget): boolean {
  return b.min !== null || b.max !== null;
}

export interface BudgetPreset {
  readonly id: "under300" | "300to600" | "600to1000" | "over1000";
  readonly budget: Budget;
}
export const BUDGET_PRESETS: readonly BudgetPreset[] = [
  { id: "under300", budget: { min: null, max: 30_000n } },
  { id: "300to600", budget: { min: 30_000n, max: 60_000n } },
  { id: "600to1000", budget: { min: 60_000n, max: 100_000n } },
  { id: "over1000", budget: { min: 100_000n, max: null } },
];

export function sameBudget(a: Budget, b: Budget): boolean {
  return a.min === b.min && a.max === b.max;
}

/** Stepper: moves a bound by whole steps of EGP, clamped to [0, cap]. Null counts as `from`. */
export function stepBound(value: bigint | null, deltaSteps: number, from: bigint = 0n, stepEgp: bigint = BUDGET_STEP_EGP): bigint {
  const base = value ?? from;
  const next = base + BigInt(deltaSteps) * stepEgp * 100n;
  const cap = MAX_BUDGET_EGP * 100n;
  return next < 0n ? 0n : next > cap ? cap : next;
}

/** Keeps min <= max after a stepper move by dragging the other bound along. */
export function withMinMax(b: Budget, which: "min" | "max", value: bigint): Budget {
  if (which === "min") return { min: value, max: b.max !== null && b.max < value ? value : b.max };
  return { min: b.min !== null && b.min > value ? value : b.min, max: value };
}

/** Chip text parts for the applied budget, formatted by the caller's money formatter. */
export type BudgetSummary =
  | { readonly kind: "range"; readonly min: string; readonly max: string }
  | { readonly kind: "upTo"; readonly max: string }
  | { readonly kind: "from"; readonly min: string }
  | { readonly kind: "none" };

export function summarizeBudget(b: Budget, fmt: (p: bigint) => string): BudgetSummary {
  if (b.min !== null && b.max !== null) return { kind: "range", min: fmt(b.min), max: fmt(b.max) };
  if (b.max !== null) return { kind: "upTo", max: fmt(b.max) };
  if (b.min !== null) return { kind: "from", min: fmt(b.min) };
  return { kind: "none" };
}

/* ---- category tree ---- */

export interface CategoryNode {
  readonly id: string;
  readonly slug: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly parentId: string | null;
}

export interface CategoryPort {
  tree(): Promise<readonly CategoryNode[]>;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
const cat = (n: number, slug: string, nameEn: string, nameAr: string, parent: number | null = null): CategoryNode => ({
  id: uuid(n), slug, nameEn, nameAr, parentId: parent === null ? null : uuid(parent),
});

/** Synthetic tree (development and tests only). Production uses ApiCategoryPort over GET /v1/public/categories. */
export const FIXTURE_CATEGORIES: readonly CategoryNode[] = [
  cat(1, "dresses", "Dresses", "فساتين"),
  cat(2, "tops", "Tops", "بلوزات وتيشيرتات"),
  cat(21, "tshirts", "T-shirts", "تيشيرتات", 2),
  cat(22, "shirts", "Shirts and blouses", "قمصان وبلوزات", 2),
  cat(3, "denim", "Denim", "جينز"),
  cat(4, "outerwear", "Outerwear", "جاكيتات ومعاطف"),
  cat(5, "shoes", "Shoes", "أحذية"),
  cat(6, "bags", "Bags", "شنط"),
  cat(7, "accessories", "Accessories", "إكسسوارات"),
  cat(71, "watches", "Watches", "ساعات", 7),
  cat(72, "eyewear", "Eyewear", "نظارات", 7),
  cat(8, "activewear", "Activewear", "ملابس رياضية"),
  cat(9, "kids", "Kids", "أطفال"),
  cat(10, "modest", "Modest", "محتشم"),
];

export class InMemoryCategoryPort implements CategoryPort {
  constructor(private readonly nodes: readonly CategoryNode[] = FIXTURE_CATEGORIES) {}
  async tree(): Promise<readonly CategoryNode[]> {
    return this.nodes;
  }
}

export function categoryName(n: CategoryNode, locale: "ar" | "en"): string {
  return locale === "ar" ? n.nameAr : n.nameEn;
}

export function topLevel(tree: readonly CategoryNode[]): readonly CategoryNode[] {
  return tree.filter((n) => n.parentId === null);
}

/** A node plus all its descendants (cycle-safe). */
export function descendantIds(tree: readonly CategoryNode[], id: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (cur: string): void => {
    if (seen.has(cur)) return;
    seen.add(cur);
    out.push(cur);
    for (const n of tree) if (n.parentId === cur) walk(n.id);
  };
  walk(id);
  return out;
}

/** Wire ids for the selected categories: each choice expands to its subtree, deduplicated and capped at the facet limit. */
export function expandCategoryIds(tree: readonly CategoryNode[], selected: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const id of selected) for (const d of descendantIds(tree, id)) out.add(d);
  return [...out].slice(0, MAX_CATEGORY_FILTER);
}

/** Folds case, Arabic diacritics/tatweel, alef and ya/ta-marbuta variants and digits for local matching. */
export function foldSearchText(raw: string): string {
  return foldDigits(raw)
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .trim();
}

/** Searchable category sheet: matches either language and the slug. Empty query returns the whole tree. */
export function searchCategories(tree: readonly CategoryNode[], query: string): readonly CategoryNode[] {
  const q = foldSearchText(query);
  if (q.length === 0) return tree;
  return tree.filter((n) => foldSearchText(n.nameEn).includes(q) || foldSearchText(n.nameAr).includes(q) || n.slug.includes(q));
}

/** Depth for indenting rows in the sheet (0 for top level). */
export function depthOf(tree: readonly CategoryNode[], id: string): number {
  let d = 0;
  let cur = tree.find((n) => n.id === id);
  const seen = new Set<string>();
  while (cur !== undefined && cur.parentId !== null && !seen.has(cur.id)) {
    seen.add(cur.id);
    d += 1;
    const pid: string = cur.parentId;
    cur = tree.find((n) => n.id === pid);
  }
  return d;
}

/** Resolves a route param (slug or id) to a node id. */
export function resolveCategoryParam(tree: readonly CategoryNode[], raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const v = raw.trim();
  if (v.length === 0) return null;
  const lower = v.toLowerCase();
  return tree.find((n) => n.id === v || n.slug === lower)?.id ?? null;
}

/* ---- combined filter state ---- */

export const MAX_FILTER_QUERY = 100;

export interface ShopFilters {
  /** Free text; sent as `q` (server normalises Arabic, Franco and synonyms). */
  readonly q: string;
  /** Categories the user picked (not expanded). */
  readonly categoryIds: readonly string[];
  readonly budget: Budget;
  /** Shopper department from the Home boxes (or null). Combines with categories, budget and stores. */
  readonly department: ShopDepartment | null;
  /** Verified discount floor in percent (one of DISCOUNT_STEPS) or null. Never an unverified percent. */
  readonly minDiscountPct: DiscountStep | null;
  readonly lowest30d: boolean;
  readonly freeDelivery: boolean;
  readonly newArrivals: boolean;
  readonly conditions: readonly Condition[];
}
export const EMPTY_SHOP_FILTERS: ShopFilters = {
  q: "", categoryIds: [], budget: NO_BUDGET, department: null, minDiscountPct: null, lowest30d: false, freeDelivery: false, newArrivals: false, conditions: [],
};

/** Selectable verified-discount floors (percent). All are above the server minimum of 5. */
export const DISCOUNT_STEPS = [10, 20, 30, 50] as const;
export type DiscountStep = (typeof DISCOUNT_STEPS)[number];
export type ShopFlag = "lowest30d" | "freeDelivery" | "newArrivals";

export type ShopFilterAction =
  | { readonly type: "setQuery"; readonly q: string }
  | { readonly type: "toggleCategory"; readonly id: string }
  | { readonly type: "setCategory"; readonly id: string }
  | { readonly type: "clearCategories" }
  | { readonly type: "setBudget"; readonly budget: Budget }
  | { readonly type: "clearBudget" }
  | { readonly type: "setDepartment"; readonly department: ShopDepartment }
  | { readonly type: "clearDepartment" }
  | { readonly type: "setMinDiscount"; readonly pct: DiscountStep | null }
  | { readonly type: "toggleFlag"; readonly flag: ShopFlag }
  | { readonly type: "toggleCondition"; readonly condition: Condition }
  | { readonly type: "clearAll" }
  | { readonly type: "replace"; readonly filters: ShopFilters };

export function shopFiltersReducer(s: ShopFilters, a: ShopFilterAction): ShopFilters {
  switch (a.type) {
    case "setQuery":
      return { ...s, q: a.q.replace(/\s+/g, " ").slice(0, MAX_FILTER_QUERY) };
    case "toggleCategory":
      return s.categoryIds.includes(a.id)
        ? { ...s, categoryIds: s.categoryIds.filter((x) => x !== a.id) }
        : s.categoryIds.length >= MAX_CATEGORY_FILTER ? s : { ...s, categoryIds: [...s.categoryIds, a.id] };
    case "setCategory":
      return { ...s, categoryIds: [a.id] };
    case "clearCategories":
      return { ...s, categoryIds: [] };
    case "setBudget":
      return { ...s, budget: a.budget };
    case "clearBudget":
      return { ...s, budget: NO_BUDGET };
    case "setDepartment":
      // "unisex" is never a shopper choice (no chip can show or clear it).
      return { ...s, department: a.department === "unisex" ? null : a.department };
    case "clearDepartment":
      return { ...s, department: null };
    case "setMinDiscount":
      return { ...s, minDiscountPct: a.pct !== null && (DISCOUNT_STEPS as readonly number[]).includes(a.pct) ? a.pct : null };
    case "toggleFlag":
      return { ...s, [a.flag]: !s[a.flag] };
    case "toggleCondition":
      return { ...s, conditions: s.conditions.includes(a.condition) ? s.conditions.filter((c) => c !== a.condition) : CONDITIONS.filter((c) => c === a.condition || s.conditions.includes(c)) };
    case "clearAll":
      return EMPTY_SHOP_FILTERS;
    case "replace":
      return a.filters;
  }
}

/** Serialises to the existing SearchFilter (wire JSON via filterToWire): store + category + budget combine with AND. */
export function toSearchFilter(storeIds: readonly string[], f: ShopFilters, tree: readonly CategoryNode[], onSale: boolean = false): SearchFilter {
  const cats = expandCategoryIds(tree, f.categoryIds);
  return {
    ...buildShopAllFilter(storeIds),
    ...(onSale ? { verifiedDiscountOnly: true } : {}),
    ...(cats.length > 0 ? { categoryIds: cats } : {}),
    ...(f.department !== null ? { department: f.department } : {}),
    ...(f.budget.min !== null ? { priceMin: f.budget.min } : {}),
    ...(f.budget.max !== null ? { priceMax: f.budget.max } : {}),
    ...(f.minDiscountPct !== null ? { minVerifiedDiscountPct: f.minDiscountPct } : {}),
    ...(f.lowest30d ? { lowest30dOnly: true } : {}),
    ...(f.freeDelivery ? { freeDeliveryEligible: true } : {}),
    ...(f.newArrivals ? { newArrivals: true } : {}),
    ...(f.conditions.length > 0 ? { conditions: f.conditions } : {}),
  };
}

/** Number of active facets for the "Clear all" row (stores, categories, budget, text). */
export function activeFacetCount(storeIds: readonly string[], f: ShopFilters): number {
  return (storeIds.length > 0 ? 1 : 0) + (f.categoryIds.length > 0 ? 1 : 0) + (hasBudget(f.budget) ? 1 : 0) + (f.department !== null ? 1 : 0) + (f.q.trim().length > 0 ? 1 : 0) + facetExtras(f);
}

/** Count of the Phase A facets: discount floor, three flags, and each condition. */
function facetExtras(f: ShopFilters): number {
  return (f.minDiscountPct !== null ? 1 : 0) + (f.lowest30d ? 1 : 0) + (f.freeDelivery ? 1 : 0) + (f.newArrivals ? 1 : 0) + f.conditions.length;
}

/** One removable chip in the applied-filters row. Search text is not listed (it has its own field). */
export type AppliedFilter =
  | { readonly kind: "onSale" }
  | { readonly kind: "minDiscount"; readonly pct: DiscountStep }
  | { readonly kind: "flag"; readonly flag: ShopFlag }
  | { readonly kind: "condition"; readonly condition: Condition }
  | { readonly kind: "department"; readonly department: ShopDepartment }
  | { readonly kind: "category"; readonly id: string }
  | { readonly kind: "budget" }
  | { readonly kind: "store"; readonly id: string };

/** Every active filter, in display order, for the applied-filters row. Empty when nothing is applied. */
export function appliedFilters(storeIds: readonly string[], f: ShopFilters, onSale: boolean): readonly AppliedFilter[] {
  const out: AppliedFilter[] = [];
  if (onSale) out.push({ kind: "onSale" });
  if (f.minDiscountPct !== null) out.push({ kind: "minDiscount", pct: f.minDiscountPct });
  if (f.newArrivals) out.push({ kind: "flag", flag: "newArrivals" });
  if (f.freeDelivery) out.push({ kind: "flag", flag: "freeDelivery" });
  if (f.lowest30d) out.push({ kind: "flag", flag: "lowest30d" });
  f.conditions.forEach((condition) => out.push({ kind: "condition", condition }));
  if (f.department !== null && f.department !== "unisex") out.push({ kind: "department", department: f.department });
  f.categoryIds.forEach((id) => out.push({ kind: "category", id }));
  if (hasBudget(f.budget)) out.push({ kind: "budget" });
  storeIds.forEach((id) => out.push({ kind: "store", id }));
  return out;
}

/** i18n key for "N filters applied" (CLDR Arabic: one, two, few, many, other; zero is never shown and maps to other). */
export function appliedCountKey(n: number): `applied${PluralForm}` {
  return `applied${pluralForm(n)}`;
}

/** "N items" header: only when the server sent total_estimate. */
export function resultsCount(totalEstimate: number | undefined): number | null {
  return totalEstimate !== undefined && Number.isFinite(totalEstimate) && totalEstimate >= 0 ? Math.floor(totalEstimate) : null;
}

export interface ShopRouteParams {
  readonly category?: string | undefined;
  readonly q?: string | undefined;
  readonly min?: string | undefined;
  readonly max?: string | undefined;
  /** women | men | kids; anything else (including unisex) is ignored. */
  readonly department?: string | undefined;
}

/**
 * Shopper department from a route param. "unisex" is the catalogue's internal lifestyle value, not a shopper-facing department:
 * the filter UI cannot show or clear it, so a route may never set it (it is ignored like any unknown value).
 */
export function routeDepartment(raw: string | undefined): ShopDepartment | null {
  return isShopDepartment(raw) && raw !== "unisex" ? raw : null;
}

/** Quick-compose: /shop-all?category=tops&q=tshirt&min=100&max=500 (min/max in EGP). Invalid parts are ignored, never thrown. */
export function parseShopRouteParams(p: ShopRouteParams, tree: readonly CategoryNode[]): ShopFilters {
  const cats = typeof p.category === "string"
    ? [...new Set(p.category.split(",").map((c) => resolveCategoryParam(tree, c)).filter((c): c is string => c !== null))].slice(0, MAX_CATEGORY_FILTER)
    : [];
  const q = typeof p.q === "string" ? p.q.replace(/\s+/g, " ").trim().slice(0, MAX_FILTER_QUERY) : "";
  const min = typeof p.min === "string" ? parseEgpToPiastres(p.min) : null;
  const max = typeof p.max === "string" ? parseEgpToPiastres(p.max) : null;
  const ordered = min !== null && max !== null && min > max;
  const department = routeDepartment(p.department);
  return { q, categoryIds: cats, budget: ordered ? { min: null, max } : { min, max }, department,
    minDiscountPct: null, lowest30d: false, freeDelivery: false, newArrivals: false, conditions: [] };
}

/** True when route params carry something to pre-apply. */
export function hasRouteFilters(p: ShopRouteParams): boolean {
  return [p.category, p.q, p.min, p.max, routeDepartment(p.department) ?? undefined].some((v) => typeof v === "string" && v.trim().length > 0);
}

/** Zero-results actions that make sense for the current filters, in display order. */
export type EmptyAction = "raiseBudget" | "clearCategory" | "clearDepartment" | "clearStores" | "clearQuery";
export function emptyActions(storeIds: readonly string[], f: ShopFilters): readonly EmptyAction[] {
  const out: EmptyAction[] = [];
  if (f.budget.max !== null) out.push("raiseBudget");
  if (f.categoryIds.length > 0) out.push("clearCategory");
  if (f.department !== null) out.push("clearDepartment");
  if (storeIds.length > 0) out.push("clearStores");
  if (f.q.trim().length > 0) out.push("clearQuery");
  return out;
}

/* ======================================================================================
 * Grid layout and the single filter button (density feature).
 * ====================================================================================== */

/** Departments that get an avatar in the one slim row. "unisex" is not a shopper-facing department. */
export const AVATAR_DEPARTMENTS: readonly ShopDepartment[] = ["women", "men", "kids"];
/** Category chips in the category layout, after "All". Only real top-level categories. */
export const MAX_HERO_CHIPS = 5;

/** Number the filter button badge shows: sheet-held filters only (categories, budget, stores, department, on sale). Search text is not counted. */
export function filterBadgeCount(storeIds: readonly string[], f: ShopFilters, onSale: boolean): number {
  return f.categoryIds.length + (hasBudget(f.budget) ? 1 : 0) + storeIds.length + (f.department !== null && f.department !== "unisex" ? 1 : 0) + (onSale ? 1 : 0) + facetExtras(f);
}

/**
 * Physical left/right padding for a cell so that `columns` equal-width columns share a `gap` between them.
 * FlashList lays columns out left to right in RTL too, so this is intentionally physical.
 */
export function cellPadding(index: number, columns: number, gap: number): { readonly left: number; readonly right: number } {
  const n = Math.max(1, Math.floor(columns));
  if (n === 1) return { left: 0, right: 0 };
  const col = ((Math.floor(index) % n) + n) % n;
  return { left: (col * gap) / n, right: gap - ((col + 1) * gap) / n };
}

/** Vertical padding of horizontal chip rows: 34pt chip + 2 x 5 = 44pt effective target (the kit hitSlop is clipped by the scroller). */
export const CHIP_ROW_PAD_V = 5;

/** Number of days the "lowest price" badge looks back (the wire filter is fixed at 30). */
export const LOWEST_PRICE_DAYS = 30;

/** Gap between columns shrinks as cards get smaller. */
export function gridGap(columns: number): number {
  return columns >= 4 ? 6 : columns === 3 ? 8 : 14;
}

/** FlashList key: changing numColumns needs a remount (device spike pending). */
export function listKey(columns: number): string {
  return `shop-grid-${Math.max(1, Math.floor(columns))}`;
}

/** Top-level categories for the category-layout chip row (real tree only, capped). */
export function heroChipCategories(tree: readonly CategoryNode[], max: number = MAX_HERO_CHIPS): readonly CategoryNode[] {
  return topLevel(tree).slice(0, Math.max(0, max));
}

/** Category layout is used when the route opened a department or a category and no single-store collection. */
export function isCategoryLayout(p: ShopRouteParams | undefined, collection: boolean): boolean {
  if (collection || p === undefined) return false;
  const cat = typeof p.category === "string" && p.category.trim().length > 0;
  return cat || routeDepartment(p.department) !== null;
}
