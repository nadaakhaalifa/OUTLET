import { Module, type DynamicModule } from "@nestjs/common";
import type { Csprng } from "@outlet/auth-core";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, CSPRNG, ID_GENERATOR } from "../../platform/tokens";
import { CreatorAdminAccess } from "./adapters/access";
import { CreatorsAdminController, CreatorsController } from "./adapters/creators.controller";
import {
  FakeKycVault,
  InMemoryCreatorApprovals,
  InMemoryCreatorCatalog,
  InMemoryCreatorIdentity,
  InMemoryCreatorLedger,
  InMemoryCreatorReferrals,
  InMemoryCreatorStore,
  StaticCreatorFlags,
  StaticTerms,
  UnconfiguredCreatorPayoutProvider,
} from "./adapters/in-memory";
import * as T from "./adapters/tokens";
import { ApplyAsCreator, DecideCreator, SetPayoutPreference } from "./application/accounts";
import {
  AccrueClosedLine,
  ApplyLineRefund,
  GetCreatorDashboard,
  ListMyCommissions,
  PostCommissionIntents,
  ReleaseHeldCommissions,
} from "./application/commissions";
import {
  AttributeOrder,
  CreateLink,
  DisableLink,
  GetPublicCreator,
  ListLinks,
  LookCommands,
  MaintainClickPartitions,
  RecordClick,
  VoidAttribution,
} from "./application/links";
import { CreatorEventConsumer } from "./application/events";
import { CreatorPayoutCommands, ListCreatorPayouts } from "./application/payouts";
import type { CreatorRuntimeOptions } from "./application/shared";
import { DEFAULT_CREATOR_CONFIG, validateCreatorConfig, type CreatorConfig } from "./domain/bridge";
import type {
  CreatorApprovalsPort,
  CreatorCatalogPort,
  CreatorFlagsPort,
  CreatorIdentityPort,
  CreatorKycVaultPort,
  CreatorLedgerPort,
  CreatorPayoutProviderPort,
  CreatorReferralPort,
  CreatorStore,
  TermsPort,
} from "./domain/ports";

export interface CreatorsModuleOptions {
  readonly config?: CreatorConfig;
  readonly bankAccount?: string;
  readonly linkBase?: string;
  /** Secret salt for click hashes. Required outside in-memory-dev (fails closed). */
  readonly clickSalt?: string;
  /** Replaces the in-memory store (KyselyCreatorStore) once persistence is wired. */
  readonly store?: CreatorStore;
  readonly identity?: CreatorIdentityPort;
  readonly catalog?: CreatorCatalogPort;
  readonly ledger?: CreatorLedgerPort;
  /** `kill.creator_program` and `kill.creator_payouts`. Both fail closed when absent in production. */
  readonly flags?: CreatorFlagsPort;
  readonly kycVault?: CreatorKycVaultPort;
  readonly approvals?: CreatorApprovalsPort;
  /** Default: Unconfigured. Nothing is ever sent until a real rail is selected (ADR-0037, VR-P3-03). */
  readonly payoutProvider?: CreatorPayoutProviderPort;
  readonly terms?: TermsPort;
  /** One reward per order (A-4). Required outside in-memory-dev. */
  readonly referrals?: CreatorReferralPort;
}

export class MissingCreatorPortsError extends Error {
  public constructor(public readonly missing: readonly string[]) {
    super(`creators module needs ports in production: ${missing.join(", ")}`);
    this.name = "MissingCreatorPortsError";
  }
}

