import { sha256Hex } from "@outlet/idempotency";
import type { Clock } from "../../../platform/ports";
import {
  DEFAULT_PAGE_SIZE,
  MAX_FACETS,
  MAX_PAGE_SIZE,
  MAX_RELAXATION_STEPS,
  canonicalizeFilter,
  countFacets,
  didYouMean,
  isEmptyFilter,
  normalizeSearchText,
  parseSearchQuery,
  relaxOnce,
  SPONSORED_MAX_DEFERRED,
  SponsoredRanker,
  type Money,
  type SearchFilter,
} from "../domain/bridge";
import {
  LlmUnavailableError,
  ProductFactsUnavailableError,
  SearchUnavailableError,
  DEFAULT_SEARCH_SORT,
  MAX_FACET_BUCKETS,
  type FacetBucket,
  type LlmGatewayPort,
  type ProductFacts,
  type ProductFactsPort,
  type SearchEventPublisher,
  type SearchKillSwitchPort,
  type SearchPort,
  type SearchSort,
  type ShopperScopePort,
  type SuggestionDirectoryPort,
} from "../domain/ports";
import { SearchFilterSchema } from "../domain/schema";

export class CatalogUnavailableError extends Error {
  constructor() {
    super("catalog unavailable");
    this.name = "CatalogUnavailableError";
  }
}
export class SearchEnginesUnavailableError extends Error {
  constructor() {
    super("no search engine available");
    this.name = "SearchEnginesUnavailableError";
  }
}
export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}
export class TooManyFacetsError extends Error {
  constructor(readonly count: number) {
    super(`too many facets: ${count}`);
    this.name = "TooManyFacetsError";
  }
}

export interface SearchDeps {
  readonly primary: SearchPort;
  readonly fallback: SearchPort;
  readonly killSwitch: SearchKillSwitchPort;
  readonly facts: ProductFactsPort;
  readonly scope: ShopperScopePort;
  readonly events: SearchEventPublisher;
  readonly clock: Clock;
}

export interface SearchInput {
  readonly userId: string;
  readonly q: string;
  readonly filter: SearchFilter;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: SearchSort;
  readonly locale?: "ar" | "en";
}

export interface SearchItem {
  readonly facts: ProductFacts;
  readonly sponsored: boolean;
}

export interface SearchOutcome {
  readonly items: readonly SearchItem[];
  readonly nextCursor: string | null;
  readonly totalEstimate: number;
  readonly appliedFilter: SearchFilter;
  readonly relaxedFilters: readonly string[];
  readonly didYouMean: string | null;
  readonly degraded: boolean;
  /** Exact index-level counts; undefined when unavailable (degraded engine, later page, live-only filter, engine failure). */
  readonly facetCounts?: { readonly categories: readonly FacetBucket[]; readonly stores: readonly FacetBucket[] };
}

/** Filters judged on live facts owned by other modules; index counts cannot honour them, so counts are omitted. */
const LIVE_ONLY_FILTERS = ["installmentsAvailable", "monthlyMax", "codAvailable", "payableWithStoreCredit", "mySizeOnly", "fitsRemainingBudget"] as const;

const KEY_TO_WIRE: Readonly<Record<string, string>> = {
  newArrivals: "new_arrivals",
  lowest30dOnly: "lowest_30d_only",
  minRating: "min_rating",
  materials: "materials",
  colors: "colors",
  freeDeliveryEligible: "free_delivery_eligible",
  conditions: "conditions",
  minVerifiedDiscountPct: "min_verified_discount_pct",
  verifiedDiscountOnly: "verified_discount_only",
  installmentsAvailable: "installments_available",
  monthlyMax: "monthly_max",
  codAvailable: "cod_available",
  payableWithStoreCredit: "payable_with_store_credit",
  priceMin: "price_min",
  categoryIds: "category_ids",
};

const jsonSafe = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x))) as unknown;

function fingerprint(keywords: string, filter: SearchFilter, sort: SearchSort = DEFAULT_SEARCH_SORT): string {
  // The default sort keeps the historical fingerprint, so cursors issued before `sort` existed stay valid.
  const base = { k: keywords, f: canonicalizeFilter(filter) };
  return sha256Hex(JSON.stringify(jsonSafe(sort === DEFAULT_SEARCH_SORT ? base : { ...base, s: sort }))).slice(0, 16);
}

/** Resumable paging state: engine offset, global rank state and demoted sponsored product ids. */
export interface CursorState {
  readonly offset: number;
  readonly emitted: number;
  readonly sponsoredTop: number;
  readonly deferredIds: readonly string[];
}

