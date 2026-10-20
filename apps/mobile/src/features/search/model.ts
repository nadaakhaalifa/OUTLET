/** Search and filters (spec §4). Pure model, port and in-memory fake; no UI imports. */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export type Condition = "newWithTags" | "newWithoutTags" | "sample" | "minorDefect";
export const CONDITIONS: readonly Condition[] = ["newWithTags", "newWithoutTags", "sample", "minorDefect"];

export interface SearchFilter {
  /** Integer piastres; null = no budget filter. */
  readonly budgetMax: bigint | null;
  readonly mySizeOnly: boolean;
  readonly conditions: readonly Condition[];
  readonly verifiedDiscountOnly: boolean;
  /** Payment-aware filters (spec §4). Installment amounts only ever come from provider quotes. */
  readonly installmentsAvailable: boolean;
  readonly payableWithCredit: boolean;
  /** Store scope (spec §3/§4, wire `store_ids`, max 30). Absent or empty = no store filter. */
  readonly storeIds?: readonly string[];
  /** Wire `world`. Shop everything sends "everything". Absent = server default. */
  readonly world?: "local" | "global" | "everything";
  /** Category scope (wire `category_ids`, max 30). Absent or empty = no category filter. */
  readonly categoryIds?: readonly string[];
  /** Price range in integer piastres (wire `price_min` / `price_max`). Sensitive: only ever a query filter. */
  readonly priceMin?: bigint;
  readonly priceMax?: bigint;
  /** Single shopper department (wire `departments: [x]`). Absent = all departments. */
  readonly department?: ShopDepartment;
  /** Wire `min_verified_discount_pct` (server floor 5). Verified discounts only; the server never matches an unverified percent. */
  readonly minVerifiedDiscountPct?: number;
  /** Wire `lowest_30d_only`. */
  readonly lowest30dOnly?: boolean;
  /** Wire `free_delivery_eligible`. */
  readonly freeDeliveryEligible?: boolean;
  /** Wire `new_arrivals`. */
  readonly newArrivals?: boolean;
  /** Server sort (query parameter `sort`: price_asc, price_desc, biggest_verified_discount). Absent = relevance. The cursor is tied to the sort, so changing it restarts paging. */
  readonly sort?: "priceLow" | "priceHigh" | "discount";
  /** Dev-fixture facets (design board "New In" / "In Stock"). No wire field yet (docs/plan/api-client-gap.md): only ports with `supportsDevFacets` honour them. */
  readonly newIn?: boolean;
  readonly inStock?: boolean;
}

/** Shopper department (wire `departments`, any of). Home boxes send exactly one. Accessories is a category. */
export type ShopDepartment = "women" | "men" | "kids" | "unisex";
export const SHOP_DEPARTMENTS: readonly ShopDepartment[] = ["women", "men", "kids", "unisex"];
export function isShopDepartment(v: unknown): v is ShopDepartment {
  return typeof v === "string" && (SHOP_DEPARTMENTS as readonly string[]).includes(v);
}
/** Same rule as the server: women and men also match unisex, kids is strict. */
export function departmentMatches(wanted: ShopDepartment, item: ShopDepartment): boolean {
  return item === wanted || (item === "unisex" && (wanted === "women" || wanted === "men"));
}

export const EMPTY_FILTER: SearchFilter = {
  budgetMax: null, mySizeOnly: false, conditions: [], verifiedDiscountOnly: false, installmentsAvailable: false, payableWithCredit: false,
};

export const MAX_FACETS = 30;
export const MAX_PAGE_SIZE = 50;
export const MAX_QUERY_LENGTH = 100;
export const MAX_SPONSORED_IN_TOP_10 = 2;

