import { z } from "zod";
import { InvalidPhoneError } from "./errors";
import { MS } from "./ports";

/**
 * Defaults from spec 1. Resend base/cap and the prefix-anomaly numbers are engineering
 * defaults, not spec values: tune from real traffic (VERIFY BEFORE LAUNCH with SMS vendor data).
 */
export const OTP_POLICY = {
  digits: 6,
  validForMs: 5 * MS.minute,
  maxAttempts: 5,
  maxSendsPerPhonePerWindow: 3,
  phoneWindowMs: 15 * MS.minute,
  maxSendsPerDevicePerDay: 10,
  deviceWindowMs: MS.day,
  resendBaseMs: 30 * MS.second,
  resendCapMs: 15 * MS.minute,
  /** Calling codes (digits, no "+") allowed for OTP at launch. */
  allowedCallingCodes: ["20"] as readonly string[],
  prefixLength: 6, // characters after "+", e.g. "2010xx"
} as const;

export type OtpPolicy = typeof OTP_POLICY;

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/);

export function parseE164(input: string): string {
  const r = e164.safeParse(input);
  if (!r.success) throw new InvalidPhoneError("phone number is not valid E.164");
  return r.data;
}

export function isCountryAllowed(phoneE164: string, allowed: readonly string[] = OTP_POLICY.allowedCallingCodes): boolean {
  const digits = parseE164(phoneE164).slice(1);
  return allowed.some((cc) => digits.startsWith(cc));
}

export function phonePrefix(phoneE164: string, length: number = OTP_POLICY.prefixLength): string {
  return parseE164(phoneE164).slice(1, 1 + length);
}

/** Exponential resend delay: base * 2^(sendsSoFar-1), capped. 0 before any send. */
export function resendDelayMs(sendsSoFar: number, policy: OtpPolicy = OTP_POLICY): number {
  if (sendsSoFar <= 0) return 0;
  const exp = Math.min(sendsSoFar - 1, 30);
  return Math.min(policy.resendBaseMs * 2 ** exp, policy.resendCapMs);
}

export interface SendHistory {
  /** Epoch ms of earlier sends to this phone (any window; filtered here). */
  readonly phoneSendTimes: readonly number[];
  /** Epoch ms of earlier sends from this device. */
  readonly deviceSendTimes: readonly number[];
}

export type SendDecision =
  | { readonly allowed: true; readonly nextResendInMs: number }
  | {
      readonly allowed: false;
      readonly reason: "country_not_allowed" | "phone_rate_limited" | "device_daily_limit" | "resend_too_soon";
      readonly retryAfterMs: number | null;
    };

export function evaluateOtpSend(
  phoneE164: string,
  history: SendHistory,
  nowMs: number,
  policy: OtpPolicy = OTP_POLICY,
): SendDecision {
  if (!isCountryAllowed(phoneE164, policy.allowedCallingCodes)) {
    return { allowed: false, reason: "country_not_allowed", retryAfterMs: null };
  }
  const phoneRecent = history.phoneSendTimes.filter((t) => t > nowMs - policy.phoneWindowMs && t <= nowMs).sort((a, b) => a - b);
  const deviceRecent = history.deviceSendTimes.filter((t) => t > nowMs - policy.deviceWindowMs && t <= nowMs).sort((a, b) => a - b);

  if (deviceRecent.length >= policy.maxSendsPerDevicePerDay) {
    const oldestBlocking = deviceRecent[deviceRecent.length - policy.maxSendsPerDevicePerDay] ?? nowMs;
    return { allowed: false, reason: "device_daily_limit", retryAfterMs: oldestBlocking + policy.deviceWindowMs - nowMs };
  }
  if (phoneRecent.length >= policy.maxSendsPerPhonePerWindow) {
    const oldestBlocking = phoneRecent[phoneRecent.length - policy.maxSendsPerPhonePerWindow] ?? nowMs;
    return { allowed: false, reason: "phone_rate_limited", retryAfterMs: oldestBlocking + policy.phoneWindowMs - nowMs };
  }
  const last = phoneRecent[phoneRecent.length - 1];
  if (last !== undefined) {
    const wait = last + resendDelayMs(phoneRecent.length, policy) - nowMs;
    if (wait > 0) return { allowed: false, reason: "resend_too_soon", retryAfterMs: wait };
  }
  return { allowed: true, nextResendInMs: resendDelayMs(phoneRecent.length + 1, policy) };
}

// ---- Per-prefix anomaly flag (SMS pumping) ------------------------------------------

export interface PrefixStats {
  readonly prefix: string;
  readonly sends: number;
  readonly verified: number;
}

export const PREFIX_ANOMALY_DEFAULTS = {
  /** Do not judge a prefix on fewer sends than this. */
  minSamples: 20,
  /** Flag when verified/sends falls below this. */
  minConversion: 0.3,
  /** Hard per-prefix send budget for the observation window. */
  budget: 500,
} as const;

export type PrefixAnomaly =
  | { readonly flagged: false }
  | { readonly flagged: true; readonly reason: "budget_exceeded" | "low_conversion" };

export function flagPrefixAnomaly(stats: PrefixStats, cfg: typeof PREFIX_ANOMALY_DEFAULTS = PREFIX_ANOMALY_DEFAULTS): PrefixAnomaly {
  if (stats.sends > cfg.budget) return { flagged: true, reason: "budget_exceeded" };
  if (stats.sends >= cfg.minSamples && stats.verified / stats.sends < cfg.minConversion) {
    return { flagged: true, reason: "low_conversion" };
  }
  return { flagged: false };
}
