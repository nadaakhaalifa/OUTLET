import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { FakeConsent, FakeFlags, FakeProductLookup, InMemoryHistoryStore } from "./adapters/in-memory";
import { HistoryController } from "./adapters/history.controller";
import * as T from "./adapters/tokens";
import {
  BuildUserFeatures,
  ClearHistory,
  ListHistory,
  ListRecentlyViewed,
  PurgeExpiredEvents,
  RebuildFeaturesBatch,
  RecordHistoryEvent,
  RecordProductView,
  SetHistoryPaused,
  SetPersonalization,
  SweepClearRequests,
  type HistoryDeps,
} from "./application/history";
import type { FlagPort, HistoryStore, PersonalizationConsentPort, ProductLookupPort } from "./domain/ports";

export interface HistoryModuleOptions {
  /** Replaces the in-memory store (KyselyHistoryStore) once persistence is wired. */
  readonly store?: HistoryStore;
  readonly consent?: PersonalizationConsentPort;
  readonly products?: ProductLookupPort;
  readonly flags?: FlagPort;
}

/** Outside test mode a missing port would silently build or hide personalization from fixtures. */
export class MissingHistoryPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`HistoryModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingHistoryPortsError";
  }
}

@Module({})
export class HistoryModule {
  static forRoot(config: AppConfig, o: HistoryModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.consent === undefined) missing.push("consent (personalization purpose)");
      if (o.products === undefined) missing.push("products (catalog snapshot)");
      if (o.flags === undefined) missing.push("flags (kill.ml_ranking)");
      if (missing.length > 0) throw new MissingHistoryPortsError(missing);
    }
    const store = o.store ?? new InMemoryHistoryStore();
    const consent = o.consent ?? new FakeConsent();
    const products = o.products ?? new FakeProductLookup();
    const flags = o.flags ?? new FakeFlags();

    const RUNTIME = Symbol("history.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: HistoryDeps = { store, clock, ids };
      const record = new RecordHistoryEvent(d);
      const build = new BuildUserFeatures(d, consent, flags);
      return {
        record,
        list: new ListHistory(d),
        clear: new ClearHistory(d),
        pause: new SetHistoryPaused(d),
        personalization: new SetPersonalization(d),
        view: new RecordProductView(d, products, record),
        recent: new ListRecentlyViewed(d, products),
        build,
        rebuild: new RebuildFeaturesBatch(d, build),
        sweep: new SweepClearRequests(d),
        purge: new PurgeExpiredEvents(d),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });

    return {
      module: HistoryModule,
      controllers: [HistoryController],
      providers: [
        { provide: T.HISTORY_STORE, useValue: store },
        { provide: T.HISTORY_CONSENT, useValue: consent },
        { provide: T.HISTORY_PRODUCTS, useValue: products },
        { provide: T.HISTORY_FLAGS, useValue: flags },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids) },
        from(T.RECORD_HISTORY_EVENT, (r) => r.record),
        from(T.LIST_HISTORY, (r) => r.list),
        from(T.CLEAR_HISTORY, (r) => r.clear),
        from(T.SET_HISTORY_PAUSED, (r) => r.pause),
        from(T.SET_PERSONALIZATION, (r) => r.personalization),
        from(T.RECORD_PRODUCT_VIEW, (r) => r.view),
        from(T.LIST_RECENTLY_VIEWED, (r) => r.recent),
        from(T.BUILD_USER_FEATURES, (r) => r.build),
        from(T.REBUILD_FEATURES_BATCH, (r) => r.rebuild),
        from(T.SWEEP_CLEAR_REQUESTS, (r) => r.sweep),
        from(T.PURGE_EXPIRED_EVENTS, (r) => r.purge),
      ],
      exports: [
        T.HISTORY_STORE,
        T.RECORD_HISTORY_EVENT,
      ],
    };
  }
}
