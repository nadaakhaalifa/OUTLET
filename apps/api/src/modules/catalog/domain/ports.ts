import type {
  Condition,
  Department,
  ListingStatus,
  Money,
  PriceBlockInput,
  Product,
  ReturnClass,
  SellerLegalRecord,
  SizeChartStatus,
} from "./catalog-domain";

export interface CategoryRecord {
  readonly id: string;
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn?: string;
  readonly parentId?: string;
  readonly productType: string;
  readonly returnClass: ReturnClass;
  readonly requiresSizeChart: boolean;
  readonly active: boolean;
}

export interface BrandRecord {
  readonly id: string;
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn?: string;
}

export interface TaxonomyRepository {
  categoryById(id: string): Promise<CategoryRecord | null>;
  categoryBySlug(slug: string): Promise<CategoryRecord | null>;
  brandById(id: string): Promise<BrandRecord | null>;
  allCategories(): Promise<readonly CategoryRecord[]>;
  allBrands(): Promise<readonly BrandRecord[]>;
}

/**
 * A product image backed by a background-removal job. The product's `imageUploadIds` entry for it is the job id;
 * these are the catalog-purpose object keys of its variants (private keys, resolved to signed links on read,
 * never serialized as-is).
 */
export interface ProductImageVariant {
  readonly jobId: string;
  /** Default image: white-background JPG for an accepted cutout, the original for `use_original`. */
  readonly imageRef: string;
  /** Transparent PNG, only for an accepted cutout. */
  readonly cutoutRef: string | null;
}

export type ImageJobClaim =
  | { readonly kind: "ok"; readonly image: ProductImageVariant & { readonly newlyClaimed: boolean } }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_decided" }
  | { readonly kind: "attached_elsewhere" }
  | { readonly kind: "storage_unavailable" };

/** Product-media module (bound under the token "catalog.ImageJobs"). Absent => `media_job_id` requests answer 503. */
export interface ProductImageJobs {
  /** Atomically attaches the job to the product (compare-and-set) and promotes its variants. Idempotent per product. */
  claim(storeId: string, productId: string, jobId: string): Promise<ImageJobClaim>;
  /** Frees jobs the product no longer references. */
  release(storeId: string, productId: string, jobIds: readonly string[]): Promise<void>;
}

export interface ProductPage {
  readonly items: readonly Product[];
  readonly nextCursor: string | null;
}

/** Every method is tenant scoped by construction: there is no cross-store query except `findById` for the resolver and public read. */
export interface ProductRepository {
  /**
   * Inserts the product with all its SKUs atomically. `events` are appended to the outbox in the SAME
   * transaction (Postgres adapter) so state and events commit or roll back together.
   */
  insert(product: Product, events?: readonly CatalogEvent[], variants?: readonly ProductImageVariant[]): Promise<void>;
  /** Variants of the job-backed images of these products (absent product = none). */
  imageVariants(productIds: readonly string[]): Promise<ReadonlyMap<string, readonly ProductImageVariant[]>>;
  findInStore(storeId: string, id: string): Promise<Product | null>;
  findById(id: string): Promise<Product | null>;
  listByStore(storeId: string, cursor: { readonly createdAtMs: number; readonly id: string } | null, limit: number): Promise<ProductPage>;
  /** Compare-and-set on `version`. False when another writer won (no events are written then). */
  replace(next: Product, expectedVersion: number, events?: readonly CatalogEvent[], variants?: readonly ProductImageVariant[]): Promise<boolean>;
  /** `gtinVariantKey` values of every SKU the store already has. */
  takenGtinVariants(storeId: string): Promise<ReadonlySet<string>>;
  /**
   * Anonymous sitemap feed: `active` products across stores, ordered by id, as light stubs (no SKUs).
   * The caller applies store visibility; this is a catalog-wide read for system and public paths only.
   */
  listActiveStubs(offset: number, limit: number): Promise<readonly ActiveProductStub[]>;
}

export interface ActiveProductStub {
  readonly id: string;
  readonly storeId: string;
  readonly updatedAtMs: number;
}

