import type { PriceInput } from "@outlet/ui-web";

export interface StoreSummary {
  readonly slug: string;
  readonly name: string;
  readonly category: string;
}

export interface ProductDetail {
  readonly id: string;
  readonly name: string;
  readonly storeSlug: string;
  /** Price and optional verified evidence from the Price Integrity Engine; always read live, never cached. */
  readonly pricing: PriceInput;
}

export interface DealBand {
  readonly highPercent: number;
  readonly lowPercent: number;
}

/** Every method returns null or an empty list when there is nothing real to show. Implementations never invent data. */
export interface ApiClient {
  listStores(marketId: string): Promise<readonly StoreSummary[]>;
  getStore(marketId: string, slug: string): Promise<StoreSummary | null>;
  getProduct(marketId: string, id: string): Promise<ProductDetail | null>;
  listDealBands(marketId: string): Promise<readonly DealBand[]>;
}

/** Production default until the API adapter exists (ADR-0029 pattern): fails closed with empty results. */
export class UnconfiguredApiClient implements ApiClient {
  listStores(): Promise<readonly StoreSummary[]> {
    return Promise.resolve([]);
  }
  getStore(): Promise<StoreSummary | null> {
    return Promise.resolve(null);
  }
  getProduct(): Promise<ProductDetail | null> {
    return Promise.resolve(null);
  }
  listDealBands(): Promise<readonly DealBand[]> {
    return Promise.resolve([]);
  }
}

let client: ApiClient = new UnconfiguredApiClient();
export function getApiClient(): ApiClient {
  return client;
}
/** Test seam and future composition root. */
export function setApiClient(next: ApiClient): void {
  client = next;
}
