import {
  OTP_POLICY,
  createOtpChallenge,
  evaluateOtpSend,
  sendWithFailover,
  type AttestationVerifier,
  type Csprng,
  type OtpChannel,
  type OtpSender,
} from "@outlet/auth-core";
import type { OtpChallengeRepository, OtpSendLog, UserLanguage } from "../domain/ports";
import type { AgeGate } from "./age-gate";
import { attestDevice, type Attestation, type Clock } from "./common";

export interface RequestOtpDeps {
  readonly attestation: AttestationVerifier;
  readonly senders: readonly OtpSender[];
  readonly challenges: OtpChallengeRepository;
  readonly sendLog: OtpSendLog;
  readonly clock: Clock;
  readonly rng: Csprng;
  readonly newId: () => string;
  readonly pepper: Uint8Array;
  readonly ageGate: AgeGate;
}

export interface RequestOtpInput {
  readonly phoneE164: string;
  readonly channel: OtpChannel | undefined;
  readonly language: UserLanguage;
  readonly attestation: Attestation | null;
  /** Idempotency key forwarded to the provider so a provider retry cannot double-send. */
  readonly sendKey: string;
}

export type RequestOtpResult =
  | {
      readonly kind: "sent";
      readonly challengeId: string;
      readonly expiresAtMs: number;
      readonly resendAvailableAtMs: number;
      readonly attemptsRemaining: number;
      readonly channel: OtpChannel;
    }
  | { readonly kind: "attestation_failed" }
  /** No passed age gate for this device: nothing is sent. */
  | { readonly kind: "age_gate_required" }
  | { readonly kind: "age_blocked"; readonly blockedUntilMs: number }
  | { readonly kind: "country_not_allowed" }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number | null }
  | { readonly kind: "delivery_failed" }
  /** Every sender is an Unconfigured production adapter: nothing was sent, answer 503 provider_not_configured. */
  | { readonly kind: "provider_not_configured" };

export class RequestOtp {
  constructor(private readonly deps: RequestOtpDeps) {}

  async execute(input: RequestOtpInput): Promise<RequestOtpResult> {
    const d = this.deps;
    const deviceKey = await attestDevice(d.attestation, input.attestation);
    if (deviceKey === null) return { kind: "attestation_failed" };

    const gate = await d.ageGate.status(deviceKey);
    if (gate.kind === "required") return { kind: "age_gate_required" };
    if (gate.kind === "blocked") return { kind: "age_blocked", blockedUntilMs: gate.blockedUntilMs };

    const nowMs = d.clock.nowMs();
    const history = await d.sendLog.history(input.phoneE164, deviceKey, nowMs);
    const decision = evaluateOtpSend(input.phoneE164, history, nowMs);
    if (!decision.allowed) {
      return decision.reason === "country_not_allowed"
        ? { kind: "country_not_allowed" }
        : { kind: "rate_limited", retryAfterMs: decision.retryAfterMs };
    }

    const { challenge, code } = createOtpChallenge({
      id: d.newId(),
      phoneE164: input.phoneE164,
      rng: d.rng,
      pepper: d.pepper,
      nowMs,
    });

    // Requested channel first, then the remaining senders in configured order (spec 1 failover).
    const chain =
      input.channel === undefined
        ? d.senders
        : [...d.senders.filter((s) => s.channel === input.channel), ...d.senders.filter((s) => s.channel !== input.channel)];
    const sent = await sendWithFailover(chain, {
      phoneE164: input.phoneE164,
      code,
      locale: input.language,
      idempotencyKey: input.sendKey,
    });
    if (!sent.ok) {
      const none = sent.attempts.length > 0 && sent.attempts.every((a) => a.reason === "provider_not_configured");
      return { kind: none ? "provider_not_configured" : "delivery_failed" };
    }

    const channel = chain.find((s) => s.id === sent.senderId)?.channel ?? "sms";
    await d.challenges.insert({ challenge, channel, deviceKey });
    await d.sendLog.record(input.phoneE164, deviceKey, nowMs);
    return {
      kind: "sent",
      challengeId: challenge.id,
      expiresAtMs: challenge.expiresAtMs,
      resendAvailableAtMs: nowMs + decision.nextResendInMs,
      attemptsRemaining: OTP_POLICY.maxAttempts,
      channel,
    };
  }
}