export interface ImportErrorRow {
  readonly row: number;
  readonly column?: string;
  readonly code: string;
}

export type ImportStatus = "queued" | "validating" | "dry_run_complete" | "applying" | "completed" | "failed";

export interface ImportRecord {
  readonly id: string;
  readonly storeId: string;
  readonly actorId: string;
  readonly uploadId: string;
  readonly status: ImportStatus;
  readonly dryRun: boolean;
  readonly rowsTotal: number;
  readonly rowsOk: number;
  readonly rowsFailed: number;
  readonly errors: readonly ImportErrorRow[];
  readonly createdAtMs: number;
}

export interface ImportRepository {
  save(record: ImportRecord): Promise<void>;
  find(id: string): Promise<ImportRecord | null>;
  /** True the first time `(importId, productRef)` is claimed, false on replay. */
  claimProduct(importId: string, productRef: string): Promise<boolean>;
  /** Records which product a claim produced. Called after the product insert; idempotent. */
  attachProduct(importId: string, productRef: string, productId: string): Promise<void>;
}

/** Platform upload store. Returns only uploads that belong to the given store. */
export interface UploadReader {
  ownedBy(storeId: string, uploadIds: readonly string[]): Promise<ReadonlySet<string>>;
  readText(storeId: string, uploadId: string): Promise<string | null>;
}

/**
 * Object-store port (S3-compatible). Production binds an Unconfigured adapter until a provider is
 * configured: every call then fails with provider_not_configured (503), so upload-dependent writes
 * (image references, CSV imports) are refused while reads that need no store keep working.
 */
export interface CatalogObjectStore {
  /** Which of these upload ids exist and belong to the store. */
  ownedBy(storeId: string, uploadIds: readonly string[]): Promise<ReadonlySet<string>>;
  readText(storeId: string, uploadId: string): Promise<string | null>;
}

export interface MediaUrl {
  readonly url: string;
  readonly blurhash?: string;
  /** Transparent cutout of a job-backed image (accepted background removal only). */
  readonly cutoutUrl?: string;
}

export interface MediaUrlResolver {
  resolve(uploadIds: readonly string[]): Promise<ReadonlyMap<string, MediaUrl>>;
}

export interface StockLevel {
  readonly onHand: number;
  readonly available: number;
}

/** Inventory module. Read at request time, never cached by the catalog. */
export interface StockReader {
  levels(skuIds: readonly string[]): Promise<ReadonlyMap<string, StockLevel>>;
}

export interface StockSeeder {
  seed(storeId: string, skuId: string, quantity: number): Promise<void>;
}

/** Pricing-integrity module. Absent entries mean "no verified evidence". */
export interface PriceBlockReader {
  blocks(skuIds: readonly string[]): Promise<ReadonlyMap<string, PriceBlockInput>>;
}

export interface StoreProfile {
  readonly id: string;
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn?: string;
  readonly kind: "local" | "global";
  readonly verifiedBadge: boolean;
  readonly liveDrop: boolean;
  readonly isFavorite: boolean;
  readonly legal: SellerLegalRecord;
  /** A suspended or unapproved store is not purchasable. */
  readonly visible: boolean;
  /** On vacation (stores status PAUSED). Visible to signed-in shoppers, not part of the anonymous surface. Absent means not paused. */
  readonly paused?: boolean;
}

/** Sellers/stores module. */
export interface StoreReader {
  profile(storeId: string, viewerUserId: string): Promise<StoreProfile | null>;
}

/** Sizing module: structure and validation status of a chart. */
export interface SizeChartStatusReader {
  status(storeId: string, chartId: string): Promise<SizeChartStatus>;
}

/** Public facts about one listed product, for modules that must not read catalog tables (wishlists). */
export interface ListedProductFacts {
  readonly id: string;
  /** False when the product is not active, its store is not shopper-visible, or it has no valid public view. */
  readonly listed: boolean;
  /** Cheapest SKU price, or null when not listed. */
  readonly currentPrice: Money | null;
  readonly skuIds: readonly string[];
  /** ProductSummary wire shape (price block already sanitised by the price-integrity rules). */
  readonly summary: { readonly id: string; readonly [key: string]: unknown };
}

