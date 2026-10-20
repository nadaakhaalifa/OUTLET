import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { DEFAULT_PAYOUT_CONFIG, PayoutCommands } from "./application/commands";
import { GetPayout, GetStoreBalance, ListPayouts, PayoutSummaryQuery, SellerStatements } from "./application/queries";
import { FinanceAccess, PayoutStoreAccess } from "./adapters/access";
import {
  FakeApprovals,
  FakeFlags,
  FakeIbanNameMatch,
  FakePayoutLedger,
  FakePayoutPort,
  FakePayoutRisk,
  FakePayoutSource,
  FakeSellerBank,
} from "./adapters/fakes";
import { InMemoryPayoutStore } from "./adapters/in-memory";
import { FinancePayoutsController, SellerPayoutsController, type PayoutBalanceOptions } from "./adapters/payouts.controller";
import { AdminPayoutResolver, StoreParamResolver, StorePayoutResolver } from "./adapters/resolvers";
import {
  ADMIN_PAYOUT_RESOLVER,
  FINANCE_VIEWS_ENABLED,
  GET_PAYOUT,
  GET_STORE_BALANCE,
  LIST_PAYOUTS,
  PAYOUTS_NOW,
  PAYOUT_BALANCE_OPTIONS,
  PAYOUT_APPROVALS,
  PAYOUT_BANK,
  PAYOUT_COMMANDS,
  PAYOUT_CONFIG,
  PAYOUT_FLAGS,
  PAYOUT_LEDGER,
  PAYOUT_NAME_MATCH,
  PAYOUT_PROVIDER,
  PAYOUT_RISK,
  PAYOUT_SOURCE,
  PAYOUT_STORE,
  PAYOUT_SUMMARY,
  SELLER_STATEMENTS,
  STATEMENT_SOURCE,
  STORE_PARAM_RESOLVER,
  STORE_PAYOUT_RESOLVER,
} from "./adapters/tokens";
import type {
  IbanNameMatchPort,
  PayoutApprovalsPort,
  PayoutConfig,
  PayoutFlagsPort,
  PayoutLedgerPort,
  PayoutPort,
  PayoutRiskPort,
  PayoutSourcePort,
  PayoutStore,
  SellerBankPort,
  StatementSourcePort,
} from "./domain/ports";

export interface PayoutsModuleOverrides {
  readonly store?: PayoutStore;
  readonly source?: PayoutSourcePort;
  readonly statementSource?: StatementSourcePort;
  readonly bank?: SellerBankPort;
  readonly nameMatch?: IbanNameMatchPort;
  readonly risk?: PayoutRiskPort;
  readonly approvals?: PayoutApprovalsPort;
  readonly ledger?: PayoutLedgerPort;
  readonly provider?: PayoutPort;
  readonly flags?: PayoutFlagsPort;
  readonly config?: PayoutConfig;
  /** release.admin.finance_views. Absent means BLOCKED: GET /v1/admin/finance/payouts/summary answers 404. */
  readonly financeViewsEnabled?: () => Promise<boolean> | boolean;
  /** Release flag of the seller balance route. Absent means blocked (404). */
  readonly balance?: PayoutBalanceOptions;
}

/** Thrown at boot when a non-test environment has no real adapter for a money-moving port. */
export class MissingPayoutsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `PayoutsModule requires real ${missing.join(", ")} outside test mode: ` +
        "supply them through PayoutsModule.forRoot(config, overrides)",
    );
    this.name = "MissingPayoutsPortsError";
  }
}

