import type {
  Condition,
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

export interface ProductPage {
  readonly items: readonly Product[];
  readonly nextCursor: string | null;
}

/** Every method is tenant scoped by construction: there is no cross-store query except `findById` for the resolver and public read. */
export interface ProductRepository {
  /** Inserts the product with all its SKUs atomically. */
  insert(product: Product): Promise<void>;
  findInStore(storeId: string, id: string): Promise<Product | null>;
  findById(id: string): Promise<Product | null>;
  listByStore(storeId: string, cursor: { readonly createdAtMs: number; readonly id: string } | null, limit: number): Promise<ProductPage>;
  /** Compare-and-set on `version`. False when another writer won. */
  replace(next: Product, expectedVersion: number): Promise<boolean>;
  /** `gtinVariantKey` values of every SKU the store already has. */
  takenGtinVariants(storeId: string): Promise<ReadonlySet<string>>;
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
}

/** Platform upload store. Returns only uploads that belong to the given store. */
export interface UploadReader {
  ownedBy(storeId: string, uploadIds: readonly string[]): Promise<ReadonlySet<string>>;
  readText(storeId: string, uploadId: string): Promise<string | null>;
}

export interface MediaUrl {
  readonly url: string;
  readonly blurhash?: string;
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
}

/** Sellers/stores module. */
export interface StoreReader {
  profile(storeId: string, viewerUserId: string): Promise<StoreProfile | null>;
}

/** Sizing module: structure and validation status of a chart. */
export interface SizeChartStatusReader {
  status(storeId: string, chartId: string): Promise<SizeChartStatus>;
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