export interface ProductFactsReader {
  facts(productIds: readonly string[]): Promise<ReadonlyMap<string, ListedProductFacts>>;
}

export type CatalogEvent =
  | {
      readonly name: "product.created";
      readonly productId: string;
      readonly storeId: string;
      readonly skuIds: readonly string[];
      readonly version: number;
      readonly status: ListingStatus;
      readonly actorId: string;
      readonly occurredAtMs: number;
    }
  | {
      readonly name: "product.updated";
      readonly productId: string;
      readonly storeId: string;
      readonly version: number;
      readonly status: ListingStatus;
      readonly actorId: string;
      readonly occurredAtMs: number;
    }
  | {
      readonly name: "product.status_changed";
      readonly productId: string;
      readonly storeId: string;
      readonly version: number;
      readonly from: ListingStatus;
      readonly to: ListingStatus;
      readonly actorId: string;
      readonly occurredAtMs: number;
    };

/** Transactional outbox port. The production adapter writes in the same transaction as the state change. */
export interface CatalogEventPublisher {
  publish(events: readonly CatalogEvent[]): Promise<void>;
}

export interface CatalogClock {
  nowMs(): number;
}

export interface CatalogIds {
  uuidV7(): string;
}

export type { Condition, Money };

/** SKU-level facts for other modules (auto-buy quote, seller-SKU resolution). Read only. */
export interface SkuFacts {
  readonly skuId: string;
  readonly productId: string;
  readonly storeId: string;
  readonly sizeLabel: string;
  readonly titleAr: string;
  readonly titleEn: string | null;
  /** List price in integer piastres. */
  readonly priceAmount: bigint;
  readonly currency: string;
  readonly skuStatus: "active" | "paused" | "sold_out" | "delisted";
  readonly productStatus: "draft" | "active" | "paused" | "auto_paused_price_parity" | "delisted";
}
export interface SkuLookupReader {
  /** seller_sku -> sku id within ONE store. Codes with no match are absent. */
  bySellerSku(storeId: string, codes: readonly string[]): Promise<ReadonlyMap<string, string>>;
  skuFacts(skuId: string): Promise<SkuFacts | null>;
}

/** One SKU of a listed product as shoppers see it now: price and availability read from their owners, never cached. */
export interface ListingSnapshotSku {
  readonly id: string;
  readonly price: Money;
  readonly available: boolean;
  readonly color: string | null;
  /** Already sanitised by the catalog: a reference or percentage appears only with a verified claim. */
  readonly priceBlock: PriceBlockInput;
}

/**
 * Read model for modules that index or summarise listings (search). `listed: false` means shoppers cannot
 * see the product (not active, store not visible, or no listed SKU): the consumer must drop it from any index.
 * `version` is the product row version, comparable with the `version` of the catalog events.
 */
export type ListingSnapshot =
  | { readonly listed: false; readonly productId: string; readonly storeId: string; readonly status: ListingStatus; readonly version: number }
  | {
      readonly listed: true;
      readonly productId: string;
      readonly storeId: string;
      readonly status: ListingStatus;
      readonly version: number;
      readonly createdAtMs: number;
      readonly publishedAtMs: number | null;
      readonly title: { readonly ar: string; readonly en?: string };
      readonly categoryId: string;
      /** products.brand_id as stored, null when the product has no brand. */
      readonly brandId: string | null;
      /** Resolved only when the brand row exists; the taxonomy has no active flag, so none is applied. */
      readonly brand: BrandRecord | null;
      readonly condition: Condition;
      readonly department: Department;
      readonly material: string | null;
      readonly storeKind: "local" | "global";
      /** False while the store is on vacation. */
      readonly storeOpen: boolean;
      readonly imageUrl: string | null;
      readonly blurhash: string | null;
      readonly skus: readonly ListingSnapshotSku[];
    };

export interface ListingSnapshotReader {
  /** Null when the product id does not exist. */
  snapshot(productId: string): Promise<ListingSnapshot | null>;
}