const SPONSORED_MAX_IN_WINDOW_CAP = 10;
const MAX_CURSOR_OFFSET = 1_000_000;
const MAX_ID_LENGTH = 64;

export function encodeCursor(s: CursorState, fp: string): string {
  return Buffer.from(
    JSON.stringify({ o: s.offset, h: fp, e: s.emitted, s: s.sponsoredTop, d: s.deferredIds }),
    "utf8",
  ).toString("base64url");
}

const isCount = (n: unknown, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;

export function decodeCursor(cursor: string, fp: string): CursorState {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const r = v as Record<string, unknown>;
      const { o, h, e, s, d } = r;
      if (isCount(o, MAX_CURSOR_OFFSET) && h === fp) {
        const emitted = e === undefined ? o : e;
        const sponsoredTop = s === undefined ? 0 : s;
        const ids = d === undefined ? [] : d;
        if (
          isCount(emitted, MAX_CURSOR_OFFSET) &&
          isCount(sponsoredTop, SPONSORED_MAX_IN_WINDOW_CAP) &&
          sponsoredTop <= emitted &&
          Array.isArray(ids) &&
          ids.length <= SPONSORED_MAX_DEFERRED &&
          ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_ID_LENGTH)
        ) {
          return { offset: o, emitted, sponsoredTop, deferredIds: ids as string[] };
        }
      }
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError();
}

/** Merge text-derived constraints under the explicit filter: explicit values win. */
export function mergeFilters(fromText: SearchFilter, explicit: SearchFilter): SearchFilter {
  return canonicalizeFilter({ ...fromText, ...explicit });
}

const priceOk = (f: SearchFilter, p: Money): boolean =>
  (f.priceMin === undefined || p.amount >= f.priceMin) &&
  (f.priceMax === undefined || p.amount <= f.priceMax) &&
  (f.budgetMax === undefined || p.amount <= f.budgetMax);

/**
 * Live-facts gate. Every claim is judged on the re-read facts, never on the index values.
 * Filters whose data belongs to another module fail closed when the fact is absent.
 */
export function passesLiveFacets(f: SearchFilter, facts: ProductFacts): boolean {
  if (!facts.purchasable) return false;
  if (!priceOk(f, facts.unitPrice)) return false;
  const verified = facts.badge === "verified_discount" && facts.referencePrice !== null && facts.discountPct !== null;
  if (f.verifiedDiscountOnly === true && !verified) return false;
  if (f.minVerifiedDiscountPct !== undefined && !(verified && (facts.discountPct ?? 0) >= f.minVerifiedDiscountPct)) return false;
  if (f.lowest30dOnly === true && facts.badge !== "lowest_30d" && !verified) return false;
  if (f.installmentsAvailable === true && facts.installmentsAvailable !== true) return false;
  if (f.codAvailable === true && facts.codAvailable !== true) return false;
  if (f.payableWithStoreCredit === true && facts.payableWithStoreCredit !== true) return false;
  if (f.mySizeOnly === true && facts.inMySize !== true) return false;
  if (f.fitsRemainingBudget === true && facts.fitsRemainingBudget !== true) return false;
  return true;
}

export class SearchProducts {
  constructor(private readonly d: SearchDeps) {}

  async execute(input: SearchInput): Promise<SearchOutcome> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const parsed = parseSearchQuery(input.q);
    const merged = mergeFilters(parsed.filter, input.filter);
    const facetCount = countFacets(merged);
    if (facetCount > MAX_FACETS) throw new TooManyFacetsError(facetCount);

    const sort = input.sort ?? DEFAULT_SEARCH_SORT;
    const fp = fingerprint(parsed.keywords, merged, sort);
    const start: CursorState =
      input.cursor === undefined
        ? { offset: 0, emitted: 0, sponsoredTop: 0, deferredIds: [] }
        : decodeCursor(input.cursor, fp);
    const offset = start.offset;
    const first = await this.page(input.userId, parsed.keywords, merged, limit, start, sort);
    let result = first;
    let applied = merged;
    const relaxed: string[] = [];

    if (first.items.length === 0 && offset === 0) {
      let current = merged;
      for (let step = 0; step < MAX_RELAXATION_STEPS; step += 1) {
        const r = relaxOnce(current);
        if (r === null) break;
        current = r.filter;
        relaxed.push(KEY_TO_WIRE[r.dropped] ?? r.dropped);
        const next = await this.page(input.userId, parsed.keywords, current, limit, { offset: 0, emitted: 0, sponsoredTop: 0, deferredIds: [] }, sort);
        if (next.items.length > 0) {
          result = next;
          applied = current;
          break;
        }
      }
      if (result.items.length === 0) relaxed.length = 0;
    }

