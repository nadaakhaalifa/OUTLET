import {
  buildAccessClaims,
  issueFamily,
  verifyOtp,
  type AttestationVerifier,
  type Csprng,
} from "@outlet/auth-core";
import type {
  AccessTokenIssuer,
  OtpChallengeRepository,
  SessionRepository,
  User,
  UserDirectory,
  UserLanguage,
} from "../domain/ports";
import { attestDevice, type Attestation, type Clock } from "./common";

export interface VerifyOtpDeps {
  readonly attestation: AttestationVerifier;
  readonly challenges: OtpChallengeRepository;
  readonly users: UserDirectory;
  readonly sessions: SessionRepository;
  readonly tokens: AccessTokenIssuer;
  readonly clock: Clock;
  readonly rng: Csprng;
  readonly newId: () => string;
  readonly pepper: Uint8Array;
  readonly issuer: string;
}

export interface VerifyOtpInput {
  readonly challengeId: string;
  readonly code: string;
  readonly installId: string;
  readonly platform: "ios" | "android";
  readonly language: UserLanguage;
  readonly attestation: Attestation | null;
}

export type VerifyOtpResult =
  | {
      readonly kind: "ok";
      readonly user: User;
      readonly sessionId: string;
      readonly accessToken: string;
      readonly accessExpiresAtMs: number;
      readonly refreshToken: string;
      readonly refreshExpiresAtMs: number;
    }
  | { readonly kind: "attestation_failed" }
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
    if (record === null || record.deviceKey !== deviceKey) return { kind: "invalid", attemptsRemaining: null };

    const nowMs = d.clock.nowMs();
    const result = verifyOtp(record.challenge, input.code, nowMs, d.pepper);
    if (result.outcome === "expired") return { kind: "expired" };
    if (result.outcome === "locked") return { kind: "locked" };
    if (result.outcome === "already_consumed") return { kind: "invalid", attemptsRemaining: null };

    // Persist the attempt (or the consumption) atomically before anything else happens.
    const saved = await d.challenges.compareAndSet(record.challenge, { ...record, challenge: result.challenge });
    if (!saved) return { kind: "invalid", attemptsRemaining: null };
    if (result.outcome === "wrong_code") return { kind: "invalid", attemptsRemaining: result.attemptsLeft };

    const user = await d.users.findOrCreateByPhone({
      phoneE164: record.challenge.phoneE164,
      language: input.language,
      newId: d.newId(),
      nowMs,
    });
    const sessionId = d.newId();
    const { family, token: refreshToken } = issueFamily({
      familyId: d.newId(),
      userId: user.id,
      deviceId: input.installId,
      recordId: d.newId(),
      rng: d.rng,
      nowMs,
    });
    const claims = buildAccessClaims({
      issuer: d.issuer,
      userId: user.id,
      audience: "buyer_api",
      sessionId,
      jti: d.newId(),
      amr: [record.channel === "sms" ? "otp_sms" : "otp_whatsapp", "attestation"],
      nowMs,
    });
    await d.sessions.insert({
      session: {
        id: sessionId,
        userId: user.id,
        deviceId: input.installId,
        familyId: family.familyId,
        amr: claims.amr,
        createdAtMs: nowMs,
        lastUsedAtMs: nowMs,
        revokedAtMs: null,
      },
      family,
      platform: input.platform,
    });
    const accessToken = await d.tokens.issue(claims);
    const refreshExpiresAtMs = family.records[0]?.expiresAtMs ?? nowMs;
    return {
      kind: "ok",
      user,
      sessionId,
      accessToken,
      accessExpiresAtMs: claims.exp * 1000,
      refreshToken,
      refreshExpiresAtMs,
    };
  }
}