export interface SearchItem {
  readonly id: string;
  readonly title: string;
  readonly storeName: string;
  readonly price: bigint;
  /** Present only when the Price Integrity Engine verified a claim (spec §9). */
  readonly verifiedDiscountPct: number | null;
  /** Verified reference price in piastres; present only with a verified claim. Optional for older adapters. */
  readonly referencePrice?: bigint | null;
  readonly sponsored: boolean;
  /** Seller store id when the adapter knows it (used by the store filter fake and Shop everything). */
  readonly storeId?: string;
  /** Category id when the adapter knows it (fake only). */
  readonly categoryId?: string;
  /** Shopper department when the wire carried it. */
  readonly department?: ShopDepartment;
  /** Brand line shown in small caps on the card. Null/absent = hidden (real adapters leave it absent). */
  readonly brand?: string | null;
  /** Dev-fixture photo slot (index into the board crops); real adapters never set it. */
  readonly devPhoto?: number;
}

/** Exact per-value counts for the current query and filters, present only when the server sends `facet_counts`. Absent = show no numbers. */
export interface FacetCounts {
  readonly categoryIds?: Readonly<Record<string, number>>;
  readonly storeIds?: Readonly<Record<string, number>>;
}

export interface SearchPage {
  /** Server facet counts (WP-API). Never estimated client-side. */
  readonly facetCounts?: FacetCounts;
  readonly items: readonly SearchItem[];
  readonly total: number;
  /** Server `total_estimate` when the API sent one (absent = do not show a count). */
  readonly totalEstimate?: number;
  readonly nextCursor: string | null;
}

export interface SearchPort {
  suggest(query: string): Promise<readonly string[]>;
  /** Queries, stores and categories for the inline search panel (round-2 item 8). Optional: ports without it fall back to `suggest`. */
  suggestGrouped?(query: string): Promise<SuggestionInput>;
  search(query: string, filter: SearchFilter, cursor: string | null): Promise<SearchPage>;
  /** Live count for the filter sheet. */
  count(query: string, filter: SearchFilter): Promise<number>;
  /** True only for the dev fixtures: enables the "New In" / "In Stock" chips (hidden in production). */
  readonly supportsDevFacets?: boolean;
}

/** Raw suggestion sources, already localized by the adapter. */
export interface SuggestionInput {
  readonly queries: readonly string[];
  readonly stores: readonly { readonly id: string; readonly name: string }[];
  readonly categories: readonly { readonly id: string; readonly name: string }[];
}
export type SuggestionKind = "query" | "store" | "category";
export interface Suggestion {
  readonly kind: SuggestionKind;
  /** Store or category id; null for a query. */
  readonly id: string | null;
  readonly label: string;
}
export const MAX_SUGGESTIONS = 5;

/**
 * At most `max` suggestions: queries first, then stores, then categories. Labels are trimmed; empty and duplicate
 * labels within a kind are dropped. Order inside a kind is the server order.
 */
