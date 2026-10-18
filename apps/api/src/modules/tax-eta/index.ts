/** Public surface of the tax-eta module (A2.3). Other code imports only this file. */
export { TaxEtaModule, MissingTaxEtaPortsError, type TaxEtaModuleOverrides } from "./tax-eta.module";
export * from "./adapters/tokens";
export { canReadTax, canWriteTax, holdsAdminRole, TAX_READER_ROLES, TAX_WRITER_ROLES } from "./adapters/access";
export {
  FakeEtaPort,
  InMemorySignedDocumentStore,
  InMemorySigningDelegations,
  InMemoryTaxConfigRepository,
  InMemoryTaxDocumentRepository,
  InMemoryTaxEtaEventPublisher,
} from "./adapters/in-memory";
export {
  KyselySignedDocumentStore,
  KyselySigningDelegations,
  KyselyTaxConfigRepository,
  KyselyTaxDocumentRepository,
  type TaxEtaDb,
} from "./adapters/kysely-store";
export type {
  ChangeExemption,
  IssueDocument,
  IssueInput,
  IssueResult,
  PollSubmissionStatuses,
  ProcessSubmissionQueue,
  QueueRunSummary,
  QuoteOrderTax,
  RunDailyReconciliation,
} from "./application/tax";
export type {
  EtaPort,
  EtaStatusResult,
  EtaSubmitResult,
  SignedDocumentStore,
  SigningDelegationPort,
  StoredDocument,
  SubmissionRecord,
  TaxConfigRepository,
  TaxDocumentRepository,
  TaxEtaEvent,
  TaxEtaEventPublisher,
} from "./domain/ports";
