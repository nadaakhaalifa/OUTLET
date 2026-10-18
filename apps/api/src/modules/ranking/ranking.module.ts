import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  DomainModelRanker,
  InMemoryEvalRunStore,
  InMemoryShadowLogStore,
  StaticModelRegistry,
  StaticRankingFlags,
} from "./adapters/in-memory";
import { RankingAdminController } from "./adapters/ranking.controller";
import { RankingAdminResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import { EvaluateGuardrails, GetShadowSummary, ListEvaluations, PurgeShadowLogs, RunEvaluation, ShadowObserve } from "./application/ranking";
import { LinearRanker, type GuardrailConfig } from "./domain/bridge";
import type {
  EvalRunStore,
  FlagPort,
  ModelRegistryPort,
  RankerV2Port,
  SessionNextItemPort,
  ShadowLogStore,
} from "./domain/ports";

export interface RankingModuleOptions {
  readonly shadowStore?: ShadowLogStore;
  readonly evalStore?: EvalRunStore;
  /** Shadow model. Defaults to the pure linear baseline, which needs no service. */
  readonly ranker?: RankerV2Port;
  readonly session?: SessionNextItemPort;
  /** kill.ranking_v2_shadow. Fails closed outside test mode when absent. */
  readonly flags?: FlagPort;
  readonly models?: ModelRegistryPort;
  readonly guardrailConfig?: GuardrailConfig;
}

export class MissingRankingPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`RankingModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingRankingPortsError";
  }
}

/**
 * Global on purpose: the recommendations serving path takes `RANKING_SHADOW_OBSERVER` as an
 * optional dependency, so apps that do not compose this module serve exactly as before.
 */
@Module({})
export class RankingModule {
  static forRoot(config: AppConfig, o: RankingModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (o.shadowStore === undefined || o.evalStore === undefined)) throw new NoProductionAdaptersError();
    if ((production || config.env !== "test") && o.flags === undefined) throw new MissingRankingPortsError(["flags (kill.ranking_v2_shadow)"]);
    const shadowStore = o.shadowStore ?? new InMemoryShadowLogStore();
    const evalStore = o.evalStore ?? new InMemoryEvalRunStore();
    const ranker = o.ranker ?? new DomainModelRanker(new LinearRanker());
    const flags = o.flags ?? new StaticRankingFlags(true);
    const models = o.models ?? new StaticModelRegistry();
    return {
      module: RankingModule,
      global: true,
      controllers: [RankingAdminController],
      providers: [
        { provide: T.RANKING_RANKER, useValue: ranker },
        { provide: T.RANKING_SHADOW_STORE, useValue: shadowStore },
        { provide: T.RANKING_EVAL_STORE, useValue: evalStore },
        { provide: T.RANKING_FLAGS, useValue: flags },
        { provide: T.RANKING_MODELS, useValue: models },
        ...(o.session === undefined ? [] : [{ provide: T.RANKING_SESSION, useValue: o.session }]),
        { provide: T.RANKING_ADMIN_RESOLVER, useValue: new RankingAdminResolver() },
        {
          provide: T.RANKING_SHADOW_OBSERVER,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => new ShadowObserve(ranker, shadowStore, flags, c, ids),
        },
        { provide: T.RANKING_SHADOW_SUMMARY, inject: [CLOCK], useFactory: (c: Clock) => new GetShadowSummary(shadowStore, c) },
        { provide: T.RANKING_PURGE, inject: [CLOCK], useFactory: (c: Clock) => new PurgeShadowLogs(shadowStore, c) },
        {
          provide: T.RANKING_RUN_EVAL,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => new RunEvaluation(models, evalStore, c, ids),
        },
        { provide: T.RANKING_LIST_EVAL, useValue: new ListEvaluations(evalStore) },
        { provide: T.RANKING_GUARDRAILS, useValue: new EvaluateGuardrails(o.guardrailConfig) },
      ],
      exports: [T.RANKING_SHADOW_OBSERVER, T.RANKING_PURGE, T.RANKING_SHADOW_STORE, T.RANKING_EVAL_STORE, T.RANKING_RANKER],
    };
  }
}
