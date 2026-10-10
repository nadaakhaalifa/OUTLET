/** Public surface of the auth module. Other code imports only this file (A2.3). */
export { AuthModule } from "./auth.module";
export { DEV_OTP_MAILBOX } from "./adapters/tokens";
export { DevOtpMailbox, DEV_ATTESTATION_PREFIX } from "./adapters/in-memory";