@Module({})
export class PayoutsModule {
  static forRoot(config: AppConfig, overrides: PayoutsModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && overrides.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing = (
        [
          ["source (PAYOUT_SOURCE: orders, refunds, disputes)", overrides.source],
          ["bank (PAYOUT_BANK: seller KYC bank details)", overrides.bank],
          ["nameMatch (PAYOUT_NAME_MATCH: bank holder-name inquiry)", overrides.nameMatch],
          ["ledger (PAYOUT_LEDGER: posting service)", overrides.ledger],
          ["provider (PAYOUT_PROVIDER: PSP or bank payout rail)", overrides.provider],
          ["approvals (PAYOUT_APPROVALS: admin approval records)", overrides.approvals],
          ["flags (PAYOUT_FLAGS: payouts_enabled kill switch)", overrides.flags],
        ] as const
      )
        .filter(([, v]) => v === undefined)
        .map(([n]) => n);
      if (missing.length > 0) throw new MissingPayoutsPortsError(missing);
    }
    // Test mode only: in-memory fakes. A fake must never be reachable in production (checked above).
    const bank = overrides.bank ?? new FakeSellerBank();
    const fakeSource = new FakePayoutSource();
    return {
      module: PayoutsModule,
      controllers: [SellerPayoutsController, FinancePayoutsController],
      providers: [
        PayoutStoreAccess,
        FinanceAccess,
        {
          provide: PAYOUT_STORE,
          inject: [CLOCK],
          useFactory: (clock: Clock): PayoutStore => overrides.store ?? new InMemoryPayoutStore(clock),
        },
        { provide: PAYOUT_CONFIG, useValue: overrides.config ?? DEFAULT_PAYOUT_CONFIG },
        { provide: PAYOUT_SOURCE, useValue: overrides.source ?? fakeSource },
        { provide: STATEMENT_SOURCE, useValue: overrides.statementSource ?? fakeSource },
        { provide: PAYOUT_BANK, useValue: bank },
        {
          provide: PAYOUT_NAME_MATCH,
          useValue: overrides.nameMatch ?? new FakeIbanNameMatch(bank instanceof FakeSellerBank ? bank : new FakeSellerBank()),
        },
        { provide: PAYOUT_RISK, useValue: overrides.risk ?? new FakePayoutRisk() },
        { provide: PAYOUT_APPROVALS, useValue: overrides.approvals ?? new FakeApprovals() },
        { provide: PAYOUT_LEDGER, useValue: overrides.ledger ?? new FakePayoutLedger() },
        { provide: PAYOUT_PROVIDER, useValue: overrides.provider ?? new FakePayoutPort() },
        { provide: PAYOUT_FLAGS, useValue: overrides.flags ?? new FakeFlags() },
        { provide: PAYOUTS_NOW, inject: [CLOCK], useFactory: (c: Clock) => () => c.nowMs() },
        {
          provide: PAYOUT_COMMANDS,
          inject: [
            PAYOUT_STORE,
            PAYOUT_SOURCE,
            PAYOUT_BANK,
            PAYOUT_NAME_MATCH,
            PAYOUT_RISK,
            PAYOUT_APPROVALS,
            PAYOUT_LEDGER,
            PAYOUT_PROVIDER,
            PAYOUT_FLAGS,
            CLOCK,
            ID_GENERATOR,
            PAYOUT_CONFIG,
          ],
          useFactory: (
            store: PayoutStore,
            source: PayoutSourcePort,
            bankPort: SellerBankPort,
            nameMatch: IbanNameMatchPort,
            risk: PayoutRiskPort,
            approvals: PayoutApprovalsPort,
            ledger: PayoutLedgerPort,
            provider: PayoutPort,
            flags: PayoutFlagsPort,
            clock: Clock,
            ids: IdGenerator,
            cfg: PayoutConfig,
          ) =>
            new PayoutCommands({
              store,
              source,
              bank: bankPort,
              nameMatch,
              risk,
              approvals,
              ledger,
              provider,
              flags,
              clock,
              ids,
              config: cfg,
            }),
        },
        { provide: FINANCE_VIEWS_ENABLED, useValue: overrides.financeViewsEnabled ?? (() => false) },
        {
          provide: PAYOUT_SUMMARY,
          inject: [PAYOUT_STORE, PAYOUT_CONFIG],
          useFactory: (s: PayoutStore, c: PayoutConfig) => new PayoutSummaryQuery(s, c.cycle),
        },
        { provide: PAYOUT_BALANCE_OPTIONS, useValue: overrides.balance ?? { enabled: () => false } },
        {
          provide: GET_STORE_BALANCE,
          inject: [PAYOUT_STORE, PAYOUT_SOURCE, PAYOUT_LEDGER, PAYOUTS_NOW],
          useFactory: (s: PayoutStore, src: PayoutSourcePort, l: PayoutLedgerPort, now: () => number) => new GetStoreBalance(s, src, l, now),
        },
        { provide: GET_PAYOUT, inject: [PAYOUT_STORE], useFactory: (s: PayoutStore) => new GetPayout(s) },
        { provide: LIST_PAYOUTS, inject: [PAYOUT_STORE], useFactory: (s: PayoutStore) => new ListPayouts(s) },
        {
          provide: SELLER_STATEMENTS,
          inject: [PAYOUT_STORE, STATEMENT_SOURCE],
          useFactory: (s: PayoutStore, src: StatementSourcePort) => new SellerStatements(s, src),
        },
        { provide: STORE_PAYOUT_RESOLVER, inject: [PAYOUT_STORE], useFactory: (s: PayoutStore) => new StorePayoutResolver(s) },
        { provide: STORE_PARAM_RESOLVER, useValue: new StoreParamResolver() },
        { provide: ADMIN_PAYOUT_RESOLVER, inject: [PAYOUT_STORE], useFactory: (s: PayoutStore) => new AdminPayoutResolver(s) },
      ],
      exports: [PAYOUT_STORE, PAYOUT_COMMANDS, SELLER_STATEMENTS],
    };
  }
}
