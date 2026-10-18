/** Public surface of the sellers module (A2.3). Other code imports only this file. */
export { SellersModule, type SellersModuleOptions } from "./sellers.module";
export { SELLERS_ADMIN_PORT, SELLERS_SERVICE, SELLERS_REPOSITORY } from "./adapters/tokens";
export {
  FakeBrandDocumentStore,
  FakeVerificationLink,
  FakeScanPort,
  InMemoryBrandApplicationRepository,
  NullFunnel,
  RecordingFunnel,
} from "./adapters/in-memory";
export { LazyBrandVerificationLink, SellersApplicationOwnership } from "./adapters/verification-link";
export { KyselyBrandApplicationRepository, type SellersDb } from "./adapters/kysely-store";
export { BrandApplicationService } from "./application/service";
export { BrandApplicationsAdmin } from "./application/admin-port";
export type {
  AdminApplicationDetail,
  AdminApplicationSummary,
  AdminDecisionInput,
  AdminDocumentView,
  AdminResult,
  AggregateRow,
  ApplicationRow,
  BrandApplicationRepository,
  BrandApplicationsAdminPort,
  BrandDocumentStore,
  DocumentRow,
  VerificationLink,
  AutoCheckSnapshot,
  FieldCipherPort,
  FunnelAnalyticsPort,
  PublicDecision,
  RequestedItem,
  ReviewQueueQuery,
  ScanPort,
} from "./domain/ports";
