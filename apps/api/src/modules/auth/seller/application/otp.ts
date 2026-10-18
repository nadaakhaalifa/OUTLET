import {
  MS,
  OTP_POLICY,
  PREFIX_ANOMALY_DEFAULTS,
  createOtpChallenge,
  evaluateOtpSend,
  flagPrefixAnomaly,
  parseE164,
  phonePrefix,
  sendWithFailover,
  sha256Hex,
  toHex,
  verifyOtp,
  type Csprng,
  type OtpChannel,
  type OtpPolicy,
  type OtpSender,
} from "@outlet/auth-core";
import type { UserLanguage } from "../../domain/ports";
import type { Clock } from "../../application/common";
import type {
  SellerAuthEvents,
  SellerOtpChallengeRepository,
  SellerOtpProofStore,
  SellerOtpSendLog,
  SellerUserDirectory,
} from "../domain/ports";
import type { SellerSessionIssuer } from "./sessions";

/**
 * Sellers can be international: every calling code is allowed (the buyer allow-list does not apply),
 * so abuse control moves to a per-prefix hourly cap plus an anomaly alert (SMS pumping).
 */
export const SELLER_OTP_POLICY: OtpPolicy = { ...OTP_POLICY, allowedCallingCodes: [""] };
export const SELLER_PREFIX_WINDOW_MS = MS.hour;
export const SELLER_PREFIX_CAP_PER_HOUR = 50;
export const OTP_PROOF_TTL_MS = 5 * MS.minute;

export const NIL_INSTALL_ID = "00000000-0000-0000-0000-000000000000";

export interface SellerOtpDeps {
  readonly senders: readonly OtpSender[];
  readonly challenges: SellerOtpChallengeRepository;
  readonly sendLog: SellerOtpSendLog;
  readonly proofs: SellerOtpProofStore;
  readonly users: SellerUserDirectory;
  readonly issuer: SellerSessionIssuer;
  readonly events: SellerAuthEvents;
  readonly clock: Clock;
  readonly rng: Csprng;
  readonly newId: () => string;
  readonly pepper: Uint8Array;
  readonly prefixCapPerHour?: number;
}

export type SellerOtpRequestResult =
  | { readonly kind: "sent"; readonly challengeId: string; readonly expiresInSec: number; readonly resendAfterSec: number }
  | { readonly kind: "attestation_failed" }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number | null }
  | { readonly kind: "delivery_failed" }
  | { readonly kind: "provider_not_configured" };

export type SellerOtpVerifyResult =
  | {
      readonly kind: "ok";
      readonly enrolToken: string;
      readonly expiresInSec: number;
      readonly strongFactorEnrolled: boolean;
      readonly nextStep: "enrol_strong_factor" | "assert_strong_factor";
      readonly otpProof: string | null;
    }
  | { readonly kind: "invalid"; readonly attemptsRemaining: number | null }
  | { readonly kind: "expired" }
  | { readonly kind: "locked" };

export const hashProof = (proof: string): string => sha256Hex(`seller-otp-proof:v1:${proof}`);

export class SellerOtp {
  constructor(private readonly deps: SellerOtpDeps) {}

