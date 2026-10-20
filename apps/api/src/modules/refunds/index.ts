/** Public surface of the refunds module (A2.3). Other code imports only this file. */
export { RefundsModule, type RefundsModuleOverrides } from "./refunds.module";
export {
  CONFIRM_PROVIDER_OUTCOME,
  INTAKE_REFUND_INTENT,
  PROCESS_REFUND,
  REFUND_FACTS,
  REFUND_STORE,
  RESOLVE_MANUAL_REVIEW,
  SWEEP_REFUNDS,
} from "./adapters/tokens";
export {
  FakeCreditRestore,
  FakePayoutDetails,
  FakeRefundExecutor,
  FakeRefundFacts,
  InMemoryRefundLedger,
  RecordedFixtureRefundExecutor,
  SeqJitter,
} from "./adapters/fakes";
export { InMemoryRefundStore } from "./adapters/in-memory";
export { KyselyRefundStore, type RefundsDb } from "./adapters/kysely-store";
export { IntakeRefundIntent, RETURN_INTENT_CONSUMER, type IntakeResult } from "./application/intake";
export { RefundFactsUnavailableError, RefundIntakeConflictError, RefundRecognitionMissingError } from "./application/errors";
export { ProcessRefund, SweepRefunds } from "./application/process";
export { ConfirmProviderOutcome, ResolveManualReview } from "./application/provider";
export { GetMyRefund, ListMyRefunds, type RefundView } from "./application/queries";
export {
  RefundIntentMessageSchema,
  type CreditRestorePort,
  type PayoutDetailsPort,
  type RefundExecutionPort,
  type RefundFacts,
  type RefundFactsPort,
  type RefundLedgerPort,
  type RefundRecord,
  type RefundStore,
} from "./domain/ports";
