/** One interface for every engine under test (ADR-0010). Documents are P0 public catalog fields only. */

export interface SearchDoc {
  readonly id: string;
  readonly titleAr: string;
  readonly titleEn: string;
  readonly category: string;
  readonly color: string;
  readonly material: string;
  readonly audience: string;
  readonly brand: string;
  /** Piastres. Plain number here because engines index JSON; bake-off fixtures stay far below 2^53. */
  readonly priceMinor: number;
  readonly inStock: boolean;
  /** Normalised titles plus every AR/EN/Franco synonym of the doc's concepts (see buildSearchText). */
  readonly searchText: string;
}

export interface SearchFilters {
  readonly maxPriceMinor?: number;
  readonly category?: string;
  readonly brand?: string;
  readonly inStockOnly?: boolean;
}

export interface SearchHit {
  readonly id: string;
  readonly score: number;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
}

export interface SearchEnginePort {
  readonly name: string;
  /** Replaces the whole index with `docs`. */
  index(docs: readonly SearchDoc[]): Promise<void>;
  search(q: string, filters: SearchFilters, limit?: number): Promise<SearchResult>;
  health(): Promise<boolean>;
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;
