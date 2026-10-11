import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  FakeCatalog,
  FakeFlags,
  FakePersonalization,
  FakeUserSizes,
  InMemoryRecoStore,
  InMemoryVectorIndex,
  SeededRngPort,
  SpyRanker,
} from "./adapters/in-memory";
import { RecommendationsController } from "./adapters/recommendations.controller";
import * as T from "./adapters/tokens";
import {
  BuildCooccurrence,
  BuildFeed,
  PriceDroppedOnViewed,
  RecordRecommendationClick,
  RestockReminders,
  SimilarProducts,
  type RecoDeps,
} from "./application/recommendations";
import type {
  AffordabilityFilterPort,
  CatalogPort,
  FlagPort,
  PersonalizationReadPort,
  RankerPort,
  RecoStore,
  RngPort,
  UserSizePort,
  VectorIndexPort,
} from "./domain/ports";

export interface RecommendationsModuleOptions {
  readonly store?: RecoStore;
  readonly catalog?: CatalogPort;
  readonly vectors?: VectorIndexPort;
  readonly ranker?: RankerPort;
  readonly personalization?: PersonalizationReadPort;
  readonly sizes?: UserSizePort;
  readonly flags?: FlagPort;
  readonly rng?: RngPort;
  /** Spec 03 budget module. Optional: absent means the affordable=true parameter is ignored. */
  readonly affordability?: AffordabilityFilterPort;
}

/** Outside test mode a stub catalog or ranker would rank invented products. */
export class MissingRecommendationsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`RecommendationsModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingRecommendationsPortsError";
  }
}

@Module({})
export class RecommendationsModule {
  static forRoot(config: AppConfig, o: RecommendationsModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.catalog === undefined) missing.push("catalog (candidates + price integrity claim)");
      if (o.vectors === undefined) missing.push("vectors (VectorIndexPort)");
      if (o.ranker === undefined) missing.push("ranker (versioned LTR model)");
      if (o.personalization === undefined) missing.push("personalization (history read side)");
      if (o.sizes === undefined) missing.push("sizes (size labels)");
      if (o.flags === undefined) missing.push("flags (kill.ml_ranking)");
      if (missing.length > 0) throw new MissingRecommendationsPortsError(missing);
    }
    const store = o.store ?? new InMemoryRecoStore();
    const catalog = o.catalog ?? new FakeCatalog();
    const vectors = o.vectors ?? new InMemoryVectorIndex();
    const ranker = o.ranker ?? new SpyRanker();
    const personalization = o.personalization ?? new FakePersonalization();
    const sizes = o.sizes ?? new FakeUserSizes();
    const flags = o.flags ?? new FakeFlags();
    const rng = o.rng ?? new SeededRngPort(Date.now() % 2 ** 31);
    const affordability = o.affordability ?? null;

    const RUNTIME = Symbol("recommendations.Runtime");
    const runtime = (clock: Clock) => {
      const d: RecoDeps = { store, catalog, vectors, ranker, personalization, sizes, flags, rng, clock, affordability };
      return {
        feed: new BuildFeed(d),
        similar: new SimilarProducts(d),
        restock: new RestockReminders(d),
        drops: new PriceDroppedOnViewed(d),
        click: new RecordRecommendationClick(d),
        cooccurrence: new BuildCooccurrence(d),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });

    return {
      module: RecommendationsModule,
      controllers: [RecommendationsController],
      providers: [
        { provide: T.RECO_STORE, useValue: store },
        { provide: T.RECO_CATALOG, useValue: catalog },
        { provide: T.RECO_VECTORS, useValue: vectors },
        { provide: T.RECO_RANKER, useValue: ranker },
        { provide: T.RECO_PERSONALIZATION, useValue: personalization },
        { provide: T.RECO_SIZES, useValue: sizes },
        { provide: T.RECO_FLAGS, useValue: flags },
        { provide: T.RECO_RNG, useValue: rng },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, _ids: IdGenerator) => runtime(c) },
        from(T.BUILD_FEED, (r) => r.feed),
        from(T.SIMILAR_PRODUCTS, (r) => r.similar),
        from(T.RESTOCK_REMINDERS, (r) => r.restock),
        from(T.PRICE_DROPPED_ON_VIEWED, (r) => r.drops),
        from(T.RECORD_RECOMMENDATION_CLICK, (r) => r.click),
        from(T.BUILD_COOCCURRENCE, (r) => r.cooccurrence),
      ],
    };
  }
}
