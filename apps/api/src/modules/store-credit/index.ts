/** Public surface of the store-credit module (A2.3). Other code imports only this file. */
export { StoreCreditModule, type StoreCreditModuleOverrides } from "./store-credit.module";
export {
  CREDIT_HOLDS,
  CREDIT_LEDGER,
  GIFT_CARD_SALES_GATE,
  GRANT_CREDIT,
  RECONCILE_WALLETS,
  RESTORE_REFUND_CREDIT,
  STORE_CREDIT_STORE,
  SWEEP_EXPIRED_CREDIT,
} from "./adapters/tokens";
export { InMemoryCreditLedger, InMemoryHoldLiveness, InMemoryStoreCredit } from "./adapters/in-memory";
export { KyselyStoreCredit, type StoreCreditDb } from "./adapters/kysely-store";
export {
  CreditHolds,
  GrantCredit,
  ReconcileWallets,
  RestoreRefundCredit,
  SweepExpiredCredit,
  DEFAULT_GIFT_CARD_MONTHS,
  HOLD_TTL_MS,
  type HoldView,
  type WalletDrift,
} from "./application/credit";
export { GetWallet, ListWalletTransactions, type WalletView } from "./application/queries";
export type {
  CreditLedgerPort,
  CreditReason,
  CreditTxn,
  HoldLivenessPort,
  HoldRecord,
  PlaceHoldResult,
  StoreCreditStore,
} from "./domain/ports";
export type { CreditLot } from "./domain/bridge";
