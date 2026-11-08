import type { PriceInput } from "@outlet/ui-web";
import { readEnv } from "./env";
import { HttpApiClient } from "./http-api-client";

/** Why a list is empty. UNCONFIGURED = no API_URL; NO_ROUTE = apps/api does not serve the route yet; OK = real result. */
export type DataReason = "OK" | "UNCONFIGURED" | "NO_ROUTE";

export interface StoreSummary {
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly kind: "local" | "global";
  readonly art?: { readonly src: string; readonly width?: number; readonly height?: number };
}

export interface StoreDirectory {
  readonly stores: readonly StoreSummary[];
  readonly reason: DataReason;
}

export interface StoreProfile {
  readonly id: string;
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly taglineAr: string | null;
  readonly taglineEn: string | null;
  readonly kind: "local" | "global";
  readonly status: "ACTIVE" | "VACATION";
  readonly verifiedBadge: boolean;
  readonly followersCount: number;
  /** Only `public` may render a % off (store setting; member_only and hidden never do on the public page). */
  readonly discountDisplayMode: "public" | "member_only" | "hidden";
  readonly canonicalPath: string;
}

export interface ProductImage {
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly altAr: string | null;
  readonly altEn: string | null;
}

/** Price as served by apps/api. Evidence is whatever the Price Integrity Engine returned; the web never computes it. */
export interface ProductSummary {
  readonly id: string;
  readonly storeSlug: string;
  readonly titleAr: string;
  readonly titleEn: string | null;
  readonly image: ProductImage | null;
  readonly conditionGradeCode: string;
  readonly defectCount: number;
  readonly price: {
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly claimType: "verified_discount" | "lowest_30d" | "launch_price" | "plain";
    readonly referenceAmountMinor?: bigint;
    readonly referenceCurrency?: string;
    readonly priceProofPath: string;
  };
  readonly availability: "in_stock" | "low_stock" | "out_of_stock";
  readonly canonicalPath: string;
}

export interface ProductsPage {
  readonly items: readonly ProductSummary[];
  readonly nextCursor: string | null;
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
  listStores(marketId: string): Promise<StoreDirectory>;
  getStore(marketId: string, slug: string): Promise<StoreProfile | null>;
  listStoreProducts(marketId: string, slug: string, opts?: { readonly cursor?: string; readonly limit?: number }): Promise<ProductsPage>;
  getProduct(marketId: string, id: string): Promise<ProductDetail | null>;
  listDealBands(marketId: string): Promise<readonly DealBand[]>;
}

/** Production default until API_URL is set (ADR-0029 pattern): fails closed with empty results. */
export class UnconfiguredApiClient implements ApiClient {
  listStores(): Promise<StoreDirectory> {
    return Promise.resolve({ stores: [], reason: "UNCONFIGURED" });
  }
  getStore(): Promise<StoreProfile | null> {
    return Promise.resolve(null);
  }
  listStoreProducts(): Promise<ProductsPage> {
    return Promise.resolve({ items: [], nextCursor: null });
  }
  getProduct(): Promise<ProductDetail | null> {
    return Promise.resolve(null);
  }
  listDealBands(): Promise<readonly DealBand[]> {
    return Promise.resolve([]);
  }
}

let client: ApiClient | null = null;
export function getApiClient(): ApiClient {
  if (client === null) {
    const base = readEnv().API_URL;
    client = base === undefined ? new UnconfiguredApiClient() : new HttpApiClient(base);
  }
  return client;
}
/** Test seam and composition root. */
export function setApiClient(next: ApiClient | null): void {
  client = next;
}
