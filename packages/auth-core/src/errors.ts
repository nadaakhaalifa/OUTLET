export type AuthErrorCode =
  | "INVALID_PHONE"
  | "UNSUPPORTED_COUNTRY"
  | "UNKNOWN_MARKET"
  | "INVALID_DEVICE"
  | "INSECURE_CONFIG"
  | "RATE_LIMITED"
  | "OTP_SEND_FAILED"
  | "OTP_NOT_FOUND"
  | "OTP_EXPIRED"
  | "OTP_INVALID"
  | "OTP_LOCKED"
  | "OTP_CONSUMED"
  | "DOB_REQUIRED"
  | "INVALID_DOB"
  | "UNDER_AGE"
  | "AGE_BLOCKED"
  | "USER_NOT_ACTIVE"
  | "REFRESH_INVALID"
  | "REFRESH_EXPIRED"
  | "REFRESH_REUSE"
  | "SESSION_REVOKED"
  | "ACCESS_TOKEN_INVALID";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** Set on RATE_LIMITED: seconds until the caller may retry. */
  readonly retryAfterSeconds: number | undefined;
  constructor(code: AuthErrorCode, message: string, opts: { retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}
