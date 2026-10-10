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
  | { readonly kind: "country_not_allowed" }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number | null }
  | { readonly kind: "delivery_failed" };

export class RequestOtp {
  constructor(private readonly deps: RequestOtpDeps) {}

  async execute(input: RequestOtpInput): Promise<RequestOtpResult> {
    const d = this.deps;
    const deviceKey = await attestDevice(d.attestation, input.attestation);
    if (deviceKey === null) return { kind: "attestation_failed" };

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
    if (!sent.ok) return { kind: "delivery_failed" };

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
