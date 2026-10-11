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
  readonly sponsored: boolean;
}

export interface SearchPage {
  readonly items: readonly SearchItem[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface SearchPort {
  suggest(query: string): Promise<readonly string[]>;
  search(query: string, filter: SearchFilter, cursor: string | null): Promise<SearchPage>;
  /** Live count for the filter sheet. */
  count(query: string, filter: SearchFilter): Promise<number>;
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
}

export const FIXTURE_SEARCH_ROWS: readonly FakeSearchRow[] = [
  { id: "p1", title: "White linen dress", storeName: "Delta Dresses", price: 120_000n, verifiedDiscountPct: 30, sponsored: false, inMySize: true, condition: "newWithTags", installments: true, creditOk: true },
  { id: "p2", title: "Straight jeans", storeName: "Cairo Denim", price: 119_000n, verifiedDiscountPct: null, sponsored: false, inMySize: true, condition: "newWithoutTags", installments: true, creditOk: true },
  { id: "p3", title: "Denim jacket", storeName: "Cairo Denim", price: 76_000n, verifiedDiscountPct: 12, sponsored: true, inMySize: false, condition: "sample", installments: false, creditOk: true },
  { id: "p4", title: "Running shorts", storeName: "Atlas Sport", price: 45_000n, verifiedDiscountPct: null, sponsored: false, inMySize: true, condition: "minorDefect", installments: false, creditOk: false },
];

export class InMemorySearchPort implements SearchPort {
  constructor(private readonly rows: readonly FakeSearchRow[] = FIXTURE_SEARCH_ROWS, private failure: PortFailure | null = null) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private match(query: string, f: SearchFilter): readonly FakeSearchRow[] {
    if (this.failure !== null) throw new PortError(this.failure);
    const q = query.toLowerCase();
    return this.rows.filter((r) =>
      (q.length === 0 || r.title.toLowerCase().includes(q) || r.storeName.toLowerCase().includes(q)) &&
      (f.budgetMax === null || r.price <= f.budgetMax) &&
      (!f.mySizeOnly || r.inMySize) &&
      (f.conditions.length === 0 || f.conditions.includes(r.condition)) &&
      (!f.verifiedDiscountOnly || displayDiscountPct(r) !== null) &&
      (!f.installmentsAvailable || r.installments) &&
      (!f.payableWithCredit || r.creditOk),
    );
  }
  async suggest(query: string): Promise<readonly string[]> {
    if (this.failure !== null) throw new PortError(this.failure);
    const q = normalizeQuery(query).toLowerCase();
    if (q.length === 0) return [];
    return this.rows.filter((r) => r.title.toLowerCase().includes(q)).map((r) => r.title).slice(0, 5);
  }
  async search(query: string, filter: SearchFilter): Promise<SearchPage> {
    const hits = this.match(query, filter).slice(0, MAX_PAGE_SIZE);
    return { items: hits, total: hits.length, nextCursor: null };
  }
  async count(query: string, filter: SearchFilter): Promise<number> {
    return this.match(query, filter).length;
  }
}
