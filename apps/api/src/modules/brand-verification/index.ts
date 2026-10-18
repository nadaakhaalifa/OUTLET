/** Public surface of the brand-verification module (A2.3). Other code imports only this file. */
export { BrandVerificationModule, MissingBrandVerificationPortsError, type BrandVerificationModuleOptions } from "./brand-verification.module";
export { APPLICATION_OWNERSHIP, BRAND_VERIFICATION, BRAND_VERIFICATION_STORE } from "./adapters/tokens";
export {
  FakeApplicationOwnership,
  FakeDnsResolver,
  FakeSanctionsScreening,
  FakeVerificationEmail,
  FixtureTrademarkRegistry,
  InMemoryBrandVerificationStore,
  StaticVerificationSecret,
} from "./adapters/in-memory";
export { KyselyBrandVerificationStore, type BrandVerificationDb } from "./adapters/kysely-store";
export {
  BrandProviderNotConfiguredError,
  NodeDnsResolver,
  UnconfiguredApplicationOwnership,
  UnconfiguredSanctionsScreening,
  UnconfiguredTrademarkRegistry,
  UnconfiguredVerificationEmail,
} from "./adapters/production-adapters";
export { BrandVerificationService, type BrandVerificationDeps } from "./application/service";
export type {
  ApplicationOwnershipPort,
  ApplicationSnapshot,
  BrandVerificationPort,
  BrandVerificationStore,
  ConfirmDomainResult,
  ConflictDetection,
  ConflictRecord,
  DnsResolverPort,
  DomainVerificationView,
  ManualTrademarkInput,
  RecordTrademarkResult,
  ResolveConflictResult,
  SanctionsScreeningPort,
  StartDomainResult,
  TrademarkEvidenceView,
  TrademarkOffice,
  TrademarkRegistryPort,
  VerificationEmailPort,
  VerificationSecretPort,
} from "./domain/ports";
