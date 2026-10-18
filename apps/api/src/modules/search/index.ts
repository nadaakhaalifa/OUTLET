/** Public surface of the search module (A2.3). Other code imports only this file. */
export { SearchModule, MissingSearchPortsError, type SearchModuleOverrides } from "./search.module";
export {
  SAVED_SEARCH_REPOSITORY,
  SEARCH_DIRECTORY,
  SEARCH_EVENTS,
  SEARCH_FACTS,
  SEARCH_FALLBACK,
  SEARCH_INDEX_WRITER,
  SEARCH_KILL_SWITCH,
  SEARCH_LLM,
  SEARCH_PRIMARY,
  SEARCH_SCOPE,
  SEARCH_SYNC_EVENT_CONSUMER,
} from "./adapters/tokens";
export {
  FakeLlmGateway,
  FakeProductFacts,
  InMemorySavedSearchRepository,
  InMemorySearchEventPublisher,
  InMemorySearchIndex,
  InMemorySuggestionDirectory,
  StaticKillSwitch,
  StaticShopperScope,
} from "./adapters/in-memory";
export { PostgresFtsSearchPort, type SearchDb } from "./adapters/postgres-fts";
export { CatalogBackedProductFacts } from "./adapters/catalog-facts";
export { CatalogIndexSource, toIndexedProduct } from "./adapters/catalog-index-source";
export { NoopSearchSyncMetrics, OtelSearchSyncMetrics } from "./adapters/otel-sync-metrics";
export { StoresBackedSummaries } from "./adapters/store-summaries";
export { SearchSyncConsumer, SEARCH_SYNC_CONSUMED_EVENTS, type SearchSyncEvent } from "./application/sync";
export { KyselySavedSearchRepository } from "./adapters/kysely-saved-searches";
export { TypesenseSearchPort, type TypesenseTransport } from "./adapters/typesense";
export type {
  IndexedProduct,
  IndexSource,
  IndexSourcePort,
  SearchSyncMetrics,
  StoreSummaryPort,
  LlmGatewayPort,
  ProductFacts,
  ProductFactsPort,
  SavedSearchRecord,
  SavedSearchRepository,
  SearchEvent,
  SearchEventPublisher,
  SearchIndexWriter,
  SearchKillSwitchPort,
  SearchPage,
  SearchPort,
  SearchRequest,
  ShopperScopePort,
  SuggestionDirectoryPort,
} from "./domain/ports";
export { StaleIndexSourceError, ProductFactsUnavailableError, SearchUnavailableError, LlmUnavailableError } from "./domain/ports";
