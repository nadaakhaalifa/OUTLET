/** Public surface of the ranking v2 module. Other code imports only this file (A2.3). */
export { RankingModule, MissingRankingPortsError, type RankingModuleOptions } from "./ranking.module";
export {
  RANKING_SHADOW_OBSERVER,
  RANKING_PURGE,
  RANKING_SHADOW_STORE,
  RANKING_EVAL_STORE,
  RANKING_RANKER,
} from "./adapters/tokens";
export {
  DomainModelRanker,
  FakeSessionModel,
  InMemoryEvalRunStore,
  InMemoryShadowLogStore,
  StaticModelRegistry,
  StaticRankingFlags,
  ThrowingRanker,
} from "./adapters/in-memory";
export { KyselyRankingStore, type RankingDb } from "./adapters/kysely-store";
export { ShadowObserve, PurgeShadowLogs, SHADOW_RETENTION_DAYS } from "./application/ranking";
export type {
  EvalRunRecord,
  EvalRunStore,
  FlagPort as RankingFlagPort,
  ModelRegistryPort,
  RankerV2Port,
  SessionNextItemPort,
  ShadowLogStore,
  ShadowObservation,
  ShadowObserverPort,
  ShadowSummary,
} from "./domain/ports";
