import type { SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { analyzeQuery, canonicalTerm } from "@outlet/search-bakeoff";
import { DEFAULT_PAGE, MAX_PAGE, searchFilterSchema } from "./filters.js";
import type { SearchFilters } from "./filters.js";
import { InvalidCursorError, decodeCursor, encodeCursor, fingerprint } from "./cursor.js";
import { placeSponsored } from "./sponsored.js";
import type { Clock, SearchKillSwitchPort } from "./ports.js";

export class SearchUnavailableError extends Error {
  constructor() {
    super("search is switched off (search.fts_fallback.enabled)");
  }
}

export interface SearchItem {
  readonly productId: string;
  readonly storeRef: string;
  readonly titleAr: string;
  readonly titleEn: string;
  /** Index value: may lag by the staleness SLO. The PDP and bag re-check price and stock from Postgres. */
  readonly priceMinor: bigint;
  readonly currency: string;
  readonly conditionGrade: string;
  readonly sizes: readonly string[];
  readonly verifiedDiscount: boolean;
  readonly lowest30d: boolean;
  readonly inStock: boolean;
  readonly sponsored: boolean;
}

export interface SearchPage {
  readonly items: readonly SearchItem[];
  readonly nextCursor: string | null;
  readonly appliedFilter: SearchFilters;
  /** Filters dropped by zero-result relaxation, in the order dropped (empty when the exact query matched). */
  readonly relaxed: readonly RelaxStep[];
  readonly engineFallback: boolean;
}

export interface SearchOptions {
  readonly limit?: number;
  /** Sponsored candidates chosen by an (external) ads module. Re-run through the SAME filters; at most 2 are placed in the top 10, labelled. */
  readonly sponsoredIds?: readonly string[];
}

/**
 * Zero-result relaxation, least important first, cumulative, stopping at the first step that yields rows. First page only.
 * Order rationale: badges and grading are nice-to-haves, then scope (world, category, store), then fit (size), then money, and
 * last the free-text terms the lexicon could not resolve (typos / unseen words).
 */
export const RELAX_ORDER = ["lowest_30d", "verified_only", "condition", "world", "category", "store", "size", "price_min", "price_max", "budget", "unresolved_terms"] as const;
export type RelaxStep = (typeof RELAX_ORDER)[number];

interface State {
  filters: SearchFilters;
  budget: bigint | undefined;
  terms: string;
  unknown: string[];
  concepts: string;
}

const dropKey = (f: SearchFilters, ...keys: (keyof SearchFilters)[]): SearchFilters => {
  return Object.fromEntries(Object.entries(f).filter(([k]) => !(keys as string[]).includes(k)));
};

const applyStep = (s: State, step: RelaxStep): State | null => {
  const f = s.filters;
  switch (step) {
    case "lowest_30d": return f.lowest30d === true ? { ...s, filters: dropKey(f, "lowest30d") } : null;
    case "verified_only": return f.verifiedOnly === true ? { ...s, filters: dropKey(f, "verifiedOnly") } : null;
    case "condition": return f.conditionGrades !== undefined ? { ...s, filters: dropKey(f, "conditionGrades") } : null;
    case "world": return f.world !== undefined && f.world !== "both" ? { ...s, filters: dropKey(f, "world") } : null;
    case "category": return f.categoryIds !== undefined ? { ...s, filters: dropKey(f, "categoryIds") } : null;
    case "store": return f.storeIds !== undefined ? { ...s, filters: dropKey(f, "storeIds") } : null;
    case "size": return f.sizes !== undefined ? { ...s, filters: dropKey(f, "sizes") } : null;
    case "price_min": return f.priceMin !== undefined ? { ...s, filters: dropKey(f, "priceMin") } : null;
    case "price_max": return f.priceMax !== undefined ? { ...s, filters: dropKey(f, "priceMax") } : null;
    case "budget": return s.budget !== undefined ? { ...s, budget: undefined } : null;
    case "unresolved_terms": return s.unknown.length > 0 ? { ...s, unknown: [], terms: s.concepts } : null;
  }
};

interface Row {
  product_id: string;
  store_ref: string;
  title_ar: string;
  title_en: string;
  price_text: string;
  currency: string;
  condition_grade: string;
  sizes: string[];
  verified_discount: boolean;
  lowest_30d: boolean;
  in_stock: boolean;
  rank: number;
}

const COLS = "product_id, store_ref, title_ar, title_en, price_minor::text AS price_text, currency, condition_grade, sizes, verified_discount, lowest_30d, in_stock";

export interface SearchDeps {
  readonly client: SqlClient;
  readonly marketId: string;
  readonly killSwitch: SearchKillSwitchPort;
  readonly clock?: Clock;
  readonly newId?: () => string;
}

/** Postgres FTS search (ADR-0010 fallback; engine still undecided). Pure SQL over search_documents: P0 published rows only. */
export class SearchService {
  private readonly outbox = new OutboxWriter(pgTransactionalWriter);
  constructor(private readonly deps: SearchDeps) {}

  async search(q: string, filtersIn: SearchFilters, cursor?: string, options: SearchOptions = {}): Promise<SearchPage> {
    if (await this.killed(() => this.deps.killSwitch.isFtsKilled())) throw new SearchUnavailableError();
    const filters = searchFilterSchema.parse(filtersIn);
    const limit = Math.min(options.limit ?? DEFAULT_PAGE, MAX_PAGE);
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    const a = analyzeQuery(q.slice(0, 200));
    const concepts = a.concepts.map(canonicalTerm).join(" ");
    const state0: State = { filters, budget: a.maxPriceMinor, terms: a.engineQuery, unknown: [...a.unknown], concepts };
    const fp = fingerprint({ m: this.deps.marketId, q: a.engineQuery, b: a.maxPriceMinor, f: filters });
    const pos = cursor === undefined ? undefined : decodeCursor(cursor, fp);

    let state = state0;
    const relaxed: RelaxStep[] = [];
    for (const step of pos?.relaxed ?? []) {
      const next = RELAX_ORDER.includes(step as RelaxStep) ? applyStep(state, step as RelaxStep) : null;
      if (next === null) throw new InvalidCursorError();
      state = next;
      relaxed.push(step as RelaxStep);
    }
    let rows = await this.run(state, limit, pos);
    if (rows.length === 0 && pos === undefined) {
      for (const step of RELAX_ORDER) {
        const next = applyStep(state, step);
        if (next === null) continue;
        state = next;
        relaxed.push(step);
        rows = await this.run(state, limit, undefined);
        if (rows.length > 0) break;
      }
      await this.logNoResult(a.concepts, a.unknown, filters, a.maxPriceMinor !== undefined);
    }
    const more = rows.length > limit;
    const slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    let items = slice.map((r) => toItem(r, false));
    if (pos === undefined && options.sponsoredIds !== undefined && options.sponsoredIds.length > 0) {
      const sp = await this.run(state, MAX_PAGE, undefined, options.sponsoredIds);
      items = placeSponsored(items, sp.slice(0, 2).map((r) => toItem(r, true)));
    }
    return {
      items,
      nextCursor: more && last !== undefined ? encodeCursor({ rank: last.rank, id: last.product_id, relaxed }, fp) : null,
      appliedFilter: effective(state),
      relaxed,
      engineFallback: true,
    };
  }

  private async killed(f: () => Promise<boolean>): Promise<boolean> {
    try {
      return await f();
    } catch {
      return false;
    }
  }

  private async run(s: State, limit: number, pos: { rank: number; id: string } | undefined, only?: readonly string[]): Promise<Row[]> {
    const params: unknown[] = [this.deps.marketId];
    const add = (v: unknown): string => {
      params.push(v);
      return `$${String(params.length)}`;
    };
    const where = ["market_id = $1", "is_published"];
    const f = s.filters;
    let rank = "0::float8";
    if (s.terms.length > 0) {
      const p = add(s.terms);
      where.push(`tsv @@ plainto_tsquery('arabic_simple', ${p})`);
      rank = `ts_rank(tsv, plainto_tsquery('arabic_simple', ${p}))::float8`;
    }
    const maxes = [s.budget, f.priceMax].filter((v): v is bigint => v !== undefined);
    if (maxes.length > 0) where.push(`price_minor <= ${add(maxes.reduce((x, y) => (y < x ? y : x)).toString())}::bigint`);
    if (f.priceMin !== undefined) where.push(`price_minor >= ${add(f.priceMin.toString())}::bigint`);
    if (f.categoryIds !== undefined) where.push(`category_id = ANY(${add(f.categoryIds)}::uuid[])`);
    if (f.storeIds !== undefined) where.push(`store_ref = ANY(${add(f.storeIds)}::uuid[])`);
    if (f.conditionGrades !== undefined) where.push(`condition_grade = ANY(${add(f.conditionGrades)}::text[])`);
    if (f.sizes !== undefined) where.push(`sizes && ${add(f.sizes.map((x) => x.trim().toLowerCase()))}::text[]`);
    if (f.world === "local" || f.world === "global") where.push(`world = ${add(f.world)}`);
    if (f.verifiedOnly === true) where.push("verified_discount");
    if (f.lowest30d === true) where.push("lowest_30d");
    if (f.inStockOnly === true) where.push("in_stock");
    if (only !== undefined) where.push(`product_id = ANY(${add([...only])}::uuid[])`);
    let outer = "";
    if (pos !== undefined) outer = `WHERE (rank < ${add(pos.rank)}::float8 OR (rank = ${add(pos.rank)}::float8 AND product_id > ${add(pos.id)}::uuid))`;
    const sql = `SELECT * FROM (SELECT ${COLS}, ${rank} AS rank FROM search_documents WHERE ${where.join(" AND ")}) t ${outer} ORDER BY rank DESC, product_id ASC LIMIT ${String(limit + 1)}`;
    return (await this.deps.client.query<Row>(sql, params)).rows;
  }

  /** Demand-gap signal via the outbox (analytics event `search_no_result`). No raw query text, no user id: only resolved concept ids and unresolved tokens. */
  private async logNoResult(concepts: readonly string[], unknown: readonly string[], filters: SearchFilters, hadBudget: boolean): Promise<void> {
    try {
      const now = (this.deps.clock ?? { now: () => new Date() }).now();
      await this.deps.client.transaction(async (tx) => {
        await this.outbox.append(tx, {
          id: (this.deps.newId ?? uuidv7)(), type: "search.no_result", aggregateType: "search", aggregateId: (this.deps.newId ?? uuidv7)(), marketId: this.deps.marketId,
          occurredAt: now.toISOString(), visibility: "internal",
          payload: {
            analytics_event: "search_no_result", concepts: [...concepts].slice(0, 10), unresolved_terms: unknown.map((u) => u.slice(0, 40)).slice(0, 10),
            filter_keys: Object.keys(filters).sort(), had_budget: hadBudget,
          },
        });
      });
    } catch {
      // Analytics must never fail a search.
    }
  }
}

const toItem = (r: Row, sponsored: boolean): SearchItem => ({
  productId: r.product_id, storeRef: r.store_ref, titleAr: r.title_ar, titleEn: r.title_en, priceMinor: BigInt(r.price_text), currency: r.currency,
  conditionGrade: r.condition_grade, sizes: r.sizes, verifiedDiscount: r.verified_discount, lowest30d: r.lowest_30d, inStock: r.in_stock, sponsored,
});

const effective = (s: State): SearchFilters => {
  if (s.budget === undefined) return s.filters;
  const max = s.filters.priceMax === undefined || s.budget < s.filters.priceMax ? s.budget : s.filters.priceMax;
  return { ...s.filters, priceMax: max };
};
