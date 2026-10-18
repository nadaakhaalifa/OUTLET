import { Module, type DynamicModule } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { AutoBuyController } from "./adapters/auto-buy.controller";
import { AutoBuyOpsController } from "./adapters/auto-buy-ops.controller";
import { AutoBuyOpsAccess } from "./adapters/ops-access";
import { ManualReviewQueue } from "./application/ops";
import { NotificationsNoticePort } from "./adapters/notifier";
import {
  FakeAutoBuyFlags,
  FakeBudgetGate,
  FakeCardVault,
  FakeCatalogQuote,
  FakeDeliverability,
  FakeInventoryHold,
  FakeMemberEligibility,
  FakeMitCheckout,
  FakeNotices,
  FakeRisk,
  InMemoryAutoBuyStore,
  RecordingOpsAudit,
} from "./adapters/in-memory";
import * as T from "./adapters/tokens";
import { CancelAttempt, CancelMandate } from "./application/cancel";
import { CreateMandate } from "./application/create";
import { AutoBuyEventConsumer } from "./application/events";
import { HandlePriceChange } from "./application/evaluate";
import { CancelAllForUser, CloseOnPurchase } from "./application/lifecycle";
import { ListMandates } from "./application/queries";
import type { AutoBuyDeps } from "./application/shared";
import { RunAutoBuySweep } from "./application/sweep";
import type {
  AutoBuyFlagsPort,
  AutoBuyStore,
  BudgetGatePort,
  CardVaultPort,
  CatalogQuotePort,
  DeliverabilityPort,
  InventoryHoldPort,
  MemberEligibilityPort,
  MitCheckoutPort,
  NoticePort,
  OpsAuditPort,
  RiskPort,
} from "./domain/ports";

export interface AutoBuyModuleOptions {
  /** Replaces the in-memory store (KyselyAutoBuyStore) once persistence is wired. */
  readonly store?: AutoBuyStore;
  readonly flags?: AutoBuyFlagsPort;
  readonly eligibility?: MemberEligibilityPort;
  readonly catalog?: CatalogQuotePort;
  readonly deliverability?: DeliverabilityPort;
  readonly risk?: RiskPort;
  readonly budget?: BudgetGatePort;
  readonly vault?: CardVaultPort;
  readonly inventory?: InventoryHoldPort;
  readonly mit?: MitCheckoutPort;
  /** A port, or "notifications" to send through the notifications module (resolved lazily). */
  readonly notices?: NoticePort | "notifications";
  /** Hash-chained audit log for the MANUAL_REVIEW ops routes (admin audit). Required in production. */
  readonly opsAudit?: OpsAuditPort;
}

/**
 * Thrown outside test mode when a port owned by another module is missing: auto-buy must never
 * decide eligibility, risk or a charge from a development fixture in production.
 */
