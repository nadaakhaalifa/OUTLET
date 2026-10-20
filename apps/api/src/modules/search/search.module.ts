import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  FakeLlmGateway,
  FakeProductFacts,
  InMemorySavedSearchRepository,
  InMemorySearchEventPublisher,
  InMemorySearchIndex,
  InMemorySuggestionDirectory,
  StaticKillSwitch,
  StaticShopperScope,
} from "./adapters/in-memory";
import { NoopSearchSyncMetrics } from "./adapters/otel-sync-metrics";
import { PublicSearchController } from "./adapters/public.controller";
import { SavedSearchesController, SearchController } from "./adapters/search.controller";
import { TypesenseSearchPort } from "./adapters/typesense";
import {
  CREATE_SAVED_SEARCH,
  DELETE_SAVED_SEARCH,
  GET_SAVED_SEARCH,
  LIST_SAVED_SEARCHES,
  PARSE_SEARCH_QUERY,
  SAVED_SEARCH_REPOSITORY,
  SEARCH_DIRECTORY,
  SEARCH_EVENTS,
  SEARCH_FACTS,
  SEARCH_FALLBACK,
  SEARCH_INDEX_WRITER,
  SEARCH_KILL_SWITCH,
  SEARCH_LLM,
  SEARCH_PRIMARY,
  SEARCH_PRODUCTS,
  SEARCH_SCOPE,
  SEARCH_SYNC_EVENT_CONSUMER,
  SUGGEST_QUERIES,
  UPDATE_SAVED_SEARCH,
} from "./adapters/tokens";
import {
  CreateSavedSearch,
  DeleteSavedSearch,
  GetSavedSearch,
  ListSavedSearches,
  UpdateSavedSearch,
  type SavedSearchDeps,
} from "./application/saved-searches";
import { ParseSearchQuery, SearchProducts, SuggestQueries } from "./application/search";
import { SearchSyncConsumer } from "./application/sync";
import type {
  LlmGatewayPort,
  ProductFactsPort,
  SavedSearchRepository,
  IndexSourcePort,
  SearchEventPublisher,
  SearchIndexWriter,
  SearchSyncMetrics,
  SearchKillSwitchPort,
  SearchPort,
  ShopperScopePort,
  SuggestionDirectoryPort,
} from "./domain/ports";

export interface SearchModuleOverrides {
  /** Primary engine. Default: a Typesense stub with no transport (always degrades to the fallback). */
  readonly primary?: SearchPort;
  /** Postgres FTS + trigram adapter (the documented Typesense-down fallback). */
  readonly fallback?: SearchPort;
  readonly indexWriter?: SearchIndexWriter;
  readonly facts?: ProductFactsPort;
  readonly savedSearches?: SavedSearchRepository;
  readonly killSwitch?: SearchKillSwitchPort;
  readonly scope?: ShopperScopePort;
  readonly directory?: SuggestionDirectoryPort;
  readonly llm?: LlmGatewayPort | null;
  readonly events?: SearchEventPublisher;
  /**
   * Catalog-to-index feeder. Absent: no consumer is provided and the relay acknowledges catalog events unrouted.
   * It needs an index writer too (the module's own in-memory index in dev, `indexWriter` otherwise).
   */
  readonly sync?: { readonly source: IndexSourcePort; readonly metrics?: SearchSyncMetrics };
}

/**
 * Thrown at boot when a port that decides what a shopper is shown is not supplied outside test mode.
 * Search must never rank from an empty fixture index or price from a fixture catalog.
 */
export class MissingSearchPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`SearchModule requires real ${missing.join(", ")} outside test mode: supply them through SearchModule.forRoot(config, overrides)`);
    this.name = "MissingSearchPortsError";
  }
}

