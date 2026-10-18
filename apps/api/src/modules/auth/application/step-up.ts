import { evaluateRecycledNumber } from "@outlet/auth-core";
import type { SessionRepository, User } from "../domain/ports";
import type { ChallengeOptions } from "./passkeys";

/**
 * Recycled-number step-up (master prompt section 1, VR-GUEST-06; design in docs/specs/guest-browsing.md
 * "Recycled-number step-up").
 *
 * An OTP proves possession of the number, not of the account: Egyptian operators recycle numbers. When the
 * account behind the number was last used more than 180 days ago AND the install signing in never held a
 * session of that account, OTP alone is not enough. No session and no token are issued; the caller gets a
 * typed `step_up_required` carrying a passkey assertion challenge bound to that account. Fail closed: any
 * read failure propagates (no tokens), and an account with no recorded activity counts as stale.
 */
export interface StepUpChallenge {
  /**
   * Factors the SERVER offers, a constant (never per account), so the answer leaks nothing about which
   * factors this account has enrolled. `email_link` is not built (no email provider; owner decision).
   */
  readonly factors: readonly ["passkey"];
  /** A passkey assertion challenge bound to the account: only that account's credential can satisfy it. */
  readonly passkey: ChallengeOptions;
}

export interface StepUpDeps {
  readonly sessions: SessionRepository;
  /** PasskeyService.issueChallenge: a challenge with `userId` set binds the assertion to that account. */
  readonly passkeyChallenges: { issueChallenge(purpose: "assert", userId: string): Promise<ChallengeOptions> };
}

export class RecycledNumberStepUp {
  constructor(private readonly deps: StepUpDeps) {}

  /** Null when OTP alone may open a session; otherwise the challenge the client must answer with a passkey. */
  async check(input: { readonly user: User; readonly installId: string; readonly nowMs: number }): Promise<StepUpChallenge | null> {
    const sessions = await this.deps.sessions.listByUser(input.user.id);
    // Activity = the latest use of any session (revoked ones included: they still prove the owner was here).
    // With no session at all, the account creation time is the only evidence of use.
    let lastUsedAtMs = sessions.length === 0 ? input.user.createdAtMs : Number.NEGATIVE_INFINITY;
    for (const s of sessions) lastUsedAtMs = Math.max(lastUsedAtMs, s.session.lastUsedAtMs, s.session.createdAtMs);
    const decision = evaluateRecycledNumber({
      lastUsedAtMs: Number.isFinite(lastUsedAtMs) ? lastUsedAtMs : null,
      nowMs: input.nowMs,
      deviceKnownToAccount: sessions.some((s) => s.session.deviceId === input.installId),
      // Per-account factors are deliberately not consulted: the response is the same either way (no oracle),
      // and tokens are never issued without the second factor (stricter than the domain's "proceed, hide value").
      hasVerifiedEmail: false,
      hasPasskey: false,
    });
    if (!decision.secondFactorRequired) return null;
    return { factors: ["passkey"], passkey: await this.deps.passkeyChallenges.issueChallenge("assert", input.user.id) };
  }
}
