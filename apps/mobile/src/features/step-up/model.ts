import type { ApiResult, StepUpChallenge, VerifiedLogin } from "../../api/port";
import type { AuthTokens } from "../../platform/secure-storage";
import { errorKeyFor } from "../api-errors";

/**
 * Recycled-number step-up (VR-GUEST-06, docs/specs/guest-browsing.md). After a correct code the server answered 403
 * step_up_required with NO tokens. The only way forward is a passkey assertion on this device. There is no fallback
 * to create mode, no recovery promise, and no stored value is shown without a session.
 */
export type AssertionResult =
  | { readonly kind: "ok"; readonly credential: Readonly<Record<string, unknown>> }
  | { readonly kind: "unsupported" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error" };

/** Platform WebAuthn assertion. No native passkey library is in this build, so the real adapter is the unsupported one. */
export interface PasskeyAssertionPort {
  isSupported(): Promise<boolean>;
  assert(challenge: StepUpChallenge): Promise<AssertionResult>;
}

export class UnsupportedPasskeyAssertion implements PasskeyAssertionPort {
  async isSupported(): Promise<boolean> { return false; }
  async assert(): Promise<AssertionResult> { return { kind: "unsupported" }; }
}

let port: PasskeyAssertionPort = new UnsupportedPasskeyAssertion();
export const getPasskeyAssertion = (): PasskeyAssertionPort => port;
/** Composition root and tests only. */
export const setPasskeyAssertion = (p: PasskeyAssertionPort): void => { port = p; };

export type StepUpOutcome =
  | { readonly kind: "signed_in" }
  /** No usable passkey (unsupported, cancelled, expired, rejected): contact-support state, nothing stored. */
  | { readonly kind: "contact_support" }
  | { readonly kind: "error"; readonly errorKey: string };

export interface StepUpDeps {
  readonly passkey: PasskeyAssertionPort;
  assertPasskey(input: { challengeId: string; credential: Readonly<Record<string, unknown>> }): Promise<ApiResult<VerifiedLogin>>;
  save(tokens: AuthTokens): Promise<void>;
  markOnboardingDone(): Promise<void>;
  nowMs(): number;
}

export async function runStepUp(deps: StepUpDeps, challenge: StepUpChallenge): Promise<StepUpOutcome> {
  if (challenge.expiresAtMs <= deps.nowMs()) return { kind: "contact_support" };
  if (!(await deps.passkey.isSupported())) return { kind: "contact_support" };
  const a = await deps.passkey.assert(challenge);
  if (a.kind === "unsupported" || a.kind === "cancelled") return { kind: "contact_support" };
  if (a.kind === "error") return { kind: "error", errorKey: "errors.generic" };
  const r = await deps.assertPasskey({ challengeId: challenge.challengeId, credential: a.credential });
  if (!r.ok) {
    // 401 (wrong account's credential, suspended, expired or used challenge) is not retryable from here.
    if (r.error.code === "unauthenticated") return { kind: "contact_support" };
    return { kind: "error", errorKey: errorKeyFor(r.error.code) };
  }
  await deps.save(r.value.tokens);
  await deps.markOnboardingDone();
  return { kind: "signed_in" };
}
