import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  FakeAgePolicy,
  FakeCardVault,
  FakeFlags,
  FakeLedger,
  FakeNotices,
  FakePersonKeys,
  FakePlanApprovals,
  FakeRecurringCharges,
  FakeRefunds,
  FakeTaxReceipts,
  HmacKeyHasher,
  InMemorySubscriptionStore,
} from "./adapters/in-memory";
import { SubscriptionsController } from "./adapters/controller";
import { PlusAdminResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import { GetMyPlus, PlusEntitlements, RecordBenefitUsed, ReverseBenefit } from "./application/member";
import {
  CancelPlus,
  PausePlus,
  ReactivatePlus,
  RefundPlus,
  ResumePlus,
  SwitchPlan,
} from "./application/manage";
import { ListPlanVersions, ListPlans, PublishPlanVersion, SetPlanActive } from "./application/plans";
import { DEFAULT_PLUS_CONFIG, type PlusConfig, type PlusDeps } from "./application/shared";
import { Subscribe } from "./application/subscribe";
import { HandleRecurringWebhook, RecognizeDeferredRevenue, RunRenewalSweep } from "./application/sweeper";
import type {
  AgePolicyPort,
  CardVaultPort,
  FeatureGatePort,
  KeyHasherPort,
  LedgerPort,
  MemberNoticePort,
  PersonKeyPort,
  PlanPriceApprovalPort,
  PlusRefundPort,
  RecurringChargePort,
  RecurringWebhookVerifierPort,
  SubscriptionStore,
  TaxReceiptPort,
} from "./domain/ports";

export interface SubscriptionsModuleOptions {
  readonly config?: PlusConfig;
  /** Replaces the in-memory store (KyselySubscriptionStore) once persistence is wired. */
  readonly store?: SubscriptionStore;
  readonly ages?: AgePolicyPort;
  readonly persons?: PersonKeyPort;
  readonly vault?: CardVaultPort;
  readonly charges?: RecurringChargePort;
  readonly refunds?: PlusRefundPort;
  readonly ledger?: LedgerPort;
  readonly receipts?: TaxReceiptPort;
  readonly notices?: MemberNoticePort;
  readonly flags?: FeatureGatePort;
  readonly approvals?: PlanPriceApprovalPort;
  readonly hasher?: KeyHasherPort;
  readonly webhookVerifier?: RecurringWebhookVerifierPort;
}

/**
 * Thrown outside test mode when a port owned by another module is missing: Plus must never charge
 * through a scripted fake, post to a fake ledger, or decide the age gate from an empty fixture.
 */
export class MissingSubscriptionsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`SubscriptionsModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingSubscriptionsPortsError";
  }
}

const rejectingVerifier: RecurringWebhookVerifierPort = {
  async verify() {
    return { kind: "rejected" };
  },
};

@Module({})
export class SubscriptionsModule {
  static forRoot(config: AppConfig, o: SubscriptionsModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.ages === undefined) missing.push("ages (age_policy)");
      if (o.persons === undefined) missing.push("persons (phone hash)");
      if (o.vault === undefined) missing.push("vault (card fingerprint)");
      if (o.charges === undefined) missing.push("charges (PSP recurring)");
      if (o.refunds === undefined) missing.push("refunds (RefundRouter)");
      if (o.ledger === undefined) missing.push("ledger");
      if (o.receipts === undefined) missing.push("receipts (tax-eta)");
      if (o.notices === undefined) missing.push("notices");
      if (o.flags === undefined) missing.push("flags (feature-flags)");
      if (o.approvals === undefined) missing.push("approvals (dual approval)");
      if (o.hasher === undefined) missing.push("hasher (HMAC key)");
      if (o.webhookVerifier === undefined) missing.push("webhookVerifier (PSP MAC)");
      if (missing.length > 0) throw new MissingSubscriptionsPortsError(missing);
    }
    const store = o.store ?? new InMemorySubscriptionStore();
    const ages = o.ages ?? new FakeAgePolicy();
    const persons = o.persons ?? new FakePersonKeys();
    const vault = o.vault ?? new FakeCardVault();
    const charges = o.charges ?? new FakeRecurringCharges();
    const refunds = o.refunds ?? new FakeRefunds();
    const ledger = o.ledger ?? new FakeLedger();
    const receipts = o.receipts ?? new FakeTaxReceipts();
    const notices = o.notices ?? new FakeNotices();
    const flags = o.flags ?? new FakeFlags();
    const approvals = o.approvals ?? new FakePlanApprovals();
    const hasher = o.hasher ?? new HmacKeyHasher("dev-only-trial-key");
    const verifier = o.webhookVerifier ?? rejectingVerifier;
    const cfg = o.config ?? DEFAULT_PLUS_CONFIG;

    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: PlusDeps = { store, clock, ids, cfg, ledger, receipts, notices, flags, charges, refunds, ages, persons, vault, hasher };
      return {
        plans: new ListPlans(store, clock),
        subscribe: new Subscribe(d),
        cancel: new CancelPlus(d),
        reactivate: new ReactivatePlus(d),
        pause: new PausePlus(d),
        resume: new ResumePlus(d),
        switchPlan: new SwitchPlan(d),
        refund: new RefundPlus(d),
        mine: new GetMyPlus(store, clock),
        entitlements: new PlusEntitlements(store, clock),
        recordBenefit: new RecordBenefitUsed(store, clock, ids),
        reverseBenefit: new ReverseBenefit(store, clock),
        sweep: new RunRenewalSweep(d),
        recognize: new RecognizeDeferredRevenue(d),
        webhook: new HandleRecurringWebhook(d),
        publish: new PublishPlanVersion(store, clock, ids, approvals, notices),
        setActive: new SetPlanActive(store),
        versions: new ListPlanVersions(store),
      };
    };
    const RUNTIME = Symbol("subscriptions.Runtime");
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });

    return {
      module: SubscriptionsModule,
      controllers: [SubscriptionsController],
      providers: [
        { provide: T.PLUS_STORE, useValue: store },
        { provide: T.PLUS_WEBHOOK_VERIFIER, useValue: verifier },
        { provide: T.PLUS_ADMIN_RESOLVER, useValue: new PlusAdminResolver() },
        {
          provide: RUNTIME,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids),
        },
        from(T.PLUS_LIST_PLANS, (r) => r.plans),
        from(T.PLUS_SUBSCRIBE, (r) => r.subscribe),
        from(T.PLUS_CANCEL, (r) => r.cancel),
        from(T.PLUS_REACTIVATE, (r) => r.reactivate),
        from(T.PLUS_PAUSE, (r) => r.pause),
        from(T.PLUS_RESUME, (r) => r.resume),
        from(T.PLUS_SWITCH, (r) => r.switchPlan),
        from(T.PLUS_REFUND, (r) => r.refund),
        from(T.PLUS_MINE, (r) => r.mine),
        from(T.PLUS_ENTITLEMENTS, (r) => r.entitlements),
        from(T.PLUS_RECORD_BENEFIT, (r) => r.recordBenefit),
        from(T.PLUS_REVERSE_BENEFIT, (r) => r.reverseBenefit),
        from(T.PLUS_RENEWAL_SWEEP, (r) => r.sweep),
        from(T.PLUS_RECOGNIZE_REVENUE, (r) => r.recognize),
        from(T.PLUS_WEBHOOK, (r) => r.webhook),
        from(T.PLUS_PUBLISH_PLAN, (r) => r.publish),
        from(T.PLUS_SET_PLAN_ACTIVE, (r) => r.setActive),
        from(T.PLUS_LIST_PLAN_VERSIONS, (r) => r.versions),
      ],
    };
  }
}
