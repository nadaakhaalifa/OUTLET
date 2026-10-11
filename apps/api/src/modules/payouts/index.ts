/** Public surface of the payouts module (A2.3). Other code imports only this file. */
export { PayoutsModule, MissingPayoutsPortsError, type PayoutsModuleOverrides } from "./payouts.module";
export { PAYOUT_COMMANDS, PAYOUT_STORE, SELLER_STATEMENTS } from "./adapters/tokens";
export { InMemoryPayoutStore } from "./adapters/in-memory";
export { KyselyPayoutStore, type PayoutsDb } from "./adapters/kysely-store";
export {
  FakeApprovals,
  FakeFlags,
  FakeIbanNameMatch,
  FakePayoutLedger,
  FakePayoutPort,
  FakePayoutRisk,
  FakePayoutSource,
  FakeSellerBank,
} from "./adapters/fakes";
export { DEFAULT_PAYOUT_CONFIG, PayoutCommands, type CommandResult, type ScheduleSummary, type SendResult } from "./application/commands";
export { GetPayout, ListPayouts, SellerStatements, type StatementView } from "./application/queries";
export type {
  BankDetails,
  IbanNameMatchPort,
  PayoutApprovalsPort,
  PayoutConfig,
  PayoutFlagsPort,
  PayoutLedgerPort,
  PayoutPort,
  PayoutRecord,
  PayoutRiskPort,
  PayoutScope,
  PayoutSourcePort,
  PayoutStore,
  SellerBankPort,
  StatementSourcePort,
} from "./domain/ports";
