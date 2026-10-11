import { isInQuietHours, nextQuietEnd, trailingDateKeys, cairoParts } from "./cairo-time";
import {
  MARKETING_PURPOSE,
  type Category,
  type ExternalChannel,
  type FrequencyCaps,
  type QuietHours,
  type SuppressedReason,
  type SuppressionReason,
} from "./types";

export type ChannelDecision =
  | { readonly kind: "send" }
  | { readonly kind: "defer"; readonly untilMs: number }
  | { readonly kind: "suppress"; readonly reason: SuppressedReason };

export interface ChannelDecisionInput {
  readonly category: Category;
  readonly channel: ExternalChannel;
  readonly nowMs: number;
  /** Active suppression reasons for this user and channel. */
  readonly suppressions: ReadonlySet<SuppressionReason>;
  /** Consent for the channel's marketing purpose. Ignored for non-marketing. */
  readonly consentGranted: boolean;
  /** Effective preference for the template type on this channel. Ignored for non-marketing. */
  readonly typeEnabled: boolean;
  /** Delivery times (UTC ms) of marketing messages on this channel. */
  readonly marketingSentAtMs: readonly number[];
  readonly caps: FrequencyCaps;
  readonly quiet: QuietHours;
  readonly expiresAtMs: number;
}

/** Marketing sends counted on the Cairo day of `nowMs` and over the trailing 7 Cairo days. */
export function frequencyUsage(sentAtMs: readonly number[], nowMs: number): { readonly day: number; readonly week: number } {
  const week = new Set(trailingDateKeys(nowMs, 7));
  const today = cairoParts(nowMs).dateKey;
  let day = 0;
  let w = 0;
  for (const t of sentAtMs) {
    const key = cairoParts(t).dateKey;
    if (key === today) day += 1;
    if (week.has(key)) w += 1;
  }
  return { day, week: w };
}

/**
 * Pure decision for one external channel. Order: technical suppression, then (marketing only)
 * channel permission, consent, preference, unsubscribe list, quiet hours, frequency cap.
 * Transactional and security are exempt from consent, preference, quiet hours and caps.
 */
export function decideChannel(i: ChannelDecisionInput): ChannelDecision {
  const technical = i.suppressions.has("BOUNCE") || i.suppressions.has("INVALID_TOKEN");
  if (technical) return { kind: "suppress", reason: "SUPPRESSION_LIST" };
  if (i.category !== "marketing") return { kind: "send" };

  if (MARKETING_PURPOSE[i.channel] === undefined) return { kind: "suppress", reason: "NO_CONSENT" };
  if (i.suppressions.has("UNSUBSCRIBED") || i.suppressions.has("COMPLAINT")) {
    return { kind: "suppress", reason: "SUPPRESSION_LIST" };
  }
  if (!i.consentGranted) return { kind: "suppress", reason: "NO_CONSENT" };
  if (!i.typeEnabled) return { kind: "suppress", reason: "PREFERENCE" };

  if (isInQuietHours(i.nowMs, i.quiet)) {
    const until = nextQuietEnd(i.nowMs, i.quiet);
    if (until > i.expiresAtMs) return { kind: "suppress", reason: "QUIET_HOURS" };
    return { kind: "defer", untilMs: until };
  }

  const usage = frequencyUsage(i.marketingSentAtMs, i.nowMs);
  if (usage.day >= i.caps.perDay || usage.week >= i.caps.perWeek) return { kind: "suppress", reason: "FREQUENCY_CAP" };
  return { kind: "send" };
}

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 3_600_000;

/** Deterministic 32-bit FNV-1a, used as jitter seed so retries are reproducible. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Exponential backoff with deterministic jitter in [0, 25%] of the delay. attempt starts at 1. */
export function retryDelayMs(attempt: number, seed: string): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(exp * 0.25 * (fnv1a(`${seed}:${attempt}`) / 0xffffffff));
  return exp + jitter;
}
