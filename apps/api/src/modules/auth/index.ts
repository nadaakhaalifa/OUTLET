/** Public surface of the auth module. Other code imports only this file (A2.3). */
export { AuthModule } from "./auth.module";
export {
  ADMIN_GRANT_READER,
  AGE_GATE,
  AGE_GATE_STORE,
  AUTH_EVENTS,
  DEV_OTP_MAILBOX,
  JWKS_KEY_FETCHER,
  PASSKEY_VERIFIER,
} from "./adapters/tokens";
export { DevOtpMailbox, DEV_ATTESTATION_PREFIX } from "./adapters/in-memory";
export {
  InMemoryAdminGrantReader,
  InMemoryAgeGateStore,
  InMemoryAuthEventPublisher,
  UnconfiguredAdminGrantReader,
} from "./adapters/in-memory-identity";
export type { JwksKeyFetcher } from "./adapters/jwt-identity-verifier";
export { cairoToday, type AgeGate } from "./application/age-gate";
export type { AuthProductionPorts } from "./auth.module";
export type { AdminGrantReader, FieldCipher, AgeBand } from "./domain/ports";
export { LocalKeyFieldCipher } from "./adapters/field-cipher";
export {
  JoseTokenService,
  StaticTokenKeySource,
  generateTokenKey,
  type TokenKeyMaterial,
  type TokenKeySource,
} from "./adapters/token-service";
export { CachingJwksKeyFetcher, NodeJwksHttp, isPublicAddress, type JwksHttp } from "./adapters/provider-jwks-fetcher";
export { SimpleWebAuthnVerifier } from "./adapters/webauthn-verifier";
export { UnconfiguredOtpSender } from "./adapters/otp-senders";
export { DevAttestationVerifier, DevOtpSender } from "./adapters/in-memory";
export {
  SELLER_MEMBERSHIPS,
  SELLER_SESSIONS,
  SELLER_STORES,
} from "./seller/adapters/tokens";
export { SellerMembershipService, SELLER_SESSION_SCOPE, SELLER_ENROL_RESTRICTED_SCOPE, isBrandRole } from "./seller/application/team";
export { SellerSessions } from "./seller/application/sessions";
export type {
  SellerMembership,
  SellerMembershipsPort,
  SellerUser,
  SellerAuthEvent,
  SellerStores,
} from "./seller/domain/ports";
