
/** Why a list is empty. UNCONFIGURED = no API_URL; NO_ROUTE = apps/api does not serve the route yet; OK = real result. */
export type DataReason = "OK" | "UNCONFIGURED" | "NO_ROUTE";

export interface StoreSummary {
  readonly id: string;
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly kind: "local" | "global";
  readonly art?: { readonly src: string; readonly width?: number; readonly height?: number };
}

export interface StoreDirectory {
  readonly stores: readonly StoreSummary[];
  /** Keyset cursor for the next page, or null on the last page. */
  readonly nextCursor: string | null;
  readonly reason: DataReason;
}

export type StoreWorld = "local" | "global" | "both";

export interface StoreQuery {
  readonly world?: StoreWorld;
  readonly categoryId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CategoryNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly slug: string;
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
  /** Quick-view fields (store products route only). */
  readonly conditionLabelAr?: string | null;
  readonly conditionLabelEn?: string | null;
  readonly colourCode?: string | null;
}

export interface ProductsPage {
  readonly items: readonly ProductSummary[];
  readonly nextCursor: string | null;
}

export type PriceView = ProductSummary["price"];

export interface SellerLegalIdentity {
  readonly legalNameAr: string;
  readonly legalNameEn: string | null;
  readonly commercialRegisterNo: string;
  readonly taxCardNo: string;
  readonly governorateNameAr: string;
}

export interface DefectItemView {
  readonly labelAr: string;
  readonly labelEn: string | null;
  readonly locationAr: string;
  readonly locationEn: string | null;
  readonly affectsFunction: boolean;
  readonly photo: ProductImage;
}

export interface DefectCardView {
  readonly gradeCode: string;
  readonly summaryAr: string | null;
  readonly summaryEn: string | null;
  readonly affectsFunction: boolean;
  readonly defectCount: number;
  readonly items: readonly DefectItemView[];
}

export interface SkuView {
  readonly id: string;
  readonly sizeLabel: string | null;
  /** Price and optional evidence from the Price Integrity Engine; always read live, never cached. */
  readonly price: PriceView;
  readonly availability: "in_stock" | "low_stock" | "out_of_stock";
}

export interface ProductDetail {
  readonly id: string;
  readonly titleAr: string;
  readonly titleEn: string | null;
  readonly descriptionAr: string;
  readonly descriptionEn: string | null;
  readonly brandName: string | null;
  readonly conditionCode: string;
  readonly conditionLabelAr: string;
  readonly conditionLabelEn: string | null;
  /** schema.org itemCondition URL as served by the API. */
  readonly schemaOrgCondition: string;
  readonly defectCard: DefectCardView | null;
  readonly skus: readonly SkuView[];
  readonly store: StoreProfile;
  readonly legal: SellerLegalIdentity;
  readonly canonicalPath: string;
}

export const DEAL_BANDS = [
  { code: "70_60", highPercent: 70, lowPercent: 60 },
  { code: "59_50", highPercent: 59, lowPercent: 50 },
  { code: "49_40", highPercent: 49, lowPercent: 40 },
] as const;
export type DealBandCode = (typeof DEAL_BANDS)[number]["code"];

export interface DealShelf {
  readonly band: (typeof DEAL_BANDS)[number];
  readonly items: readonly ProductSummary[];
}

/** Every method returns null or an empty list when there is nothing real to show. Implementations never invent data. */
export interface ApiClient {
  listStores(marketId: string, opts?: StoreQuery): Promise<StoreDirectory>;
  listCategories(marketId: string): Promise<readonly CategoryNode[]>;
  getStore(marketId: string, slug: string): Promise<StoreProfile | null>;
  listStoreProducts(marketId: string, slug: string, opts?: { readonly cursor?: string; readonly limit?: number }): Promise<ProductsPage>;
  getProduct(marketId: string, id: string): Promise<ProductDetail | null>;
  /** Verified-discount products of one band (empty until Price Watch has history). */
  listDeals(marketId: string, band: DealBandCode): Promise<readonly ProductSummary[]>;
}

/** Production default until API_URL is set (ADR-0029 pattern): fails closed with empty results. */
export class UnconfiguredApiClient implements ApiClient {
  listStores(): Promise<StoreDirectory> {
    return Promise.resolve({ stores: [], nextCursor: null, reason: "UNCONFIGURED" });
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
  listCategories(): Promise<readonly CategoryNode[]> {
    return Promise.resolve([]);
  }
  listDeals(): Promise<readonly ProductSummary[]> {
    return Promise.resolve([]);
  }
}
