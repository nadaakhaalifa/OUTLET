import type { SuggestionFacts } from "../../cart";
import type { Condition, Department, Money, SearchFilter } from "./bridge";

export type LocalizedText = SuggestionFacts["title"];
export type StoreSummaryFacts = SuggestionFacts["store"];
export type PriceBadge = SuggestionFacts["badge"];

// ---- index -------------------------------------------------------------------------------------

/** One row of the search read model. Price and stock here only pre-filter and rank. */
export interface IndexedProduct {
  readonly productId: string;
  readonly storeId: string;
  readonly world: "local" | "global";
  readonly titleAr: string;
  readonly titleEn: string | null;
  /** Normalized listing text (title, brand, keywords). The writer normalizes; adapters do not trust it. */
  readonly searchText: string;
  readonly priceAmount: bigint;
  readonly colors: readonly string[];
  readonly materials: readonly string[];
  readonly condition: Condition;
  /** Shopper department; absent is read as `unisex` (documents indexed before the attribute existed). */
  readonly department?: Department;
  readonly categoryIds: readonly string[];
  /** Catalog brand (products.brand_id). Absent or null for a product without a brand; such a document never matches a brand filter. */
  readonly brandId?: string | null;
  readonly verifiedDiscountPct: number | null;
  readonly lowest30d: boolean;
  readonly freeDeliveryEligible: boolean;
  readonly rating: number | null;
  readonly sponsored: boolean;
  readonly inStock: boolean;
  readonly listedAtMs: number;
}

/** Server-side orderings (allow-list). Every ordering ends in (listed_at desc, product_id) so paging is deterministic. */
export const SEARCH_SORTS = ["relevance", "newest", "price_asc", "price_desc", "biggest_verified_discount"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
export const DEFAULT_SEARCH_SORT: SearchSort = "relevance";

/** Facets that can be counted, and the bucket cap per facet. */
export const FACET_COUNT_FACETS = ["categories", "stores"] as const;
export type FacetCountFacet = (typeof FACET_COUNT_FACETS)[number];
export const MAX_FACET_BUCKETS = 50;

export interface FacetBucket {
  readonly id: string;
  readonly count: number;
}

export interface SearchRequest {
  /** Canonical keyword remainder (concept ids and raw tokens). May be empty. */
  readonly keywords: string;
  readonly filter: SearchFilter;
  /** Store scope resolved from My Stores; null means unrestricted. */
  readonly storeScope: readonly string[] | null;
  readonly limit: number;
  readonly offset: number;
  readonly nowMs: number;
  /** Absent reads as relevance. */
  readonly sort?: SearchSort;
}

export interface SearchHit {
  readonly productId: string;
  readonly sponsored: boolean;
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];
  /** Estimate of the matching rows ignoring paging. */
  readonly total: number;
  readonly degraded: boolean;
}

export class SearchUnavailableError extends Error {
  constructor(readonly engine: string) {
    super(`search engine unavailable: ${engine}`);
    this.name = "SearchUnavailableError";
  }
}

/** Contract: `hits` are ordered best first, in_stock only, already filtered by `filter` and `storeScope`. */
export interface SearchPort {
  readonly engine: "typesense" | "postgres_fts" | "in_memory";
  search(req: SearchRequest): Promise<SearchPage>;
  /** Prefix suggestions of listing titles, normalized input. */
  suggest(prefixNormalized: string, limit: number): Promise<readonly string[]>;
  /**
   * Optional exact counts of the documents matching `req` (filter, scope and keywords as given; sort,
   * limit and offset ignored), grouped by category or store, at most `cap` buckets ordered by count desc then
   * id asc. A document with several categories counts once in each. Engines that cannot count exactly omit it.
   */
  facetCounts?(req: SearchRequest, facet: FacetCountFacet, cap: number): Promise<readonly FacetBucket[]>;
}

/** Written by outbox consumers (system). Idempotent upsert keyed by product id. */
export interface SearchIndexWriter {
  upsert(doc: IndexedProduct): Promise<void>;
  remove(productId: string): Promise<void>;
}

// ---- catalog listing read port ----------------------------------------------------------------

/**
 * Narrow structural view of the catalog's listing snapshot (the catalog's `ListingSnapshotReader` satisfies it
 * as is). Declared here so search never imports the catalog module: the catalog already depends on search
 * through inventory and llm-gateway, and a direct import would close a cycle.
 */
export type ListingSnapshot =
  | { readonly listed: false; readonly productId: string; readonly storeId: string; readonly version: number }
  | {
      readonly listed: true;
      readonly productId: string;
      readonly storeId: string;
      readonly version: number;
      readonly createdAtMs: number;
      readonly publishedAtMs: number | null;
      readonly title: LocalizedText;
      readonly categoryId: string;
      readonly brandId: string | null;
      /** Only when the brand row exists. */
      readonly brand: { readonly id: string; readonly nameAr: string; readonly nameEn?: string } | null;
      readonly condition: Condition;
      readonly department: Department;
      readonly material: string | null;
      readonly storeKind: "local" | "global";
      readonly storeOpen: boolean;
      readonly imageUrl: string | null;
      readonly blurhash: string | null;
      readonly skus: readonly {
        readonly id: string;
        readonly price: Money;
        readonly available: boolean;
        readonly color: string | null;
        readonly priceBlock: {
          readonly badge: PriceBadge;
          readonly referencePrice: Money | null;
          readonly discountPct: number | null;
          readonly claimId: string | null;
        };
      }[];
    };

export interface ListingSnapshotPort {
  snapshot(productId: string): Promise<ListingSnapshot | null>;
}

// ---- index sync (outbox consumer) -------------------------------------------------------------

