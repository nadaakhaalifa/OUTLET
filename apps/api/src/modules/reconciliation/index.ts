/** Public surface of the reconciliation module (A2.3). Other code imports only this file. */
export {
  ReconciliationModule,
  MissingReconciliationPortsError,
  type ReconciliationModuleOverrides,
} from "./reconciliation.module";
export {
  FINANCE_RECON_READ,
  INGEST_SETTLEMENT_FILE,
  RECON_STORE,
  RUN_RECONCILIATION,
  SCHEDULE_RECONCILIATION,
} from "./adapters/tokens";
export { InMemoryReconStore } from "./adapters/in-memory";
export { KyselyReconStore, type ReconDb } from "./adapters/kysely-store";
export {
  FakeEtaSource,
  FakeIntegrity,
  FakeLedgerClearing,
  FakeReconAlerts,
  FakeReconFlags,
  FixtureSettlementFilePort,
} from "./adapters/fakes";
export { IngestSettlementFile, MAX_FILE_BYTES, type IngestResult } from "./application/ingest";
export { RunReconciliation, ScheduleReconciliation, type ReconDeps, type RunMode, type RunResult } from "./application/run";
export { FinanceReconReadModel } from "./application/queries";
export type {
  EtaSourcePort,
  FileFormat,
  FileKind,
  IntegrityPort,
  LedgerClearingPort,
  ReconAlert,
  ReconAlertPort,
  ReconFlagsPort,
  ReconStore,
  ReconSummary,
  RunRecord,
  SettlementFilePort,
  SettlementFileRecord,
  TicketRecord,
} from "./domain/ports";