export class MissingAutoBuyPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`AutoBuyModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingAutoBuyPortsError";
  }
}

@Module({})
export class AutoBuyModule {
  static forRoot(config: AppConfig, o: AutoBuyModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing = (
        [
          ["flags", o.flags],
          ["eligibility (subscriptions)", o.eligibility],
          ["catalog", o.catalog],
          ["deliverability", o.deliverability],
          ["risk", o.risk],
          ["budget", o.budget],
          ["vault (PSP card tokens)", o.vault],
          ["inventory", o.inventory],
          ["mit (merchant-initiated checkout)", o.mit],
          ["notices", o.notices],
          ["opsAudit (admin audit log)", o.opsAudit],
        ] as const
      )
        .filter(([, v]) => v === undefined)
        .map(([k]) => k);
      if (missing.length > 0) throw new MissingAutoBuyPortsError(missing);
    }
    const store = o.store ?? new InMemoryAutoBuyStore();
    const ports = {
      flags: o.flags ?? new FakeAutoBuyFlags(false, false),
      eligibility: o.eligibility ?? new FakeMemberEligibility(),
      catalog: o.catalog ?? new FakeCatalogQuote(),
      deliverability: o.deliverability ?? new FakeDeliverability(),
      risk: o.risk ?? new FakeRisk(),
      budget: o.budget ?? new FakeBudgetGate(),
      vault: o.vault ?? new FakeCardVault(),
      inventory: o.inventory ?? new FakeInventoryHold(),
      mit: o.mit ?? new FakeMitCheckout(),
      notices: o.notices ?? new FakeNotices(),
      opsAudit: o.opsAudit ?? new RecordingOpsAudit(),
    };
    const noticesProvider = {
      provide: T.AUTO_BUY_NOTICES,
      inject: [ModuleRef],
      useFactory: (ref: ModuleRef): NoticePort => (ports.notices === "notifications" ? NotificationsNoticePort.lazy(ref) : ports.notices),
    };

    const runtime = (clock: Clock, ids: IdGenerator, notices: NoticePort) => {
      const { opsAudit: _opsAudit, ...rest } = ports;
      void _opsAudit;
      const d: AutoBuyDeps = { store, clock, ids, ...rest, notices };
      return {
        create: new CreateMandate(d),
        list: new ListMandates(d),
        cancelRule: new CancelMandate(d),
        cancelAttempt: new CancelAttempt(d),
        handle: new HandlePriceChange(d),
        sweep: new RunAutoBuySweep(d),
        closeOnPurchase: new CloseOnPurchase(d),
        cancelAll: new CancelAllForUser(d),
        manualReview: new ManualReviewQueue(d),
        events: new AutoBuyEventConsumer(new HandlePriceChange(d), new CancelAllForUser(d), new CloseOnPurchase(d)),
      };
    };
    const RUNTIME = Symbol("autoBuy.Runtime");
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });

    return {
      module: AutoBuyModule,
      controllers: [AutoBuyController, AutoBuyOpsController],
      providers: [
        AutoBuyOpsAccess,
        { provide: T.AUTO_BUY_OPS_AUDIT, useValue: ports.opsAudit },
        { provide: T.AUTO_BUY_STORE, useValue: store },
        { provide: T.AUTO_BUY_FLAGS, useValue: ports.flags },
        { provide: T.AUTO_BUY_ELIGIBILITY, useValue: ports.eligibility },
        { provide: T.AUTO_BUY_CATALOG, useValue: ports.catalog },
        { provide: T.AUTO_BUY_DELIVERABILITY, useValue: ports.deliverability },
        { provide: T.AUTO_BUY_RISK, useValue: ports.risk },
        { provide: T.AUTO_BUY_BUDGET, useValue: ports.budget },
        { provide: T.AUTO_BUY_VAULT, useValue: ports.vault },
        { provide: T.AUTO_BUY_INVENTORY, useValue: ports.inventory },
        { provide: T.AUTO_BUY_MIT, useValue: ports.mit },
        noticesProvider,
        {
          provide: RUNTIME,
          inject: [CLOCK, ID_GENERATOR, T.AUTO_BUY_NOTICES],
          useFactory: (c: Clock, ids: IdGenerator, n: NoticePort) => runtime(c, ids, n),
        },
        from(T.CREATE_AUTO_BUY, (r) => r.create),
        from(T.LIST_AUTO_BUY, (r) => r.list),
        from(T.CANCEL_AUTO_BUY, (r) => r.cancelRule),
        from(T.CANCEL_AUTO_BUY_ATTEMPT, (r) => r.cancelAttempt),
        from(T.HANDLE_PRICE_CHANGE, (r) => r.handle),
        from(T.RUN_AUTO_BUY_SWEEP, (r) => r.sweep),
        from(T.CLOSE_ON_PURCHASE, (r) => r.closeOnPurchase),
        from(T.CANCEL_ALL_AUTO_BUY, (r) => r.cancelAll),
        from(T.AUTO_BUY_EVENT_CONSUMER, (r) => r.events),
        from(T.MANUAL_REVIEW_QUEUE, (r) => r.manualReview),
      ],
      exports: [T.HANDLE_PRICE_CHANGE, T.RUN_AUTO_BUY_SWEEP, T.CLOSE_ON_PURCHASE, T.CANCEL_ALL_AUTO_BUY, T.AUTO_BUY_EVENT_CONSUMER],
    };
  }
}
