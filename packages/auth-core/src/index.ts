export { assessAge } from "./age.js";
export type { AgeAssessment, AgeBand } from "./age.js";
export { createAuthDeps, DEFAULT_MARKET_POLICIES } from "./config.js";
export type { AuthDeps, MarketAuthPolicy } from "./config.js";
export { AesGcmFieldCipher, Hasher, safeEqual, sha256 } from "./crypto.js";
export { registerDevice } from "./devices.js";
export { AuthError } from "./errors.js";
export type { AuthErrorCode } from "./errors.js";
export {
  AGE_BLOCK_MS, OTP_DEVICE_LIMIT, OTP_DEVICE_WINDOW_MS, OTP_MAX_ATTEMPTS, OTP_PHONE_LIMIT, OTP_PHONE_WINDOW_MS, OTP_TTL_MS, OtpService,
} from "./otp.js";
export type { OtpRequestInput, OtpVerifyInput, VerifiedUser } from "./otp.js";
export { PURGE_OTP_GRACE_MS, PURGE_RATE_LIMIT_MS, PURGE_REFRESH_GRACE_MS, purgeExpired } from "./purge.js";
export type { PurgeCounts } from "./purge.js";
export { oidcLoginDtoSchema, passkeyAssertionDtoSchema } from "./ports.js";
export type { FieldCipher, OidcLoginDto, OidcVerifier, PasskeyAssertionDto, PasskeyVerifier, RateLimiter, SmsSender } from "./ports.js";
export { InMemoryRateLimiter, PgRateLimiter } from "./rate-limiter.js";
export { ACCESS_TTL_S, DEFAULT_ABSOLUTE_MAX_DAYS, REFRESH_TTL_MS, SessionService } from "./session.js";
export type { AccessClaims, Amr, IssuedSession, SessionConfig, SessionSummary } from "./session.js";
