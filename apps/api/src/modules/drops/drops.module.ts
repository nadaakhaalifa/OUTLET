import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { DropGate } from "./adapters/gate";
import { DropsController } from "./adapters/drops.controller";
import { FakeDropSwitches, FakeSocialSignals, InMemoryDropInventory, InMemoryDropStore, InMemorySoldOutFlags } from "./adapters/in-memory";
import { AdminConsoleResolver, DropResolver, StoreListResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import { AdvanceDrops } from "./application/advance";
import {
  AdminControlDrop,
  CreateDrop,
  EditDrop,
  GetDrop,
  GetPublicDropView,
  JoinWaitlist,
  ListPublicDrops,
  ListSellerDrops,
  RemoveDrop,
  ScheduleDrop,
} from "./application/drops";
import { ClaimDropUnits, ReleaseDropUnits, ReserveDropUnits } from "./application/purchase";
import { DEFAULT_DROPS_CONFIG, type DropDeps, type DropsConfig } from "./application/shared";
import type {
  AdmissionVerifierPort,
  DropInventoryPort,
  DropStore,
  SocialSignalsPort,
  SoldOutFlagPort,
  SwitchPort,
} from "./domain/ports";

export interface DropsModuleOptions {
  readonly config?: DropsConfig;
  /** KyselyDropStore once persistence is wired. */
  readonly store?: DropStore;
  readonly inventory?: DropInventoryPort;
  readonly flags?: SoldOutFlagPort;
  readonly signals?: SocialSignalsPort;
  readonly switches?: SwitchPort;
  readonly verifier?: AdmissionVerifierPort;
}

export class MissingDropsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`DropsModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingDropsPortsError";
  }
}

@Module({})
export class DropsModule {
  static forRoot(config: AppConfig, o: DropsModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.inventory === undefined) missing.push("inventory (row-per-unit pool)");
      if (o.flags === undefined) missing.push("flags (sold-out pre-filter)");
      if (o.signals === undefined) missing.push("signals (viewing-now events)");
      if (o.switches === undefined) missing.push("switches (feature flags)");
      if (o.verifier === undefined) missing.push("verifier (waiting-room admission)");
      if (missing.length > 0) throw new MissingDropsPortsError(missing);
    }
    const cfg = o.config ?? DEFAULT_DROPS_CONFIG;
    const store = o.store ?? new InMemoryDropStore();
    const inventory = o.inventory ?? new InMemoryDropInventory();
    const signals = o.signals ?? new FakeSocialSignals();
    const switches = o.switches ?? new FakeDropSwitches();
    const verifier = o.verifier;

    const RUNTIME = Symbol("drops.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const flags = o.flags ?? new InMemorySoldOutFlags(() => clock.nowMs());
      const noVerifier: AdmissionVerifierPort = {
        verify: async () => ({ ok: false, code: "no_verifier" }),
        consume: async () => "unknown",
      };
      const d: DropDeps = { store, inventory, flags, signals, switches, verifier: verifier ?? noVerifier, clock, ids, cfg };
      return {
        flags,
        gate: new DropGate(store, flags, clock, cfg.preQueueMs),
        create: new CreateDrop(d),
        edit: new EditDrop(d),
        schedule: new ScheduleDrop(d),
        remove: new RemoveDrop(d),
        get: new GetDrop(d),
        sellerList: new ListSellerDrops(d),
        publicList: new ListPublicDrops(d),
        publicGet: new GetPublicDropView(d),
        control: new AdminControlDrop(d),
        waitlist: new JoinWaitlist(d),
        advance: new AdvanceDrops(d),
        reserve: new ReserveDropUnits(d),
        release: new ReleaseDropUnits(d),
        claim: new ClaimDropUnits(d),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });
    return {
      module: DropsModule,
      controllers: [DropsController],
      providers: [
        { provide: T.DROP_STORE, useValue: store },
        { provide: T.DROP_INVENTORY, useValue: inventory },
        { provide: T.DROP_SIGNALS, useValue: signals },
        { provide: T.DROP_SWITCHES, useValue: switches },
        { provide: T.DROP_RESOLVER, useValue: new DropResolver(store) },
        { provide: T.DROP_STORE_LIST_RESOLVER, useValue: new StoreListResolver() },
        { provide: T.DROP_ADMIN_RESOLVER, useValue: new AdminConsoleResolver() },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, i: IdGenerator) => runtime(c, i) },
        from(T.DROP_FLAGS, (r) => r.flags),
        from(T.DROP_GATE, (r) => r.gate),
        from(T.CREATE_DROP, (r) => r.create),
        from(T.EDIT_DROP, (r) => r.edit),
        from(T.SCHEDULE_DROP, (r) => r.schedule),
        from(T.REMOVE_DROP, (r) => r.remove),
        from(T.GET_SELLER_DROP, (r) => r.get),
        from(T.LIST_SELLER_DROPS, (r) => r.sellerList),
        from(T.LIST_PUBLIC_DROPS, (r) => r.publicList),
        from(T.GET_PUBLIC_DROP, (r) => r.publicGet),
        from(T.ADMIN_CONTROL_DROP, (r) => r.control),
        from(T.JOIN_WAITLIST, (r) => r.waitlist),
        from(T.ADVANCE_DROPS, (r) => r.advance),
        from(T.RESERVE_DROP_UNITS, (r) => r.reserve),
        from(T.RELEASE_DROP_UNITS, (r) => r.release),
        from(T.CLAIM_DROP_UNITS, (r) => r.claim),
      ],
      exports: [T.DROP_GATE, T.ADVANCE_DROPS, T.RESERVE_DROP_UNITS, T.RELEASE_DROP_UNITS, T.CLAIM_DROP_UNITS],
    };
  }
}
