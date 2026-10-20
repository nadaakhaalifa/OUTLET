/** Public surface of the history module. Other code imports only this file (A2.3). */
export { HistoryModule, MissingHistoryPortsError, type HistoryModuleOptions } from "./history.module";
export * from "./adapters/tokens";
export { FakeConsent, FakeFlags, FakeProductLookup, InMemoryHistoryStore } from "./adapters/in-memory";
export { KyselyHistoryStore, type HistoryDb } from "./adapters/kysely-store";
export type {
  BuildResult,
  RecordEventInput,
  RecordResult,
  SweepReport,
} from "./application/history";
export type {
  ClearCounts,
  ClearRequest,
  FlagPort,
  HistoryOutboxEvent,
  HistorySettings,
  HistoryStore,
  PersonalizationConsentPort,
  ProductLookupPort,
  ProductSnapshot,
  StoredFeatures,
} from "./domain/ports";
export { HistoryPersonalizationRead } from "./adapters/personalization-read";
