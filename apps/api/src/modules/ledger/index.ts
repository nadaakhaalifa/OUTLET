/** Public surface of the ledger module (A2.3). Other code imports only this file. */
export { LedgerModule, type LedgerModuleOverrides } from "./ledger.module";
export { GET_ENTRY, INTEGRITY_JOB, INTEGRITY_RECORDER, INTEGRITY_RUN_READER, INTEGRITY_RUN_STORE, LEDGER_FLAGS, LEDGER_PROJECTION, LEDGER_READ_MODEL, LEDGER_SNAPSHOTS, LEDGER_STORE, LIST_BALANCES, POSTING_SERVICE } from "./adapters/tokens";
export { InMemoryLedger, InMemoryLedgerTx, InMemoryProjection } from "./adapters/in-memory";
export {
  KyselyIntegritySnapshots,
  KyselyLedgerReadModel,
  KyselyLedgerStore,
  ledgerTxOf,
  type LedgerDb,
  type LedgerDbTx,
} from "./adapters/kysely-store";
export { PostingService, LedgerEntryNotFoundError, type PostingServiceDeps } from "./application/posting-service";
export { IntegrityJob, type IntegrityJobReport, type IntegrityJobDeps } from "./application/integrity-job";
export type {
  BalanceQuery,
  BalanceRow,
  IntegritySnapshots,
  IntegritySource,
  LedgerEvent,
  LedgerReadModel,
  LedgerStore,
  LedgerTxn,
  PostOutcome,
  PostingFlags,
  ProjectionSource,
  ReadScope,
  StoredEntry,
} from "./domain/ports";
export { PostingConflictError, GiftCardSalesDisabledError } from "./domain/bridge";
export { InMemoryIntegrityRuns } from "./adapters/in-memory-integrity";
export { KyselyIntegrityRunReader, KyselyIntegrityRunStore } from "./adapters/kysely-integrity";
export { RecordIntegrityRun, mapReport, type RecordedRun, type RecorderDeps } from "./application/integrity-recorder";
export {
  computeIntegrityState,
  gaugeValues,
  type IntegrityMode,
  type IntegrityState,
  type StoredRun,
} from "./domain/integrity-runs";
export { IntegrityAuditWriteError, type IntegrityRunReader, type IntegrityRunStore } from "./domain/ports";