  async request(input: {
    phoneE164: string;
    email: string;
    language: UserLanguage;
    channel: OtpChannel | undefined;
    clientKey: string;
    sendKey: string;
  }): Promise<SellerOtpRequestResult> {
    const d = this.deps;
    const nowMs = d.clock.nowMs();
    const phone = parseE164(input.phoneE164);
    const prefix = phonePrefix(phone);
    const history = await d.sendLog.history(phone, input.clientKey, prefix, nowMs, SELLER_PREFIX_WINDOW_MS);

    const anomaly = flagPrefixAnomaly({ prefix, sends: history.prefixSends, verified: history.prefixVerified }, PREFIX_ANOMALY_DEFAULTS);
    if (anomaly.flagged) await d.events.publish({ type: "seller.otp_prefix_anomaly", prefix, reason: anomaly.reason, occurredAtMs: nowMs });
    if (history.prefixSends >= (d.prefixCapPerHour ?? SELLER_PREFIX_CAP_PER_HOUR)) {
      await d.events.publish({ type: "seller.otp_prefix_anomaly", prefix, reason: "prefix_cap", occurredAtMs: nowMs });
      return { kind: "rate_limited", retryAfterMs: SELLER_PREFIX_WINDOW_MS };
    }

    const decision = evaluateOtpSend(phone, { phoneSendTimes: history.phoneSendTimes, deviceSendTimes: history.clientSendTimes }, nowMs, SELLER_OTP_POLICY);
    if (!decision.allowed) return { kind: "rate_limited", retryAfterMs: decision.retryAfterMs };

    const { challenge, code } = createOtpChallenge({ id: d.newId(), phoneE164: phone, rng: d.rng, pepper: d.pepper, nowMs });
    const chain =
      input.channel === undefined
        ? d.senders
        : [...d.senders.filter((s) => s.channel === input.channel), ...d.senders.filter((s) => s.channel !== input.channel)];
    const sent = await sendWithFailover(chain, { phoneE164: phone, code, locale: input.language, idempotencyKey: input.sendKey });
    if (!sent.ok) {
      const none = sent.attempts.length > 0 && sent.attempts.every((a) => a.reason === "provider_not_configured");
      return { kind: none ? "provider_not_configured" : "delivery_failed" };
    }
    const channel = chain.find((s) => s.id === sent.senderId)?.channel ?? "sms";
    await d.challenges.insert({ challenge, channel, clientKey: input.clientKey, email: input.email, language: input.language });
    await d.sendLog.record(phone, input.clientKey, prefix, nowMs);
    return {
      kind: "sent",
      challengeId: challenge.id,
      expiresInSec: Math.floor((challenge.expiresAtMs - nowMs) / 1000),
      resendAfterSec: Math.ceil(decision.nextResendInMs / 1000),
    };
  }

  async verify(input: { challengeId: string; code: string; clientKey: string; installId: string }): Promise<SellerOtpVerifyResult> {
    const d = this.deps;
    const record = await d.challenges.find(input.challengeId);
    if (record === null) return { kind: "invalid", attemptsRemaining: null };
    // A device-attested challenge must be verified from the same device; web clients share one bucket (not IP bound: NAT, mobile data).
    if (record.clientKey !== (await d.challenges.clientKeyOf(input.clientKey))) return { kind: "invalid", attemptsRemaining: null };
    const nowMs = d.clock.nowMs();
    const result = verifyOtp(record.challenge, input.code, nowMs, d.pepper, SELLER_OTP_POLICY);
    if (result.outcome === "expired") return { kind: "expired" };
    if (result.outcome === "locked") return { kind: "locked" };
    if (result.outcome === "already_consumed") return { kind: "invalid", attemptsRemaining: null };
    if (!(await d.challenges.compareAndSet(record.challenge, { ...record, challenge: result.challenge }))) return { kind: "invalid", attemptsRemaining: null };
    if (result.outcome === "wrong_code") return { kind: "invalid", attemptsRemaining: result.attemptsLeft };

    const seller = await d.users.findOrCreateByPhone({
      phoneE164: record.challenge.phoneE164,
      email: record.email,
      language: record.language,
      newId: d.newId(),
      nowMs,
    });
    // A suspended seller gets the same answer as a wrong code: no account state leaks.
    if (seller.status !== "active") return { kind: "invalid", attemptsRemaining: null };
    await d.sendLog.markVerified(record.challenge.phoneE164, nowMs);

    const amrOtp = record.channel === "sms" ? "otp_sms" : "otp_whatsapp";
    const enrol = await d.issuer.openEnrol({
      sellerUserId: seller.id,
      installId: input.installId,
      amr: [amrOtp],
      // An identity that already has a strong factor must not be able to enrol another with a phone code alone (SIM swap).
      restricted: seller.strongFactor,
    });
    let otpProof: string | null = null;
    if (seller.strongFactor) {
      otpProof = toHex(d.rng.randomBytes(32));
      await d.proofs.put(hashProof(otpProof), { sellerUserId: seller.id, channel: record.channel }, nowMs + OTP_PROOF_TTL_MS);
    }
    return {
      kind: "ok",
      enrolToken: enrol.accessToken,
      expiresInSec: enrol.expiresInSec,
      strongFactorEnrolled: seller.strongFactor,
      nextStep: seller.strongFactor ? "assert_strong_factor" : "enrol_strong_factor",
      otpProof,
    };
  }
}
