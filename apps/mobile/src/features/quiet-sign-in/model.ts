import type { ApiResult, VerifiedLogin } from "../../api/port";
import type { AuthTokens } from "../../platform/secure-storage";
import { errorKeyFor } from "../api-errors";

/**
 * Quiet sign-in (ADR-0055 F5): for EXISTING accounts only. It never creates an account and never starts sign-up.
 */
export type QuietVerifyOutcome =
  | { readonly kind: "signed_in" }
  | { readonly kind: "no_account" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error"; readonly errorKey: string };

export interface QuietVerifyDeps {
  verifyOtp(input: { phoneE164: string; code: string; mode: "existing_only" }): Promise<ApiResult<VerifiedLogin>>;
  save(tokens: AuthTokens): Promise<void>;
  /** An existing account already finished its sign-up elsewhere. */
  markOnboardingDone(): Promise<void>;
}

/**
 * Always sends `mode: "existing_only"` (API gap G-9): the server creates nothing for an unknown number. 404 `no_account`
 * is the honest "no account" view; any other failure of this mode (feature blocked) is "not available right now" and
 * never falls through to the default create mode. Tokens are stored only on a real sign-in.
 */
export async function runQuietVerify(deps: QuietVerifyDeps, phoneE164: string, code: string): Promise<QuietVerifyOutcome> {
  const result = await deps.verifyOtp({ phoneE164, code, mode: "existing_only" });
  if (!result.ok) {
    if (result.error.code === "no_account") return { kind: "no_account" };
    if (result.error.code === "sign_in_unavailable") return { kind: "unavailable" };
    return { kind: "error", errorKey: errorKeyFor(result.error.code, "otp") };
  }
  await deps.save(result.value.tokens);
  await deps.markOnboardingDone();
  return { kind: "signed_in" };
}

/** Routes that must stay out of this feature (R0). Used by the test as a belt-and-braces check on the source text. */
export const SIGN_IN_ROUTE = "/sign-in";