/** Current catalog state of one product, mapped to the read-model row. `version` is the catalog row version. */
export type IndexSource =
  | { readonly kind: "absent" }
  | { readonly kind: "unlisted"; readonly version: number }
  | { readonly kind: "listed"; readonly version: number; readonly doc: IndexedProduct };

/** Reads the product from its owner (catalog public surface). Never the index. */
export interface IndexSourcePort {
  load(productId: string): Promise<IndexSource>;
}

export type SearchSyncOutcome = "indexed" | "removed" | "stale_retry" | "invalid";

export interface SearchSyncMetrics {
  record(outcome: SearchSyncOutcome, lagSeconds: number | null): void;
}

/** The catalog row is older than the event that triggered the sync (lagging read): retry later. */
export class StaleIndexSourceError extends Error {
  constructor(
    readonly productId: string,
    readonly eventVersion: number,
    readonly sourceVersion: number,
  ) {
    super(`catalog read is behind the event for ${productId}: v${sourceVersion} < v${eventVersion}`);
    this.name = "StaleIndexSourceError";
  }
}

// ---- live facts (price and stock re-check) -------------------------------------------------------

export interface ProductFacts {
  readonly productId: string;
  readonly title: LocalizedText;
  readonly store: StoreSummaryFacts;
  readonly imageUrl?: string;
  readonly blurhash?: string;
  /** Live price, VAT inclusive, after item discounts. */
  readonly unitPrice: Money;
  readonly badge: PriceBadge;
  readonly referencePrice: Money | null;
  readonly discountPct: number | null;
  readonly condition: Condition;
  /** Absent when the catalog did not report it; the wire then omits the field. */
  readonly department?: Department;
  /** Catalog brand; absent when the product has none or the facts provider does not report it. */
  readonly brand?: { readonly id: string; readonly name: LocalizedText };
  readonly sponsored: boolean;
  /** True only when in stock, listed and the store is open. */
  readonly purchasable: boolean;
  /** Optional enrichments owned by other modules. A filter that needs one fails closed when absent. */
  readonly installmentsAvailable?: boolean;
  readonly codAvailable?: boolean;
  readonly payableWithStoreCredit?: boolean;
  readonly inMySize?: boolean;
  readonly freeDeliveryEligible?: boolean;
  readonly fitsRemainingBudget?: boolean;
}

export class ProductFactsUnavailableError extends Error {
  constructor() {
    super("catalog facts unavailable");
    this.name = "ProductFactsUnavailableError";
  }
}

/** Reads live price/stock from the catalog and inventory modules. Absent ids are gone or hidden. */
export interface ProductFactsPort {
  products(productIds: readonly string[], viewerUserId: string): Promise<ReadonlyMap<string, ProductFacts>>;
}

/** Store card facts for result rows. Owned by the stores module; a store that is not shopper-visible is absent. */
export interface StoreSummaryPort {
  summaries(storeIds: readonly string[], viewerUserId: string): Promise<ReadonlyMap<string, StoreSummaryFacts>>;
}

export interface ShopperScopePort {
  favoriteStoreIds(userId: string): Promise<readonly string[]>;
}

export interface SuggestionDirectoryPort {
  stores(prefixNormalized: string, limit: number, viewerUserId: string): Promise<readonly StoreSummaryFacts[]>;
  categories(prefixNormalized: string, limit: number): Promise<readonly { readonly id: string; readonly name: LocalizedText }[]>;
}

export interface SearchKillSwitchPort {
  /** True when Typesense must not be used (ops kill switch); the Postgres fallback serves. */
  typesenseDisabled(): Promise<boolean>;
}

/** The only LLM seam. Output is untrusted; callers validate it with the SearchFilter schema. */
export interface LlmGatewayPort {
  refineSearchParse(input: { readonly text: string; readonly locale: "ar" | "en" }): Promise<unknown | null>;
}

export class LlmUnavailableError extends Error {
  constructor() {
    super("llm unavailable");
    this.name = "LlmUnavailableError";
  }
}

// ---- saved searches ----------------------------------------------------------------------------

export interface SavedSearchRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly query: string | null;
  readonly filter: SearchFilter;
  readonly alertEnabled: boolean;
  readonly lastRunAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface SavedSearchPatch {
  readonly name?: string;
  readonly alertEnabled?: boolean;
  readonly filter?: SearchFilter;
}

export interface SavedSearchCursor {
  readonly createdAtMs: number;
  readonly id: string;
}

export const MAX_SAVED_SEARCHES = 50;

/** Every method is scoped by userId: a record owned by someone else behaves exactly like a missing one. */
export interface SavedSearchRepository {
  list(userId: string, limit: number, after: SavedSearchCursor | null): Promise<readonly SavedSearchRecord[]>;
  get(userId: string, id: string): Promise<SavedSearchRecord | null>;
  count(userId: string): Promise<number>;
  create(record: SavedSearchRecord): Promise<void>;
  update(userId: string, id: string, patch: SavedSearchPatch, nowMs: number): Promise<SavedSearchRecord | null>;
  delete(userId: string, id: string): Promise<boolean>;
}

// ---- events ------------------------------------------------------------------------------------

export type SearchEvent =
  | { readonly name: "search_performed"; readonly resultCount: number; readonly degraded: boolean; readonly relaxed: boolean }
  | { readonly name: "search_no_result"; readonly locale: "ar" | "en"; readonly normalizedQuery: string }
  | { readonly name: "saved_search.created"; readonly userId: string; readonly id: string }
  | { readonly name: "saved_search.deleted"; readonly userId: string; readonly id: string };

export interface SearchEventPublisher {
  publish(event: SearchEvent): Promise<void>;
}