    const empty = result.items.length === 0;
    const suggestion = empty ? didYouMean(parsed.normalized) : null;
    if (empty && offset === 0) {
      await this.d.events.publish({
        name: "search_no_result",
        locale: input.locale ?? "ar",
        normalizedQuery: normalizeSearchText(input.q).slice(0, 300),
      });
    } else {
      await this.d.events.publish({
        name: "search_performed",
        resultCount: result.items.length,
        degraded: result.degraded,
        relaxed: relaxed.length > 0,
      });
    }
    const nextFp = fingerprint(parsed.keywords, applied, sort);
    const counts = input.cursor === undefined && !result.degraded ? await this.facetCounts(input.userId, parsed.keywords, applied, result.engine) : undefined;
    return {
      items: result.items,
      nextCursor: result.next === null ? null : encodeCursor(result.next, nextFp),
      totalEstimate: result.total,
      appliedFilter: applied,
      relaxedFilters: relaxed,
      didYouMean: suggestion,
      degraded: result.degraded,
      ...(counts !== undefined ? { facetCounts: counts } : {}),
    };
  }

  /**
   * Counts per facet with that facet's own selection removed, so the shopper sees what each option would
   * return. Index-level and exact for index-level filters; any failure just omits the field.
   */
  private async facetCounts(userId: string, keywords: string, filter: SearchFilter, port: SearchPort | null) {
    if (port === null || port.facetCounts === undefined) return undefined;
    if (LIVE_ONLY_FILTERS.some((k) => filter[k] !== undefined)) return undefined;
    try {
      const storeScope = filter.world === "my_stores" ? await this.d.scope.favoriteStoreIds(userId) : null;
      const now = this.d.clock.nowMs();
      const base = { keywords, storeScope, limit: 0, offset: 0, nowMs: now };
      const { categoryIds: _c, ...withoutCategories } = filter;
      const { storeIds: _s, ...withoutStores } = filter;
      const [categories, stores] = await Promise.all([
        port.facetCounts({ ...base, filter: withoutCategories }, "categories", MAX_FACET_BUCKETS),
        port.facetCounts({ ...base, filter: withoutStores }, "stores", MAX_FACET_BUCKETS),
      ]);
      return { categories, stores };
    } catch (e) {
      if (e instanceof SearchUnavailableError) return undefined;
      throw e;
    }
  }

  private async engine(req: Parameters<SearchPort["search"]>[0]) {
    let useFallback: boolean;
    try {
      useFallback = await this.d.killSwitch.typesenseDisabled();
    } catch {
      useFallback = true;
    }
    if (!useFallback) {
      try {
        const p = await this.d.primary.search(req);
        return { ...p, degraded: false, port: this.d.primary as SearchPort | null };
      } catch (e) {
        if (!(e instanceof SearchUnavailableError)) throw e;
      }
    }
    try {
      const p = await this.d.fallback.search(req);
      return { ...p, degraded: true, port: null as SearchPort | null };
    } catch (e) {
      if (e instanceof SearchUnavailableError) throw new SearchEnginesUnavailableError();
      throw e;
    }
  }

  private async page(userId: string, keywords: string, filter: SearchFilter, limit: number, start: CursorState, sort: SearchSort) {
    const now = this.d.clock.nowMs();
    let storeScope: readonly string[] | null = null;
    if (filter.world === "my_stores") storeScope = await this.d.scope.favoriteStoreIds(userId);

    const toItem = (f: ProductFacts, hitSponsored: boolean): SearchItem => ({
      facts: f,
      sponsored: f.sponsored || hitSponsored,
    });
    const loadFacts = async (ids: readonly string[]): Promise<ReadonlyMap<string, ProductFacts>> => {
      try {
        return await this.d.facts.products(ids, userId);
      } catch (e) {
        if (e instanceof ProductFactsUnavailableError) throw new CatalogUnavailableError();
        throw e;
      }
    };

    // Rehydrate demoted sponsored items carried by the cursor; anything that no longer passes is dropped.
    const carried: SearchItem[] = [];
    if (start.deferredIds.length > 0) {
      const cf = await loadFacts(start.deferredIds);
      for (const id of start.deferredIds) {
        const f = cf.get(id);
        if (f !== undefined && passesLiveFacets(filter, f)) carried.push({ facts: f, sponsored: true });
      }
    }
    const ranker = new SponsoredRanker<SearchItem>(
      { emitted: start.emitted, sponsoredTop: start.sponsoredTop },
      carried,
    );

    const collected: SearchItem[] = [];
    let position = start.offset;
    let total = 0;
    let degraded = false;
    let port: SearchPort | null = null;
    let exhausted = false;
    const chunk = Math.min(limit * 2, MAX_PAGE_SIZE * 2);
    const drain = (): void => {
      while (collected.length < limit) {
        const d = ranker.nextDeferred();
        if (d === null) return;
        collected.push(d);
      }
    };
    drain();
    for (let round = 0; round < 4 && collected.length < limit && !exhausted; round += 1) {
      const p = await this.engine({ keywords, filter, storeScope, limit: chunk, offset: position, nowMs: now, sort });
      total = p.total;
      degraded = p.degraded;
      port = p.port;
      if (p.hits.length === 0) {
        exhausted = true;
        break;
      }
      const facts = await loadFacts(p.hits.map((h) => h.productId));
      for (const hit of p.hits) {
        position += 1;
        const f = facts.get(hit.productId);
        if (f === undefined || !passesLiveFacets(filter, f)) continue;
        const emitted = ranker.offer(toItem(f, hit.sponsored));
        if (emitted !== null) collected.push(emitted);
        drain();
        if (collected.length >= limit) break;
      }
      if (p.hits.length < chunk) exhausted = true;
    }
    const pendingDeferred = ranker.hasReadyDeferred;
    const hasMore = !exhausted || position < total || pendingDeferred;
    const more = hasMore && (collected.length > 0 || pendingDeferred);
    const next: CursorState | null = more
      ? {
          offset: position,
          emitted: ranker.state.emitted,
          sponsoredTop: ranker.state.sponsoredTop,
          deferredIds: ranker.deferred.map((i) => i.facts.productId),
        }
      : null;
    return { items: collected, next, total, degraded, engine: port };
  }
}

