import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { InMemoryCreditLedger, InMemoryHoldLiveness, InMemoryStoreCredit } from "./adapters/in-memory";
import {
  CREDIT_HOLDS,
  CREDIT_LEDGER,
  GET_WALLET,
  GIFT_CARD_SALES_GATE,
  GRANT_CREDIT,
  LIST_WALLET_TRANSACTIONS,
  RECONCILE_WALLETS,
  RESTORE_REFUND_CREDIT,
  STORE_CREDIT_STORE,
  SWEEP_EXPIRED_CREDIT,
} from "./adapters/tokens";
import { WalletController } from "./adapters/wallet.controller";
import { CreditHolds, GrantCredit, ReconcileWallets, RestoreRefundCredit, SweepExpiredCredit } from "./application/credit";
import { GetWallet, ListWalletTransactions } from "./application/queries";
import { giftCardSalesGate } from "./domain/bridge";
import type { CreditLedgerPort, HoldLivenessPort, StoreCreditStore } from "./domain/ports";

export interface StoreCreditModuleOverrides {
  readonly store?: StoreCreditStore;
  readonly ledger?: CreditLedgerPort;
  /**
   * R-6: sweeper guard, satisfied by the checkout module (`SagaHoldLiveness`). Without it the
   * guard fails closed outside in-memory-dev: the sweeper then releases nothing a saga might own.
   */
  readonly holdLiveness?: HoldLivenessPort;
  /** Gift-card sales kill switch (spec A2.12). Default OFF; only the admin flag service turns it on. */
  readonly giftCardSalesEnabled?: boolean;
}

export class MissingHoldLivenessError extends Error {
  constructor() {
    super("StoreCreditModule requires a real holdLiveness port (checkout SagaHoldLiveness) outside in-memory-dev");
    this.name = "MissingHoldLivenessError";
  }
}

@Module({})
export class StoreCreditModule {
  static forRoot(config: AppConfig, overrides: StoreCreditModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (overrides.store === undefined || overrides.ledger === undefined)) {
      throw new NoProductionAdaptersError();
    }
    // R-6: no silent "everything is live" default (it would stop the sweeper releasing any expired hold).
    if (production && overrides.holdLiveness === undefined) throw new MissingHoldLivenessError();
    const liveness: HoldLivenessPort = overrides.holdLiveness ?? new InMemoryHoldLiveness();
    const store = (): StoreCreditStore => overrides.store ?? new InMemoryStoreCredit();
    return {
      module: StoreCreditModule,
      controllers: [WalletController],
      providers: [
        { provide: STORE_CREDIT_STORE, useFactory: store },
        { provide: CREDIT_LEDGER, useValue: overrides.ledger ?? new InMemoryCreditLedger() },
        { provide: GIFT_CARD_SALES_GATE, useValue: giftCardSalesGate(overrides.giftCardSalesEnabled) },
        {
          provide: GET_WALLET,
          inject: [STORE_CREDIT_STORE, CLOCK],
          useFactory: (s: StoreCreditStore, c: Clock) => new GetWallet(s, c),
        },
        {
          provide: LIST_WALLET_TRANSACTIONS,
          inject: [STORE_CREDIT_STORE],
          useFactory: (s: StoreCreditStore) => new ListWalletTransactions(s),
        },
        {
          provide: CREDIT_HOLDS,
          inject: [STORE_CREDIT_STORE, ID_GENERATOR, CLOCK],
          useFactory: (s: StoreCreditStore, i: IdGenerator, c: Clock) =>
            new CreditHolds(s, i, c, undefined, (ref) => liveness.isLive(ref)),
        },
        {
          provide: GRANT_CREDIT,
          inject: [STORE_CREDIT_STORE, CREDIT_LEDGER, ID_GENERATOR, CLOCK],
          useFactory: (s: StoreCreditStore, l: CreditLedgerPort, i: IdGenerator, c: Clock) => new GrantCredit(s, l, i, c),
        },
        {
          provide: RESTORE_REFUND_CREDIT,
          inject: [STORE_CREDIT_STORE, ID_GENERATOR, CLOCK],
          useFactory: (s: StoreCreditStore, i: IdGenerator, c: Clock) => new RestoreRefundCredit(s, i, c),
        },
        {
          provide: SWEEP_EXPIRED_CREDIT,
          inject: [STORE_CREDIT_STORE, CREDIT_LEDGER, ID_GENERATOR, CLOCK],
          useFactory: (s: StoreCreditStore, l: CreditLedgerPort, i: IdGenerator, c: Clock) =>
            new SweepExpiredCredit(s, l, i, c),
        },
        {
          provide: RECONCILE_WALLETS,
          inject: [STORE_CREDIT_STORE, CREDIT_LEDGER],
          useFactory: (s: StoreCreditStore, l: CreditLedgerPort) => new ReconcileWallets(s, l),
        },
      ],
      exports: [
        STORE_CREDIT_STORE,
        CREDIT_HOLDS,
        GRANT_CREDIT,
        RESTORE_REFUND_CREDIT,
        SWEEP_EXPIRED_CREDIT,
        RECONCILE_WALLETS,
        GIFT_CARD_SALES_GATE,
      ],
    };
  }
}