export function groupSuggestions(input: SuggestionInput, max: number = MAX_SUGGESTIONS): readonly Suggestion[] {
  const cap = Math.max(0, Math.floor(max));
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (kind: SuggestionKind, id: string | null, raw: string): void => {
    const label = raw.trim();
    const key = `${kind}:${id ?? ""}:${label.toLowerCase()}`;
    if (out.length >= cap || label.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push({ kind, id, label });
  };
  for (const q of input.queries) add("query", null, q);
  for (const s of input.stores) add("store", s.id, s.name);
  for (const c of input.categories) add("category", c.id, c.name);
  return out;
}

const EASTERN = "٠١٢٣٤٥٦٧٨٩";

/** Trims, collapses spaces, folds Eastern Arabic digits to ASCII and caps length (API4). */
export function normalizeQuery(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(EASTERN.indexOf(d)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

export function activeFilterCount(f: SearchFilter): number {
  return (
    (f.budgetMax !== null ? 1 : 0) + (f.mySizeOnly ? 1 : 0) + f.conditions.length + (f.verifiedDiscountOnly ? 1 : 0) +
    (f.installmentsAvailable ? 1 : 0) + (f.payableWithCredit ? 1 : 0)
  );
}

export function toggleCondition(f: SearchFilter, c: Condition): SearchFilter {
  return { ...f, conditions: f.conditions.includes(c) ? f.conditions.filter((x) => x !== c) : [...f.conditions, c] };
}

/** Parses a budget text field (digits in either numeral system) into piastres. Null on invalid or empty. */
export function parseBudgetEgp(raw: string): bigint | null {
  const ascii = raw.replace(/[٠-٩]/g, (d) => String(EASTERN.indexOf(d))).replace(/[,٬\s]/g, "");
  if (!/^\d{1,7}$/.test(ascii)) return null;
  const n = BigInt(ascii);
  return n > 0n ? n * 100n : null;
}

export type FilterKey = "installmentsAvailable" | "payableWithCredit" | "conditions" | "mySizeOnly" | "verifiedDiscountOnly" | "budgetMax";

/** Relaxation order, least important first (spec §4: zero results relax the least important filter). */
export const RELAX_ORDER: readonly FilterKey[] = ["installmentsAvailable", "payableWithCredit", "conditions", "mySizeOnly", "verifiedDiscountOnly", "budgetMax"];

function isActive(f: SearchFilter, k: FilterKey): boolean {
  switch (k) {
    case "conditions": return f.conditions.length > 0;
    case "budgetMax": return f.budgetMax !== null;
    default: return f[k];
  }
}

function without(f: SearchFilter, k: FilterKey): SearchFilter {
  switch (k) {
    case "conditions": return { ...f, conditions: [] };
    case "budgetMax": return { ...f, budgetMax: null };
    default: return { ...f, [k]: false };
  }
}

export function relaxLeastImportant(f: SearchFilter): { readonly filter: SearchFilter; readonly dropped: FilterKey } | null {
  for (const k of RELAX_ORDER) if (isActive(f, k)) return { filter: without(f, k), dropped: k };
  return null;
}

/** Sponsored results are capped at 2 within the top 10; extras move after position 10, order preserved. */
export function arrangeResults(items: readonly SearchItem[]): readonly SearchItem[] {
  const top: SearchItem[] = [];
  const later: SearchItem[] = [];
  let sponsored = 0;
  for (const it of items) {
    if (top.length < 10) {
      if (it.sponsored) {
        if (sponsored >= MAX_SPONSORED_IN_TOP_10) { later.push(it); continue; }
        sponsored += 1;
      }
      top.push(it);
    } else later.push(it);
  }
  // Backfill the top 10 with non-sponsored items that were pushed behind a deferred sponsored one.
  while (top.length < 10) {
    const idx = later.findIndex((i) => !i.sponsored);
    if (idx < 0) break;
    const [moved] = later.splice(idx, 1);
    if (moved !== undefined) top.push(moved);
  }
  return [...top, ...later];
}

/** Discount text only for items that carry a verified percent of at least 5 (spec §9.3). */
export function displayDiscountPct(item: Pick<SearchItem, "verifiedDiscountPct">): number | null {
  const p = item.verifiedDiscountPct;
  return p !== null && Number.isInteger(p) && p >= 5 && p <= 95 ? p : null;
}

export type SearchOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "results"; readonly items: readonly SearchItem[]; readonly total: number; readonly nextCursor: string | null }
  | { readonly kind: "relaxed"; readonly items: readonly SearchItem[]; readonly total: number; readonly nextCursor: string | null; readonly dropped: readonly FilterKey[]; readonly filter: SearchFilter }
  | { readonly kind: "empty" };

/** Runs a search; on zero results drops the least important active filter one at a time until results appear. */
export async function runSearch(port: SearchPort, rawQuery: string, filter: SearchFilter): Promise<SearchOutcome> {
  const q = normalizeQuery(rawQuery);
  if (q.length === 0 && activeFilterCount(filter) === 0) return { kind: "idle" };
  const first = await port.search(q, filter, null);
  if (first.items.length > 0) return { kind: "results", items: arrangeResults(first.items), total: first.total, nextCursor: first.nextCursor };
  let current = filter;
  const dropped: FilterKey[] = [];
  for (;;) {
    const step = relaxLeastImportant(current);
    if (step === null) return { kind: "empty" };
    current = step.filter;
    dropped.push(step.dropped);
    const page = await port.search(q, current, null);
    if (page.items.length > 0) {
      return { kind: "relaxed", items: arrangeResults(page.items), total: page.total, nextCursor: page.nextCursor, dropped, filter: current };
    }
  }
}

export type SearchScreenError = { readonly offline: boolean };
export function searchFailure(e: unknown): SearchScreenError {
  return { offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

export interface FakeSearchRow extends SearchItem {
  readonly inMySize: boolean;
  readonly condition: Condition;
  readonly installments: boolean;
  readonly creditOk: boolean;
  readonly keywords?: string;
  readonly isNew?: boolean;
  readonly available?: boolean;
  /** Phase A facet data (dev catalogue only). Absent = false, so a row never matches a flag it does not carry. */
  readonly freeDelivery?: boolean;
  readonly lowest30d?: boolean;
}

/** Same synthetic ids as FIXTURE_CATEGORIES in features/shop-all/model.ts (kept literal: no import cycle). */
const fixtureCategoryId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const FIXTURE_SEARCH_ROWS: readonly FakeSearchRow[] = [
  { id: "p1", department: "women", categoryId: fixtureCategoryId(1), storeId: "s4", title: "White linen dress", storeName: "Delta Dresses", price: 120_000n, verifiedDiscountPct: 30, referencePrice: 171_500n, sponsored: false, inMySize: true, condition: "newWithTags", installments: true, creditOk: true },
  { id: "p2", department: "unisex", categoryId: fixtureCategoryId(3), storeId: "s1", title: "Straight jeans", storeName: "Cairo Denim", price: 119_000n, verifiedDiscountPct: null, sponsored: false, inMySize: true, condition: "newWithoutTags", installments: true, creditOk: true },
  { id: "p3", department: "men", categoryId: fixtureCategoryId(4), storeId: "s1", title: "Denim jacket", storeName: "Cairo Denim", price: 76_000n, verifiedDiscountPct: 12, referencePrice: 86_400n, sponsored: true, inMySize: false, condition: "sample", installments: false, creditOk: true },
  { id: "p4", department: "kids", categoryId: fixtureCategoryId(8), storeId: "s3", title: "Running shorts", storeName: "Atlas Sport", price: 45_000n, verifiedDiscountPct: null, sponsored: false, inMySize: true, condition: "minorDefect", installments: false, creditOk: false },
];

/** Design-board dev fixtures (New In / In Stock facets). Composed by the dev app ports only; the default fake keeps the core rows. */
export const BOARD_SEARCH_ROWS: readonly FakeSearchRow[] = [
  { id: "w1", department: "men", storeId: "s2", title: "Wool Coat", brand: "ZARA", devPhoto: 0, keywords: "winter", storeName: "ZARA", price: 7_999n, verifiedDiscountPct: 50, referencePrice: 15_999n, sponsored: false, inMySize: true, condition: "newWithTags", installments: true, creditOk: true, isNew: true, available: true },
  { id: "w2", department: "women", storeId: "s2", title: "Knit Sweater", brand: "MANGO", devPhoto: 1, keywords: "winter", storeName: "MANGO", price: 2_999n, verifiedDiscountPct: 40, referencePrice: 4_999n, sponsored: false, inMySize: true, condition: "newWithTags", installments: true, creditOk: true, isNew: true, available: true },
  { id: "w3", department: "men", storeId: "s2", title: "Wool Blazer", brand: "ZARA", devPhoto: 2, keywords: "winter", storeName: "ZARA", price: 6_999n, verifiedDiscountPct: 30, referencePrice: 9_999n, sponsored: false, inMySize: true, condition: "newWithTags", installments: true, creditOk: true, isNew: false, available: true },
  { id: "w4", department: "women", storeId: "s2", title: "Belted Coat", brand: "MANGO", devPhoto: 3, keywords: "winter", storeName: "MANGO", price: 4_999n, verifiedDiscountPct: 50, referencePrice: 9_999n, sponsored: false, inMySize: true, condition: "newWithTags", installments: true, creditOk: true, isNew: false, available: false },
];

export class InMemorySearchPort implements SearchPort {
  readonly supportsDevFacets = true;
  constructor(private readonly rows: readonly FakeSearchRow[] = FIXTURE_SEARCH_ROWS, private failure: PortFailure | null = null) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private match(query: string, f: SearchFilter): readonly FakeSearchRow[] {
    if (this.failure !== null) throw new PortError(this.failure);
    const q = query.toLowerCase();
    return this.rows.filter((r) =>
      (q.length === 0 || r.title.toLowerCase().includes(q) || r.storeName.toLowerCase().includes(q) || (r.keywords ?? "").includes(q)) &&
      (f.newIn !== true || r.isNew === true) &&
      (f.newArrivals !== true || r.isNew === true) &&
      (f.freeDeliveryEligible !== true || r.freeDelivery === true) &&
      (f.lowest30dOnly !== true || r.lowest30d === true) &&
      (f.minVerifiedDiscountPct === undefined || (displayDiscountPct(r) ?? 0) >= f.minVerifiedDiscountPct) &&
      (f.inStock !== true || r.available !== false) &&
      (f.budgetMax === null || r.price <= f.budgetMax) &&
      (f.priceMin === undefined || r.price >= f.priceMin) &&
      (f.priceMax === undefined || r.price <= f.priceMax) &&
      (f.categoryIds === undefined || f.categoryIds.length === 0 || (r.categoryId !== undefined && f.categoryIds.includes(r.categoryId))) &&
      (f.department === undefined || departmentMatches(f.department, r.department ?? "unisex")) &&
      (!f.mySizeOnly || r.inMySize) &&
      (f.conditions.length === 0 || f.conditions.includes(r.condition)) &&
      (!f.verifiedDiscountOnly || displayDiscountPct(r) !== null) &&
      (!f.installmentsAvailable || r.installments) &&
      (!f.payableWithCredit || r.creditOk) &&
      (f.storeIds === undefined || f.storeIds.length === 0 || (r.storeId !== undefined && f.storeIds.includes(r.storeId))),
    );
  }
  async suggestGrouped(query: string): Promise<SuggestionInput> {
    return { queries: await this.suggest(query), stores: [], categories: [] };
  }
  async suggest(query: string): Promise<readonly string[]> {
    if (this.failure !== null) throw new PortError(this.failure);
    const q = normalizeQuery(query).toLowerCase();
    if (q.length === 0) return [];
    return this.rows.filter((r) => r.title.toLowerCase().includes(q)).map((r) => r.title).slice(0, 5);
  }
  /** Offset cursor ("o:<n>"), page size MAX_PAGE_SIZE, like the real paginated port; a bad cursor restarts at 0. */
  async search(query: string, filter: SearchFilter, cursor: string | null = null): Promise<SearchPage> {
    const all = this.match(query, filter);
    const m = cursor === null ? null : /^o:(\d{1,9})$/.exec(cursor);
    const start = m !== null ? Number(m[1]) : 0;
    const items = all.slice(start, start + MAX_PAGE_SIZE);
    const end = start + items.length;
    return { items, total: all.length, totalEstimate: all.length, nextCursor: end < all.length ? `o:${end}` : null };
  }
  async count(query: string, filter: SearchFilter): Promise<number> {
    return this.match(query, filter).length;
  }
}

/* ---- recent searches (device only, spec §4/§B1: never sent to the server) ---- */

export const RECENTS_KEY = "search.recents";
export const MAX_RECENTS = 8;

export function addRecent(list: readonly string[], raw: string): readonly string[] {
  const q = normalizeQuery(raw);
  if (q.length === 0) return list;
  return [q, ...list.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENTS);
}
export function encodeRecents(list: readonly string[]): string {
  return JSON.stringify(list);
}
export function decodeRecents(raw: string | null): readonly string[] {
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(normalizeQuery).filter((x) => x.length > 0).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}