@Module({})
export class SearchModule {
  static forRoot(config: AppConfig, o: SearchModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.savedSearches === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.fallback === undefined) missing.push("fallback (SEARCH_FALLBACK: Postgres FTS index)");
      if (o.facts === undefined) missing.push("facts (SEARCH_FACTS: live price and stock)");
      if (o.savedSearches === undefined) missing.push("savedSearches (SAVED_SEARCH_REPOSITORY)");
      if (o.scope === undefined) missing.push("scope (SEARCH_SCOPE: My Stores)");
      if (o.directory === undefined) missing.push("directory (SEARCH_DIRECTORY)");
      if (missing.length > 0) throw new MissingSearchPortsError(missing);
    }
    const memoryIndex = new InMemorySearchIndex();
    const fallback = o.fallback ?? memoryIndex;
    const writer = o.indexWriter ?? (o.fallback === undefined ? memoryIndex : undefined);
    const savedDeps = {
      inject: [SAVED_SEARCH_REPOSITORY, SEARCH_EVENTS, CLOCK, ID_GENERATOR],
      build: (repo: SavedSearchRepository, events: SearchEventPublisher, clock: Clock, ids: IdGenerator): SavedSearchDeps => ({
        repo,
        events,
        clock,
        ids,
      }),
    };
    const saved = <T>(token: symbol, make: (d: SavedSearchDeps) => T) => ({
      provide: token,
      inject: savedDeps.inject,
      useFactory: (...a: Parameters<typeof savedDeps.build>): T => make(savedDeps.build(...a)),
    });
    return {
      module: SearchModule,
      controllers: [SearchController, SavedSearchesController, PublicSearchController],
      providers: [
        { provide: SEARCH_PRIMARY, useValue: o.primary ?? new TypesenseSearchPort(null) },
        { provide: SEARCH_FALLBACK, useValue: fallback },
        { provide: SEARCH_INDEX_WRITER, useValue: writer ?? null },
        {
          provide: SEARCH_SYNC_EVENT_CONSUMER,
          inject: [CLOCK],
          useFactory: (clock: Clock): SearchSyncConsumer | null =>
            o.sync === undefined || writer === undefined
              ? null
              : new SearchSyncConsumer({ source: o.sync.source, writer, metrics: o.sync.metrics ?? new NoopSearchSyncMetrics(), clock }),
        },
        { provide: SEARCH_KILL_SWITCH, useValue: o.killSwitch ?? new StaticKillSwitch(false) },
        { provide: SEARCH_FACTS, useValue: o.facts ?? new FakeProductFacts() },
        { provide: SEARCH_SCOPE, useValue: o.scope ?? new StaticShopperScope() },
        { provide: SEARCH_DIRECTORY, useValue: o.directory ?? new InMemorySuggestionDirectory() },
        { provide: SEARCH_LLM, useValue: o.llm === undefined ? new FakeLlmGateway() : o.llm },
        { provide: SEARCH_EVENTS, useValue: o.events ?? new InMemorySearchEventPublisher() },
        { provide: SAVED_SEARCH_REPOSITORY, useValue: o.savedSearches ?? new InMemorySavedSearchRepository() },
        {
          provide: SEARCH_PRODUCTS,
          inject: [SEARCH_PRIMARY, SEARCH_FALLBACK, SEARCH_KILL_SWITCH, SEARCH_FACTS, SEARCH_SCOPE, SEARCH_EVENTS, CLOCK],
          useFactory: (
            primary: SearchPort,
            fb: SearchPort,
            killSwitch: SearchKillSwitchPort,
            facts: ProductFactsPort,
            scope: ShopperScopePort,
            events: SearchEventPublisher,
            clock: Clock,
          ) => new SearchProducts({ primary, fallback: fb, killSwitch, facts, scope, events, clock }),
        },
        {
          provide: SUGGEST_QUERIES,
          inject: [SEARCH_FALLBACK, SEARCH_DIRECTORY],
          useFactory: (index: SearchPort, directory: SuggestionDirectoryPort) => new SuggestQueries({ index, directory }),
        },
        {
          provide: PARSE_SEARCH_QUERY,
          inject: [SEARCH_LLM],
          useFactory: (llm: LlmGatewayPort | null) => new ParseSearchQuery({ llm }),
        },
        saved(CREATE_SAVED_SEARCH, (d) => new CreateSavedSearch(d)),
        saved(LIST_SAVED_SEARCHES, (d) => new ListSavedSearches(d)),
        saved(GET_SAVED_SEARCH, (d) => new GetSavedSearch(d)),
        saved(UPDATE_SAVED_SEARCH, (d) => new UpdateSavedSearch(d)),
        saved(DELETE_SAVED_SEARCH, (d) => new DeleteSavedSearch(d)),
      ],
      exports: [SEARCH_SYNC_EVENT_CONSUMER, SEARCH_INDEX_WRITER, SAVED_SEARCH_REPOSITORY, SEARCH_FACTS, SEARCH_EVENTS],
    };
  }
}
