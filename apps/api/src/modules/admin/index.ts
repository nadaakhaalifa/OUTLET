/** Public surface of the admin module. Other code imports only this file (A2.3). */
export { AdminIdentityConfigError, AdminModule, type AdminIdentityModuleOptions, type AdminModuleOptions } from "./admin.module";
export type { AdminIdentityOptions, SessionBindingPort } from "./adapters/admin-me.controller";
export {
  InMemoryEdgeReplayStore,
  signEdgePosture,
  UnconfiguredEdgeReplayStore,
  verifyEdgePosture,
  type EdgePostureKeys,
  type EdgeReplayStore,
} from "./adapters/edge-posture";
export { buildAdminMe, computeCapabilities, adminRuleGate, type AdminMeView } from "./application/me";
export { CAPABILITY_KEYS, assuranceFromAmr, type Capabilities, type CapabilityKey } from "./domain/me";
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
// Pure route-gate predicates and the route role table: the capability map calls these, never copies them.
export {
  adminGateDenial,
  canPassAdminGate,
  computeAccess,
  hasAnyRole,
  ROUTE_ROLES,
  type AdminAccess,
  type GateDenial,
} from "./domain/access";
export type { DualApprovals, SellerKycAdmin } from "./application/admin";
export type {
  AdminAuditPort,
  AdminStore,
  FlagAdminBackend,
  PiiSourcePort,
  SellerKycPort,
} from "./domain/ports";

// Brand application review (docs/specs/brand-review-and-provisioning.md).
export * from "./brand-review";
