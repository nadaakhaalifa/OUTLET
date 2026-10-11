import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { FakeCreditRestore, FakePayoutDetails, FakeRefundExecutor, FakeRefundFacts, InMemoryRefundLedger, SeqJitter } from "./adapters/fakes";
import { InMemoryRefundStore } from "./adapters/in-memory";
import { RefundsController } from "./adapters/refunds.controller";
import {
  CONFIRM_PROVIDER_OUTCOME,
  GET_MY_REFUND,
  INTAKE_REFUND_INTENT,
  LIST_MY_REFUNDS,
  PROCESS_REFUND,
  REFUND_CREDIT_RESTORE,
  REFUND_EXECUTOR,
  REFUND_FACTS,
  REFUND_JITTER,
  REFUND_LEDGER,
  REFUND_PAYOUT_DETAILS,
  REFUND_STORE,
  RESOLVE_MANUAL_REVIEW,
  SWEEP_REFUNDS,
} from "./adapters/tokens";
import { IntakeRefundIntent } from "./application/intake";
import { GetMyRefund, ListMyRefunds } from "./application/queries";
import { ProcessRefund, SweepRefunds } from "./application/process";
import { ConfirmProviderOutcome, ResolveManualReview } from "./application/provider";
import type {
  CreditRestorePort,
  JitterPort,
  PayoutDetailsPort,
  RefundExecutionPort,
  RefundFactsPort,
  RefundLedgerPort,
  RefundStore,
} from "./domain/ports";
import { DEFAULT_REFUND_ROUTER_CONFIG, type RefundRouterConfig } from "./domain/bridge";

export interface RefundsModuleOverrides {
  readonly store?: RefundStore;
  readonly facts?: RefundFactsPort;
  readonly ledger?: RefundLedgerPort;
  readonly creditRestore?: CreditRestorePort;
  /** PaymentProviderPort refund side. Only fakes and recorded fixtures exist (Paymob is not contracted). */
  readonly executor?: RefundExecutionPort;
  readonly payoutDetails?: PayoutDetailsPort;
  readonly jitter?: JitterPort;
  readonly routerConfig?: RefundRouterConfig;
}

@Module({})
export class RefundsModule {
  static forRoot(config: AppConfig, overrides: RefundsModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (
      production &&
      (overrides.store === undefined ||
        overrides.facts === undefined ||
        overrides.ledger === undefined ||
        overrides.creditRestore === undefined ||
        overrides.executor === undefined ||
        overrides.payoutDetails === undefined)
    ) {
      throw new NoProductionAdaptersError();
    }
    return {
      module: RefundsModule,
      controllers: [RefundsController],
      providers: [
        { provide: REFUND_STORE, useValue: overrides.store ?? new InMemoryRefundStore() },
        { provide: REFUND_FACTS, useValue: overrides.facts ?? new FakeRefundFacts() },
        { provide: REFUND_LEDGER, useValue: overrides.ledger ?? new InMemoryRefundLedger() },
        { provide: REFUND_CREDIT_RESTORE, useValue: overrides.creditRestore ?? new FakeCreditRestore() },
        { provide: REFUND_EXECUTOR, useValue: overrides.executor ?? new FakeRefundExecutor() },
        { provide: REFUND_PAYOUT_DETAILS, useValue: overrides.payoutDetails ?? new FakePayoutDetails() },
        { provide: REFUND_JITTER, useValue: overrides.jitter ?? new SeqJitter() },
        {
          provide: INTAKE_REFUND_INTENT,
          inject: [REFUND_STORE, REFUND_FACTS, ID_GENERATOR, CLOCK],
          useFactory: (s: RefundStore, f: RefundFactsPort, i: IdGenerator, c: Clock) =>
            new IntakeRefundIntent(s, f, i, c, overrides.routerConfig ?? DEFAULT_REFUND_ROUTER_CONFIG),
        },
        {
          provide: PROCESS_REFUND,
          inject: [REFUND_STORE, REFUND_LEDGER, REFUND_CREDIT_RESTORE, REFUND_EXECUTOR, REFUND_PAYOUT_DETAILS, CLOCK, REFUND_JITTER],
          useFactory: (
            s: RefundStore,
            l: RefundLedgerPort,
            cr: CreditRestorePort,
            e: RefundExecutionPort,
            p: PayoutDetailsPort,
            c: Clock,
            j: JitterPort,
          ) => new ProcessRefund(s, l, cr, e, p, c, j),
        },
        {
          provide: SWEEP_REFUNDS,
          inject: [REFUND_STORE, PROCESS_REFUND, CLOCK],
          useFactory: (s: RefundStore, p: ProcessRefund, c: Clock) => new SweepRefunds(s, p, c),
        },
        {
          provide: CONFIRM_PROVIDER_OUTCOME,
          inject: [REFUND_STORE, CLOCK, REFUND_JITTER],
          useFactory: (s: RefundStore, c: Clock, j: JitterPort) => new ConfirmProviderOutcome(s, c, j),
        },
        {
          provide: RESOLVE_MANUAL_REVIEW,
          inject: [REFUND_STORE, CLOCK],
          useFactory: (s: RefundStore, c: Clock) => new ResolveManualReview(s, c),
        },
        { provide: GET_MY_REFUND, inject: [REFUND_STORE, CLOCK], useFactory: (s: RefundStore, c: Clock) => new GetMyRefund(s, c) },
        { provide: LIST_MY_REFUNDS, inject: [REFUND_STORE, CLOCK], useFactory: (s: RefundStore, c: Clock) => new ListMyRefunds(s, c) },
      ],
      exports: [
        REFUND_STORE,
        INTAKE_REFUND_INTENT,
        PROCESS_REFUND,
        SWEEP_REFUNDS,
        CONFIRM_PROVIDER_OUTCOME,
        RESOLVE_MANUAL_REVIEW,
      ],
    };
  }
}
