import type { ApiErrorCode } from "../api/port";

/** i18n key for each API failure. Unknown or unmapped codes fall back to the generic message. */
export function errorKeyFor(code: ApiErrorCode, context: "otp" | "general" = "general"): string {
  switch (code) {
    case "network":
      return "errors.offline";
    case "rate_limited":
      return "errors.rateLimited";
    case "invalid_code":
      return context === "otp" ? "onboarding.otp.errorInvalid" : "errors.generic";
    case "code_expired":
      return context === "otp" ? "onboarding.otp.errorExpired" : "errors.generic";
    case "country_not_supported":
      return "onboarding.phone.errorCountry";
    default:
      return "errors.generic";
  }
}
