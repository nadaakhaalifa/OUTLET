/** Public surface of the catalog module (A2.3). Other code imports only this file. */
export { CatalogModule } from "./catalog.module";
export { CATALOG_DEV_FIXTURES } from "./adapters/tokens";
export { createCatalogDevFixtures, createCatalogDevListingSnapshots, SEED, type CatalogDevFixtures } from "./adapters/in-memory";
export type {
  CatalogEvent,
  CatalogEventPublisher,
  MediaUrlResolver,
  PriceBlockReader,
  SizeChartStatusReader,
  StockReader,
  StockSeeder,
  StoreReader,
  UploadReader,
} from "./domain/ports";
export type { CatalogPersistence } from "./catalog.module";
export {
  fixedSession as fixedCatalogSession,
  SYSTEM_SESSION as CATALOG_SYSTEM_SESSION,
  type CatalogDb,
  type SessionProvider as CatalogSessionProvider,
} from "./adapters/kysely";
export { KyselySkuLookup } from "./adapters/kysely";
export {
  CatalogListingSnapshots,
  CatalogProductFacts,
  createCatalogListingSnapshots,
  createCatalogProductFacts,
  createCatalogProductionPorts,
  type CatalogProductionSources,
  InventoryStockReader,
  InventoryStockSeeder,
  KyselyStoreLocations,
  LatePriceBlocks,
  MAX_SIGNED_URL_TTL_SECONDS,
  MissingCatalogPortsError,
  ObjectStoreUploads,
  SignedUrlMediaResolver,
  SizingChartStatusReader,
  StoresProfileReader,
  TransactionalOutboxEvents,
  type CatalogProductionPorts,
  type StoreLocations,
} from "./adapters/production";
export type { ProductImageJobs, ProductImageVariant, ImageJobClaim } from "./domain/ports";
export type { CatalogObjectStore, ListedProductFacts, ListingSnapshot, ListingSnapshotReader, ListingSnapshotSku, ProductFactsReader, SkuFacts, SkuLookupReader } from "./domain/ports";
export type { CatalogDeps } from "./application/products";
