import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  FakeHubLedger,
  FakeOutboundCourier,
  FakeParcelFacts,
  InMemoryHubMetrics,
  InMemoryHubStore,
  StaticHubFlags,
} from "./adapters/in-memory";
import { HubController } from "./adapters/hub.controller";
import { OperatorHubResolver, OrderGroupResolver, ParcelResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import {
  DispatchHubParcel,
  EvaluateHubGroup,
  GetHubTracking,
  OpenHubGroup,
  RecordHubReceipt,
  SweepHubGroups,
  type HubDeps,
} from "./application/hub";
import type { HubConfig } from "./domain/bridge";
import type {
  HubFlagsPort,
  HubLedgerPort,
  HubMetrics,
  HubStore,
  OutboundCourierPort,
  ParcelFactsPort,
} from "./domain/ports";

export interface HubConsolidationOptions {
  readonly config?: HubConfig;
  /** Replaces the in-memory store (KyselyHubStore) once persistence is wired. */
  readonly store?: HubStore;
  /** Backed by packages/feature-flags `kill.hub_consolidation`. Fails closed. */
  readonly flags?: HubFlagsPort;
  readonly facts?: ParcelFactsPort;
  readonly outbound?: OutboundCourierPort;
  readonly ledger?: HubLedgerPort;
  readonly metrics?: HubMetrics;
}

/** Thrown outside test mode when a port owned by another module is missing. */
export class MissingHubPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`HubConsolidationModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingHubPortsError";
  }
}

@Module({})
export class HubConsolidationModule {
  static forRoot(config: AppConfig, o: HubConsolidationOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.flags === undefined) missing.push("flags (kill.hub_consolidation)");
      if (o.facts === undefined) missing.push("facts (parcel recipient, weight and distances)");
      if (o.outbound === undefined) missing.push("outbound (courier router over the fulfillment CourierPorts)");
      if (o.ledger === undefined) missing.push("ledger (balanced journal posting)");
      if (missing.length > 0) throw new MissingHubPortsError(missing);
    }
    const store = o.store ?? new InMemoryHubStore();
    const flags = o.flags ?? new StaticHubFlags(true);
    const facts = o.facts ?? new FakeParcelFacts();
    const outbound = o.outbound ?? new FakeOutboundCourier();
    const ledger = o.ledger ?? new FakeHubLedger();
    const metrics = o.metrics ?? new InMemoryHubMetrics();

    const RUNTIME = Symbol("hub.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: HubDeps = {
        store,
        flags,
        facts,
        outbound,
        ledger,
        metrics,
        clock,
        ids,
        ...(o.config === undefined ? {} : { config: o.config }),
      };
      const evaluate = new EvaluateHubGroup(d);
      return {
        open: new OpenHubGroup(d),
        evaluate,
        receipt: new RecordHubReceipt(d, evaluate),
        dispatch: new DispatchHubParcel(d),
        sweep: new SweepHubGroups(d, evaluate),
        tracking: new GetHubTracking(d),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });
    return {
      module: HubConsolidationModule,
      controllers: [HubController],
      providers: [
        { provide: T.HUB_STORE, useValue: store },
        { provide: T.HUB_FLAGS, useValue: flags },
        { provide: T.HUB_FACTS, useValue: facts },
        { provide: T.HUB_OUTBOUND, useValue: outbound },
        { provide: T.HUB_LEDGER, useValue: ledger },
        { provide: T.HUB_METRICS, useValue: metrics },
        { provide: T.HUB_LEG_RESOLVER, useValue: new OperatorHubResolver() },
        { provide: T.HUB_PARCEL_RESOLVER, useValue: new ParcelResolver(store) },
        { provide: T.HUB_GROUP_RESOLVER, useValue: new OrderGroupResolver(store) },
        {
          provide: RUNTIME,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids),
        },
        from(T.OPEN_HUB_GROUP, (r) => r.open),
        from(T.EVALUATE_HUB_GROUP, (r) => r.evaluate),
        from(T.RECORD_HUB_RECEIPT, (r) => r.receipt),
        from(T.DISPATCH_HUB_PARCEL, (r) => r.dispatch),
        from(T.SWEEP_HUB_GROUPS, (r) => r.sweep),
        from(T.GET_HUB_TRACKING, (r) => r.tracking),
      ],
    };
  }
}
