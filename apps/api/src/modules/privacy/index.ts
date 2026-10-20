/** Public surface of the privacy module (A2.3). */
export { canReadPrivacyConsole } from "./adapters/access";
export { PrivacyModule, MissingPrivacyPortsError, type PrivacyModuleOptions } from "./privacy.module";
export {
  BREACH_REGISTER,
  CANCEL_DELETION,
  EXPIRE_EXPORTS,
  GET_DELETION,
  GET_EXPORT,
  LIST_DSAR_QUEUE,
  PRIVACY_OUTBOX,
  PROCESS_DELETIONS,
  PROCESS_EXPORT,
  REQUEST_DELETION,
  REQUEST_EXPORT,
} from "./adapters/tokens";
export type {
  BlockersPort,
  BreachRepository,
  ConsentRepository,
  ErasureExecutorPort,
  ExporterPort,
  ObjectStorePort,
  OutboxDraft,
  PreErasureStepPort,
  PrivacyRequestRepository,
} from "./domain/ports";
export { KyselyBreachRepository, KyselyConsentRepository, KyselyPrivacyRequestRepository, type PrivacyDb } from "./adapters/kysely-store";
export { EXPORTER_MANIFEST, EXPORT_EXEMPTIONS } from "./application/exporter-manifest";
export { resolveInventory } from "./application/inventory";
export { KyselyDeletionBlockers } from "./adapters/kysely-blockers";
export { KyselyErasureExecutor, type ErasureReport, type KyselyErasureOptions } from "./adapters/kysely-erasure";
export { KyselyGroupExporter, createKyselyExporters } from "./adapters/kysely-exporters";
export { INVENTORY_SNAPSHOT } from "./application/inventory.snapshot";
export type { FieldDecryptPort } from "./domain/ports";
