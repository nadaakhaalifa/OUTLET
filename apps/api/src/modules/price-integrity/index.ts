/** Public surface of the price-integrity module (A2.3). Other code imports only this file. */
export { PriceIntegrityModule, type PriceIntegrityPersistence } from "./price-integrity.module";
export { PRICE_BLOCK_READER, PRICE_INTEGRITY_FIXTURES, PRICE_INTEGRITY_SERVICE } from "./adapters/tokens";
export { PriceIntegrityService, PriceIntegrityError, claimIdFor } from "./application/service";
export type {
  ClaimReview,
  PriceChangeOutcome,
  ProductEvidenceView,
  RecordPriceChangeInput,
  SkuEvidenceView,
  StoreTrustView,
} from "./application/service";
export { createPriceIntegrityDevFixtures, type PriceIntegrityDevFixtures } from "./adapters/in-memory";
export { SYSTEM_SESSION as PRICE_INTEGRITY_SYSTEM_SESSION, type PriceIntegrityDb, type SessionProvider as PriceIntegritySessionProvider } from "./adapters/kysely";
export type {
  ClaimStore,
  EnforcementStore,
  ExternalEvidencePort,
  PriceEventStore,
  ProductSkus,
  SkuDirectory,
} from "./domain/ports";
