/** Public surface of the returns module (A2.3). Other code imports only this file. */
export { ReturnsModule, MissingReturnsPortsError, type ReturnsModuleOverrides } from "./returns.module";
export * from "./adapters/tokens";
export {
  FakeEvidence,
  FakeExchangeStock,
  FakeReturnableLines,
  InMemoryReturnEventPublisher,
  InMemoryReturnRepository,
  StaticReturnerHistory,
  StaticReturnsMembership,
} from "./adapters/in-memory";
export { ReturnsLineReturns } from "./adapters/line-returns";
export { KyselyReturnRepository, type ReturnsDb } from "./adapters/kysely-store";
export type {
  AutoApproveOverdueInspections,
  CloseElapsedDisputeWindows,
  CompleteReturnExchange,
  CompleteReturnRefund,
  PublishPendingIntents,
  RecordReturnPickedUp,
  RecordReturnPickupFailed,
  RecordReturnReceived,
  ResolveReturnDispute,
  ScheduleReturnPickup,
} from "./application/returns";
export type {
  EvidencePort,
  ExchangeStockPort,
  MembershipPort,
  RefundIntentEvent,
  ReturnEvent,
  ReturnEventPublisher,
  ReturnRecord,
  ReturnRepository,
  ReturnableLine,
  ReturnableLinePort,
  ReturnerHistory,
  ReturnerHistoryPort,
} from "./domain/ports";
export { RefundIntentEventSchema, ReturnsDependencyUnavailableError } from "./domain/ports";