export class SuggestQueries {
  constructor(
    private readonly d: { readonly index: SearchPort; readonly directory: SuggestionDirectoryPort },
  ) {}

  async execute(input: { readonly userId: string; readonly q: string }) {
    const prefix = normalizeSearchText(input.q).slice(0, 100);
    if (prefix.length === 0) return { queries: [], stores: [], categories: [] };
    const [queries, stores, categories] = await Promise.all([
      this.d.index.suggest(prefix, 8).catch((e: unknown) => {
        if (e instanceof SearchUnavailableError) return [] as readonly string[];
        throw e;
      }),
      this.d.directory.stores(prefix, 5, input.userId),
      this.d.directory.categories(prefix, 5),
    ]);
    return { queries, stores, categories };
  }
}

export interface ParseOutcome {
  readonly filter: SearchFilter;
  readonly keywords: string;
  readonly unparsed: readonly string[];
}

/**
 * Rule-based parse first. When fragments remain unparsed an optional LlmGatewayPort may refine;
 * its output is untrusted and must validate against SearchFilterSchema, otherwise it is ignored.
 */
export class ParseSearchQuery {
  constructor(private readonly d: { readonly llm: LlmGatewayPort | null }) {}

  async execute(input: { readonly text: string; readonly locale?: "ar" | "en" }): Promise<ParseOutcome> {
    const p = parseSearchQuery(input.text);
    if (p.unparsed.length === 0 || this.d.llm === null) {
      return { filter: p.filter, keywords: p.keywords, unparsed: p.unparsed };
    }
    try {
      const raw = await this.d.llm.refineSearchParse({ text: input.text, locale: input.locale ?? "ar" });
      if (raw === null) return { filter: p.filter, keywords: p.keywords, unparsed: p.unparsed };
      const v = SearchFilterSchema.safeParse(raw);
      if (!v.success) return { filter: p.filter, keywords: p.keywords, unparsed: p.unparsed };
      const filter = mergeFilters(v.data, p.filter);
      return countFacets(filter) > MAX_FACETS
        ? { filter: p.filter, keywords: p.keywords, unparsed: p.unparsed }
        : { filter, keywords: p.keywords, unparsed: p.unparsed };
    } catch (e) {
      if (e instanceof LlmUnavailableError) return { filter: p.filter, keywords: p.keywords, unparsed: p.unparsed };
      throw e;
    }
  }
}

export { isEmptyFilter };
