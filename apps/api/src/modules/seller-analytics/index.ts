/** Public surface of the seller-analytics module (A2.3). Other code imports only this file. */
export {
  SellerAnalyticsModule,
  MissingSellerAnalyticsPortsError,
  type SellerAnalyticsModuleOverrides,
} from "./seller-analytics.module";
export * from "./adapters/tokens";
export {
  InMemoryAnalyticsStore,
  InMemoryAudit,
  InMemoryEventSource,
  StaticProductStoreLookup,
} from "./adapters/in-memory";
export { KyselySellerAnalyticsStore, type SellerAnalyticsDb } from "./adapters/kysely-store";
export { ConsumeSellerAnalytics, CONSUMER_NAME, type ConsumeResult } from "./application/consume";
export type {
  AnalyticsStore,
  AuditPort,
  EventSourcePort,
  ExportAuditEntry,
  ProductStoreLookup,
  SourceEvent,
  SourceMessage,
} from "./domain/ports";
export { SourceEventSchema } from "./domain/ports";
export { StaticStoreStatusLookup } from "./adapters/store-status";
export type { StoreStatus, StoreStatusLookup } from "./domain/store-status";
export { KyselyRollupMaintenance, type RollupHooks } from "./adapters/kysely-rollups";
export { KyselyShopperFactsEraser } from "./adapters/kysely-erasure";
export { InMemoryRollups } from "./adapters/in-memory-rollups";
export { ForgetShopper, liveEpochs, type ForgetShopperResult } from "./application/forget-shopper";
export { ReconcileRollups, type ReconcileReport } from "./application/reconcile";
export { MaintainRollupPartitions } from "./application/maintain-partitions";
export type { ShopperFactsEraser, ShopperPseudonymDeriver } from "./domain/erasure-ports";
export type { RollupMaintenance, RollupMetricsPort } from "./domain/rollup-ports";
export { InMemorySellerRollupReader, KyselySellerRollupReader } from "./adapters/rollup-reader";
export type { SellerSeriesOptions } from "./adapters/series.controller";
export type { SellerRollupReader } from "./domain/series-ports";
