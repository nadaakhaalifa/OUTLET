/** Public surface of the recommendations module. Other code imports only this file (A2.3). */
export {
  RecommendationsModule,
  MissingRecommendationsPortsError,
  type RecommendationsModuleOptions,
} from "./recommendations.module";
export * from "./adapters/tokens";
export {
  FakeAffordability,
  FakeCatalog,
  FakeFlags,
  FakePersonalization,
  FakeUserSizes,
  InMemoryRecoStore,
  InMemoryVectorIndex,
  SeededRngPort,
  SpyRanker,
} from "./adapters/in-memory";
export { KyselyRecoStore, PgVectorIndex, type RecoDb } from "./adapters/kysely-store";
export type { BuildCooccurrence, FeedResult, RecItem, SimilarMode } from "./application/recommendations";
export type {
  AffordabilityFilterPort,
  CatalogPort,
  CooccurrenceKind,
  CooccurrenceRow,
  FlagPort,
  HistoryPurchase,
  HistoryView,
  PersonalizationReadPort,
  RankerPort,
  RecModule,
  RecOutboxEvent,
  RecoStore,
  RngPort,
  UserSizePort,
  VectorIndexPort,
} from "./domain/ports";