@Module({})
export class CreatorsModule {
  static forRoot(config: AppConfig, options: CreatorsModuleOptions = {}): DynamicModule {
    const dev = config.adapters === "in-memory-dev";
    if (!dev && options.store === undefined) throw new NoProductionAdaptersError();
    if (!dev) {
      // Money and identity ports must be real in production: fail closed instead of faking.
      const missing: string[] = [];
      if (options.ledger === undefined) missing.push("ledger");
      if (options.identity === undefined) missing.push("identity");
      if (options.catalog === undefined) missing.push("catalog");
      if (options.flags === undefined) missing.push("flags (kill.creator_program, kill.creator_payouts)");
      if (options.kycVault === undefined) missing.push("kycVault (kms.envelope)");
      if (options.approvals === undefined) missing.push("approvals");
      if (options.terms === undefined) missing.push("terms");
      if (options.referrals === undefined) missing.push("referrals (one reward per order)");
      if (options.clickSalt === undefined || options.clickSalt.length < 32) missing.push("clickSalt (>= 32 chars, secret)");
      if (missing.length > 0) throw new MissingCreatorPortsError(missing);
    }
    const runtime: CreatorRuntimeOptions = {
      config: validateCreatorConfig(options.config ?? DEFAULT_CREATOR_CONFIG),
      bankAccount: options.bankAccount ?? "creator_payouts",
      linkBase: options.linkBase ?? "https://outletnk.invalid/a",
      // Dev only: production is refused above without a real secret.
      clickSalt: options.clickSalt ?? "dev-only-click-salt-not-a-secret-0000",
    };
    const store = options.store ?? new InMemoryCreatorStore();
    const identity = options.identity ?? new InMemoryCreatorIdentity();
    const catalog = options.catalog ?? new InMemoryCreatorCatalog();
    const ledger = options.ledger ?? new InMemoryCreatorLedger();
    // Dev default: program on, payouts OFF. Production has no default at all (checked above).
    const flags = options.flags ?? new StaticCreatorFlags(true, false);
    const vault = options.kycVault ?? new FakeKycVault();
    const approvals = options.approvals ?? new InMemoryCreatorApprovals();
    const provider = options.payoutProvider ?? new UnconfiguredCreatorPayoutProvider();
    const terms = options.terms ?? new StaticTerms(1);
    const referrals = options.referrals ?? new InMemoryCreatorReferrals();
    const poster = (c: Clock, ids: IdGenerator) => new PostCommissionIntents(store, ledger, c, ids);

    return {
      module: CreatorsModule,
      controllers: [CreatorsController, CreatorsAdminController],
      providers: [
        CreatorAdminAccess,
        { provide: T.CREATOR_OPTIONS, useValue: runtime },
        { provide: T.CREATOR_STORE, useValue: store },
        { provide: T.CREATOR_IDENTITY, useValue: identity },
        { provide: T.CREATOR_CATALOG, useValue: catalog },
        { provide: T.CREATOR_LEDGER, useValue: ledger },
        { provide: T.CREATOR_FLAGS, useValue: flags },
        { provide: T.CREATOR_KYC_VAULT, useValue: vault },
        { provide: T.CREATOR_APPROVALS, useValue: approvals },
        { provide: T.CREATOR_PAYOUT_PROVIDER, useValue: provider },
        { provide: T.CREATOR_TERMS, useValue: terms },
        {
          provide: T.APPLY_AS_CREATOR,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => new ApplyAsCreator(store, identity, vault, terms, flags, c, ids, runtime),
        },
        {
          provide: T.DECIDE_CREATOR,
          inject: [CLOCK],
          useFactory: (c: Clock) => new DecideCreator(store, identity, c, runtime),
        },
        {
          provide: T.SET_PAYOUT_PREFERENCE,
          inject: [CLOCK],
          useFactory: (c: Clock) => new SetPayoutPreference(store, c),
        },
        {
          provide: T.CREATE_LINK,
          inject: [CLOCK, ID_GENERATOR, CSPRNG],
          useFactory: (c: Clock, ids: IdGenerator, rng: Csprng) => new CreateLink(store, identity, catalog, flags, c, ids, rng, runtime),
        },
        { provide: T.LIST_LINKS, useFactory: () => new ListLinks(store) },
        { provide: T.DISABLE_LINK, inject: [CLOCK], useFactory: (c: Clock) => new DisableLink(store, c) },
        {
          provide: T.RECORD_CLICK,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => new RecordClick(store, flags, c, ids, runtime),
        },
        {
          provide: T.ATTRIBUTE_ORDER,
          inject: [CLOCK],
          useFactory: (c: Clock) => new AttributeOrder(store, identity, flags, c, runtime, referrals),
        },
        {
          provide: T.LOOK_COMMANDS,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => new LookCommands(store, identity, catalog, flags, c, ids, runtime),
        },
        { provide: T.GET_PUBLIC_CREATOR, useFactory: () => new GetPublicCreator(store) },
        {
          provide: T.POST_COMMISSION_INTENTS,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => poster(c, ids),
        },
        {
          provide: T.ACCRUE_CLOSED_LINE,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => new AccrueClosedLine(store, poster(c, ids), ids, runtime, c),
        },
        {
          provide: T.APPLY_LINE_REFUND,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => new ApplyLineRefund(store, poster(c, ids)),
        },
        {
          provide: T.CREATOR_EVENT_CONSUMER,
          inject: [T.ACCRUE_CLOSED_LINE, T.APPLY_LINE_REFUND, T.ATTRIBUTE_ORDER],
          useFactory: (a: AccrueClosedLine, r: ApplyLineRefund, o: AttributeOrder) => new CreatorEventConsumer(a, r, o),
        },
        {
          provide: T.VOID_ATTRIBUTION,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => new VoidAttribution(store, poster(c, ids)),
        },
        {
          provide: T.MAINTAIN_CLICK_PARTITIONS,
          inject: [CLOCK],
          useFactory: (c: Clock) => new MaintainClickPartitions(store, c),
        },
        {
          provide: T.RELEASE_HELD,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => new ReleaseHeldCommissions(store, poster(c, ids), c, runtime),
        },
        {
          provide: T.GET_CREATOR_DASHBOARD,
          inject: [CLOCK],
          useFactory: (c: Clock) => new GetCreatorDashboard(store, identity, ledger, flags, c, runtime),
        },
        { provide: T.LIST_MY_COMMISSIONS, useFactory: () => new ListMyCommissions(store) },
        {
          provide: T.CREATOR_PAYOUT_COMMANDS,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) =>
            new CreatorPayoutCommands(store, identity, ledger, vault, approvals, provider, flags, c, ids, runtime),
        },
        { provide: T.LIST_CREATOR_PAYOUTS, useFactory: () => new ListCreatorPayouts(store) },
      ],
    };
  }
}
