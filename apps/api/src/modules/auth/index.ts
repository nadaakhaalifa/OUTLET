/** Public surface of the auth module. Other code imports only this file (A2.3). */
export { AuthModule } from "./auth.module";
export {
  AGE_GATE,
  AGE_GATE_STORE,
  AUTH_EVENTS,
  DEV_OTP_MAILBOX,
  JWKS_KEY_FETCHER,
  PASSKEY_VERIFIER,
} from "./adapters/tokens";
export { DevOtpMailbox, DEV_ATTESTATION_PREFIX } from "./adapters/in-memory";
export { InMemoryAgeGateStore, InMemoryAuthEventPublisher } from "./adapters/in-memory-identity";
export type { JwksKeyFetcher } from "./adapters/jwt-identity-verifier";
export { cairoToday, type AgeGate } from "./application/age-gate";
