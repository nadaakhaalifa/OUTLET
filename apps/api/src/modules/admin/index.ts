/** Public surface of the admin module. Other code imports only this file (A2.3). */
export { AdminModule, type AdminModuleOptions } from "./admin.module";
export {
  ADMIN_AUDIT,
  ADMIN_STORE,
  DUAL_APPROVALS,
  FEATURE_FLAG_ADMIN,
  FLAG_ADMIN_BACKEND,
  PII_SOURCE,
  ROLE_ELEVATIONS,
  SELLER_KYC_ADMIN,
  SELLER_KYC_PORT,
  VIEW_PII,
} from "./adapters/tokens";
export {
  InMemoryAdminAudit,
  InMemoryAdminStore,
  InMemoryFlagBackend,
  InMemoryPiiSource,
  InMemorySellerKyc,
  SPEC_KILL_SWITCH_KEYS,
} from "./adapters/in-memory";
export { KyselyAdminAudit, KyselyAdminStore, KyselySellerKyc, type AdminDb } from "./adapters/kysely-store";
export type { DualApprovals, SellerKycAdmin } from "./application/admin";
export type {
  AdminAuditPort,
  AdminStore,
  FlagAdminBackend,
  PiiSourcePort,
  SellerKycPort,
} from "./domain/ports";
