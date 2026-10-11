import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  DevAesGcmFieldCipher,
  FakeBagTotal,
  FakeBudgetConsent,
  FakeBudgetFlags,
  FakeOrderSpendSource,
  FakeWishlistPlanSource,
  InMemoryBudgetStore,
} from "./adapters/in-memory";
import { BudgetController } from "./adapters/budget.controller";
import * as T from "./adapters/tokens";
import { AffordabilityFilter, PlanMyPurchases } from "./application/affordability";
import { DeleteBudget, GetSummary, SetBudget } from "./application/budget";
import { CheckoutCapGuard, RequestCapUnlock } from "./application/caps";
import { BudgetCodec } from "./application/codec";
import { ExportBudgetData, PurgeUserBudget, RollCycles } from "./application/lifecycle";
import { IngestProviderCommitments, ReconcileSpend, RecordSpend } from "./application/spend";
import type { BudgetDeps } from "./application/shared";
import type {
  BagTotalPort,
  BudgetConsentPort,
  BudgetFlagsPort,
  BudgetStore,
  FieldCipherPort,
  OrderSpendSourcePort,
  WishlistPlanSourcePort,
} from "./domain/ports";

export interface BudgetModuleOptions {
  /** Replaces the in-memory store (KyselyBudgetStore) once persistence is wired. */
  readonly store?: BudgetStore;
  readonly consent?: BudgetConsentPort;
  readonly cipher?: FieldCipherPort;
  readonly spendSource?: OrderSpendSourcePort;
  readonly bag?: BagTotalPort;
  readonly wishlists?: WishlistPlanSourcePort;
  readonly flags?: BudgetFlagsPort;
}

/**
 * Thrown outside test mode when a port owned by another module is missing: the budget module
 * must never decide consent or encrypt P3 data from a development fixture in production.
 */
export class MissingBudgetPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`BudgetModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingBudgetPortsError";
  }
}

@Module({})
export class BudgetModule {
  static forRoot(config: AppConfig, o: BudgetModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.consent === undefined) missing.push("consent (budget_insights, privacy module)");
      if (o.cipher === undefined) missing.push("cipher (KMS envelope field encryption)");
      if (o.spendSource === undefined) missing.push("spendSource (orders)");
      if (o.bag === undefined) missing.push("bag (cart)");
      if (o.wishlists === undefined) missing.push("wishlists");
      if (o.flags === undefined) missing.push("flags (release.budget_suite, kill.budget_caps)");
      if (missing.length > 0) throw new MissingBudgetPortsError(missing);
    }
    const store = o.store ?? new InMemoryBudgetStore();
    const consent = o.consent ?? new FakeBudgetConsent();
    const cipher = o.cipher ?? new DevAesGcmFieldCipher();
    const spendSource = o.spendSource ?? new FakeOrderSpendSource();
    const bag = o.bag ?? new FakeBagTotal();
    const wishlists = o.wishlists ?? new FakeWishlistPlanSource();
    const flags = o.flags ?? new FakeBudgetFlags();

    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: BudgetDeps = { store, clock, ids, consent, codec: new BudgetCodec(cipher), flags, spendSource, bag };
      return {
        set: new SetBudget(d),
        summary: new GetSummary(d),
        remove: new DeleteBudget(d),
        filter: new AffordabilityFilter(d),
        plan: new PlanMyPurchases(d, wishlists),
        unlock: new RequestCapUnlock(d),
        guard: new CheckoutCapGuard(d),
        record: new RecordSpend(d),
        reconcile: new ReconcileSpend(d),
        ingest: new IngestProviderCommitments(d),
        roll: new RollCycles(d, store),
        purge: new PurgeUserBudget(d),
        exporter: new ExportBudgetData(d),
      };
    };
    const RUNTIME = Symbol("budget.Runtime");
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });
    const exported = [
      T.AFFORDABILITY_FILTER,
      T.CHECKOUT_CAP_GUARD,
      T.RECORD_SPEND,
      T.RECONCILE_SPEND,
      T.INGEST_PROVIDER_COMMITMENTS,
      T.ROLL_CYCLES,
      T.PURGE_USER_BUDGET,
      T.EXPORT_BUDGET_DATA,
    ];

    return {
      module: BudgetModule,
      controllers: [BudgetController],
      providers: [
        { provide: T.BUDGET_STORE, useValue: store },
        { provide: T.BUDGET_CONSENT, useValue: consent },
        { provide: T.BUDGET_CIPHER, useValue: cipher },
        { provide: T.BUDGET_SPEND_SOURCE, useValue: spendSource },
        { provide: T.BUDGET_BAG, useValue: bag },
        { provide: T.BUDGET_WISHLISTS, useValue: wishlists },
        { provide: T.BUDGET_FLAGS, useValue: flags },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids) },
        from(T.SET_BUDGET, (r) => r.set),
        from(T.GET_SUMMARY, (r) => r.summary),
        from(T.DELETE_BUDGET, (r) => r.remove),
        from(T.AFFORDABILITY_FILTER, (r) => r.filter),
        from(T.PLAN_MY_PURCHASES, (r) => r.plan),
        from(T.REQUEST_CAP_UNLOCK, (r) => r.unlock),
        from(T.CHECKOUT_CAP_GUARD, (r) => r.guard),
        from(T.RECORD_SPEND, (r) => r.record),
        from(T.RECONCILE_SPEND, (r) => r.reconcile),
        from(T.INGEST_PROVIDER_COMMITMENTS, (r) => r.ingest),
        from(T.ROLL_CYCLES, (r) => r.roll),
        from(T.PURGE_USER_BUDGET, (r) => r.purge),
        from(T.EXPORT_BUDGET_DATA, (r) => r.exporter),
      ],
      exports: exported,
    };
  }
}
