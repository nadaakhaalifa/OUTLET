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
