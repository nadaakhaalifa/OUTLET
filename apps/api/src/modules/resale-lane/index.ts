/** Public surface of the resale-lane module (A2.3). Other code imports only this file. */
export { ResaleLaneModule, MissingResalePortsError, type ResaleLaneOptions } from "./resale-lane.module";
export * from "./adapters/tokens";
export {
  FakeResaleCatalog,
  FakeResaleConsent,
  FakeResaleLedger,
  FakeReturnFacts,
  InMemoryResaleMetrics,
  InMemoryResaleStore,
  StaticResaleFlags,
  StaticResaleTerms,
} from "./adapters/in-memory";
export { KyselyResaleStore, type ResaleDb } from "./adapters/kysely-store";
export type { BrowseResale, ListReturnedUnit, RecordResaleSale, WithdrawListing } from "./application/resale";
export type {
  ListingRecord,
  ProceedsRecord,
  ResaleCatalogPort,
  ResaleConsentPort,
  ResaleEvent,
  ResaleFlagsPort,
  ResaleLedgerPort,
  ResaleStore,
  ResaleTermsPort,
  ReturnFacts,
  ReturnFactsPort,
} from "./domain/ports";
