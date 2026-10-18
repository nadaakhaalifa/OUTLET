import {
  verifyOtp,
  type AttestationVerifier,
  type Csprng,
} from "@outlet/auth-core";
import {
  AccountUnavailableError,
  type OtpChallengeRepository,
  type User,
  type UserDirectory,
  type UserLanguage,
} from "../domain/ports";
import type { AgeGate } from "./age-gate";
import { attestDevice, type Attestation, type Clock } from "./common";
import type { SessionIssuer } from "./session-issuer";
import type { RecycledNumberStepUp, StepUpChallenge } from "./step-up";

export interface VerifyOtpDeps {
  readonly attestation: AttestationVerifier;
  readonly challenges: OtpChallengeRepository;
  readonly users: UserDirectory;
  readonly issuer: SessionIssuer;
  readonly clock: Clock;
  readonly rng: Csprng;
  readonly newId: () => string;
  readonly pepper: Uint8Array;
  /** Supplies the age band recorded by the passed age gate for a new account. */
  readonly ageGate?: AgeGate;
  /** Recycled-number step-up (VR-GUEST-06). Required: there is no "off" switch, so it cannot be left out by mistake. */
  readonly stepUp: RecycledNumberStepUp;
}

export interface VerifyOtpInput {
  readonly challengeId: string;
  readonly code: string;
  readonly installId: string;
  readonly platform: "ios" | "android";
  readonly language: UserLanguage;
  readonly attestation: Attestation | null;
  /**
   * `create` (default, the checkout sign-up): a new number gets an account. `existing_only` (quiet sign-in, ADR-0055 G-9):
   * a number with no account answers `no_account` and creates NOTHING (no user, device, session or token).
   */
  readonly mode?: "create" | "existing_only";
}

export type VerifyOtpResult =
  | {
      readonly kind: "ok";
      readonly user: User;
      /** True only when create mode just created this user (never for an existing account or existing_only). */
      readonly isNewAccount: boolean;
      readonly sessionId: string;
      readonly accessToken: string;
      readonly accessExpiresAtMs: number;
      readonly refreshToken: string;
      readonly refreshExpiresAtMs: number;
    }
  | { readonly kind: "attestation_failed" }
  /** `existing_only` and no account for the verified number. The challenge is already consumed. */
  | { readonly kind: "no_account" }
  /** Create mode on a number whose account is suspended: nothing was created and no session opened. */
  | { readonly kind: "account_unavailable" }
  /**
   * Correct code, but the account was idle for more than 180 days and this install never held one of its
   * sessions (recycled number). No session, device row or token was created; the code is consumed.
   */
  | { readonly kind: "step_up_required"; readonly challenge: StepUpChallenge }
  /** Unknown challenge, wrong device, wrong code and replay are indistinguishable to the caller. */
  | { readonly kind: "invalid"; readonly attemptsRemaining: number | null }
  | { readonly kind: "expired" }
  | { readonly kind: "locked" };

export class VerifyOtp {
  constructor(private readonly deps: VerifyOtpDeps) {}

  async execute(input: VerifyOtpInput): Promise<VerifyOtpResult> {
    const d = this.deps;
    const deviceKey = await attestDevice(d.attestation, input.attestation);
    if (deviceKey === null) return { kind: "attestation_failed" };

    const record = await d.challenges.find(input.challengeId);
    if (record === null || record.deviceKey !== (await d.challenges.deviceKeyOf(deviceKey))) return { kind: "invalid", attemptsRemaining: null };

    const nowMs = d.clock.nowMs();
    const result = verifyOtp(record.challenge, input.code, nowMs, d.pepper);
    if (result.outcome === "expired") return { kind: "expired" };
    if (result.outcome === "locked") return { kind: "locked" };
    if (result.outcome === "already_consumed") return { kind: "invalid", attemptsRemaining: null };

    // Persist the attempt (or the consumption) atomically before anything else happens.
    const saved = await d.challenges.compareAndSet(record.challenge, { ...record, challenge: result.challenge });
    if (!saved) return { kind: "invalid", attemptsRemaining: null };
    if (result.outcome === "wrong_code") return { kind: "invalid", attemptsRemaining: result.attemptsLeft };

    let user: User | null;
    let isNewAccount = false;
    if (input.mode === "existing_only") {
      // Read only. Reached solely after a CORRECT code, so existence is revealed only to the holder of the number.
      // A suspended account is not "active" and is reported as no_account (the same answer, no extra oracle).
      user = await d.users.findByPhone(record.challenge.phoneE164);
      if (user === null) return { kind: "no_account" };
    } else {
      const age = d.ageGate === undefined ? null : await d.ageGate.passInfo(deviceKey);
      const newId = d.newId();
      try {
        user = await d.users.findOrCreateByPhone({
          age,
          phoneE164: record.challenge.phoneE164,
          language: input.language,
          newId,
          nowMs,
        });
      } catch (error) {
        if (error instanceof AccountUnavailableError) return { kind: "account_unavailable" };
        throw error;
      }
      // The directory returns the existing row on a repeat sign-in, so our fresh id survives only on creation.
      isNewAccount = user.id === newId;
    }
    // Only an account that existed before this call can be a recycled number. Fail closed: a read error throws.
    if (!isNewAccount) {
      const challenge = await d.stepUp.check({ user, installId: input.installId, deviceKeyHash: record.deviceKey, nowMs });
      if (challenge !== null) return { kind: "step_up_required", challenge };
    }
    const issued = await d.issuer.open({
      user,
      installId: input.installId,
      platform: input.platform,
      amr: [record.channel === "sms" ? "otp_sms" : "otp_whatsapp", "attestation"],
      deviceKeyHash: record.deviceKey,
    });
    return { kind: "ok", user, isNewAccount, ...issued };
  }
}
