/** Public surface of the privacy module (A2.3). */
export { PrivacyModule, type PrivacyModuleOptions } from "./privacy.module";
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
  PrivacyRequestRepository,
} from "./domain/ports";
export { KyselyBreachRepository, KyselyConsentRepository, KyselyPrivacyRequestRepository, type PrivacyDb } from "./adapters/kysely-store";
export { EXPORTER_MANIFEST, EXPORT_EXEMPTIONS } from "./application/exporter-manifest";
export { resolveInventory } from "./application/inventory";
