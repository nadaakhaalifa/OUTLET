/** Public surface of the analytics-ingest module (A2.3). Other code imports only this file. */
export { AnalyticsIngestModule, type AnalyticsIngestOverrides } from "./analytics-ingest.module";
export { AnalyticsProducers, type AnalyticsProducerDeps, type ProducerGate, type ShopperKeyer, type PlacedLine } from "./domain/producers";
export { ANALYTICS_EVENT_TYPES, deterministicEventId, type AnalyticsOutboxDraft } from "./domain/events";
export { appendAnalyticsDrafts, analyticsConsentGranted } from "./adapters/producer-sql";
export { HmacShopperKeyer } from "./adapters/hmac-keyer";
export { PrimedShopperKeyer, type PrimableShopperKeyer } from "./adapters/primed-keyer";
export { KyselyBatchOutbox, KyselyConsentReader, type IngestDb } from "./adapters/kysely-store";
export { VerifierAttestationCheck } from "./adapters/attestation";
export { IngestAnalyticsBatch } from "./application/ingest-batch";
export type {
  AttestationCheck,
  BatchOutbox,
  ConsentReader,
  IngestCounters,
  IngestGate,
  PlausibilityStore,
} from "./domain/ports";
export type { TermVocabulary } from "./domain/terms";
/** Payload schemas (consumers and the producers' own module tests parse with these). */
export { InventoryLevelChanged, OrderLinePurchased, ReturnLineReceived, SellerOrderPlacedAnalytics } from "./domain/events";
/** Test doubles for adapters that take the producers; never wired in production. */
export { FakeKeyer, StaticGate } from "./adapters/in-memory";
export { IngestDisabledError } from "./domain/ports";
