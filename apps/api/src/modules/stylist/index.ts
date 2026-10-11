/** Public surface of the stylist module (A2.3). Other code imports only this file. */
export { StylistModule, MissingStylistPortsError, type StylistModuleOptions } from "./stylist.module";
export * from "./adapters/tokens";
export {
  FakeBag,
  FakeBudget,
  FakeCandidateSource,
  FakeEmbeddings,
  FakeLivePrices,
  FakePersonalization,
  FakeStylistLlm,
  InMemoryStylistStore,
  StaticStylistFlags,
} from "./adapters/in-memory";
export { KyselyStylistStore, type StylistDb } from "./adapters/kysely-store";
export { GatewayStylistLlm } from "./adapters/gateway-llm";
export { DEFAULT_STYLIST_CONFIG, FLAG_LLM, FLAG_ML, type StylistConfig } from "./application/shared";
export type { ClearStylistHistory } from "./application/feedback";
export { CatalogUnavailableError, budgetBand } from "./domain/ports";
export type {
  BagPort,
  BudgetPort,
  CandidateQuery,
  CandidateSourcePort,
  EmbeddingPort,
  LivePrice,
  LivePricePort,
  OutfitRecord,
  PersonalizationPort,
  StylistCandidate,
  StylistEvent,
  StylistFlagPort,
  StylistLlmPort,
  StylistStore,
} from "./domain/ports";
