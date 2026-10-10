/** Public surface of the catalog module (A2.3). Other code imports only this file. */
export { CatalogModule } from "./catalog.module";
export { CATALOG_DEV_FIXTURES } from "./adapters/tokens";
export { createCatalogDevFixtures, SEED, type CatalogDevFixtures } from "./adapters/in-memory";
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
