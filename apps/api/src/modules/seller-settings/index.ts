/** Public surface of the seller-settings module (A2.3). Other code imports only this file. */
export { SellerSettingsModule, MissingSellerSettingsPortsError, type SellerSettingsModuleOptions } from "./seller-settings.module";
export { SELLER_PAYOUT_ACCOUNT_PORT, SETTINGS_REPOSITORY, SETTINGS_SERVICE } from "./adapters/tokens";
export { InMemorySettingsRepository } from "./adapters/in-memory";
export { KyselySettingsRepository, type SettingsDb } from "./adapters/kysely-store";
export {
  DomainNameMatch,
  FakeEtaVerifier,
  FakeFieldCipher,
  FakeMemberships,
  FakeStoreIdentity,
  FakeStrongFactor,
  FakeUploadScan,
  FakeUploadStore,
  RecordingInviteDelivery,
  StaticLimits,
} from "./adapters/fakes";
export { SettingsPayoutAccountAdapter, SettingsReturnWindowAdapter, SettingsService } from "./application/service";
export type {
  EtaVerifierPort,
  FieldCipherPort,
  InviteDeliveryPort,
  NameMatchPort,
  PlatformLimitsPort,
  SellerMembershipsAdminPort,
  SellerPayoutAccountPort,
  SellerPayoutAccountView,
  SettingsRepository,
  StoreIdentity,
  StoreIdentityPort,
  StrongFactorPort,
  UploadScanPort,
  UploadStorePort,
} from "./domain/ports";
