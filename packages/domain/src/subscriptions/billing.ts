import { divideRoundHalfEven } from "../money";
import { SubscriptionRuleError } from "./errors";
import {
  DAY_MS,
  DUNNING_RETRY_DAYS,
  GRACE_DAYS,
  REFUND_WINDOW_DAYS,
  type PlusInterval,
} from "./types";

/**
 * The Plus billing calculator. Pure integer arithmetic on piastres and epoch milliseconds.
 *
 * Rounding: the only rounding in this file is `divideRoundHalfEven` (money.ts, the one documented
 * rounding point of the system), used once in `prorationCredit`.
 * Proration, two options compared: (a) continuous by seconds, exact but the shopper sees a credit
 * that moves while reading the paywall; (b) whole unused days, which is stable, explainable ("20
 * days unused") and matches the spec. Chosen: (b).
 */

/** Adds calendar months in UTC, clamping to the last day of the target month (31 Jan + 1 = 28/29 Feb). */
export function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()),
  );
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}

export function periodEndFor(startMs: number, interval: PlusInterval): number {
  return addMonthsUtc(startMs, interval === "year" ? 12 : 1);
}

export interface ProrationInput {
  readonly monthlyPriceMinor: bigint;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly nowMs: number;
}

export interface ProrationResult {
  readonly daysInPeriod: number;
  readonly unusedDays: number;
  readonly creditMinor: bigint;
}

/** Credit = unused FULL days x (monthly price / days in the paid period), one half-even rounding. */
export function prorationCredit(i: ProrationInput): ProrationResult {
  if (i.monthlyPriceMinor < 0n) throw new SubscriptionRuleError("price must not be negative");
  const span = i.periodEndMs - i.periodStartMs;
  if (span <= 0) throw new SubscriptionRuleError("period must have a positive length");
  const daysInPeriod = Math.round(span / DAY_MS);
  if (daysInPeriod < 1) throw new SubscriptionRuleError("period must be at least one day");
  const rawUnused = Math.floor((i.periodEndMs - i.nowMs) / DAY_MS);
  const unusedDays = Math.min(Math.max(rawUnused, 0), daysInPeriod);
  const creditMinor = divideRoundHalfEven(i.monthlyPriceMinor * BigInt(unusedDays), BigInt(daysInPeriod));
  return { daysInPeriod, unusedDays, creditMinor };
}

export interface UpgradeCharge {
  readonly creditAppliedMinor: bigint;
  readonly chargeMinor: bigint;
}

/** The credit never exceeds the yearly price and the charge is never negative. */
export function upgradeCharge(yearlyPriceMinor: bigint, creditMinor: bigint): UpgradeCharge {
  if (yearlyPriceMinor < 0n || creditMinor < 0n) throw new SubscriptionRuleError("amounts must not be negative");
  const creditAppliedMinor = creditMinor > yearlyPriceMinor ? yearlyPriceMinor : creditMinor;
  return { creditAppliedMinor, chargeMinor: yearlyPriceMinor - creditAppliedMinor };
}

export interface YearlyMarketing {
  readonly payMonths: number;
  readonly freeMonths: number;
  readonly savingMinor: bigint;
}

/** "Pay 4 months, get 8 free": 800 = 4 x 200, saving 12 x 200 - 800 = 1,600 EGP. Never invented, always derived. */
export function yearlyMarketing(monthlyPriceMinor: bigint, yearlyPriceMinor: bigint): YearlyMarketing {
  if (monthlyPriceMinor <= 0n) throw new SubscriptionRuleError("monthly price must be positive");
  const payMonths = Number((yearlyPriceMinor + monthlyPriceMinor - 1n) / monthlyPriceMinor);
  const full = monthlyPriceMinor * 12n;
  return {
    payMonths,
    freeMonths: Math.max(12 - payMonths, 0),
    savingMinor: full > yearlyPriceMinor ? full - yearlyPriceMinor : 0n,
  };
}

// ---- dunning ---------------------------------------------------------------------------------

export function graceEndsAt(failedAtMs: number): number {
  return failedAtMs + GRACE_DAYS * DAY_MS;
}

export function dunningAttemptTimes(failedAtMs: number): readonly number[] {
  return DUNNING_RETRY_DAYS.map((d) => failedAtMs + d * DAY_MS);
}

export function dunningAttemptKey(subscriptionId: string, cycle: number, attempt: number): string {
  return `sub:${subscriptionId}:cycle:${cycle}:attempt:${attempt}`;
}

export type DunningAction =
  | { readonly kind: "retry"; readonly attempt: number; readonly dueAtMs: number }
  | { readonly kind: "wait"; readonly untilMs: number }
  | { readonly kind: "expire" };

/**
 * What the sweeper does for a PAST_DUE subscription. `attemptsMade` counts retries already tried
 * (the initial failed renewal is attempt 0). Retries happen at day 1, 3, 7; the 7-day grace ends
 * at day 7, so the third retry is the last chance and entitlements end at the grace end instant.
 */
export function nextDunningAction(failedAtMs: number, attemptsMade: number, nowMs: number): DunningAction {
  const grace = graceEndsAt(failedAtMs);
  const times = dunningAttemptTimes(failedAtMs);
  if (attemptsMade >= times.length) {
    return nowMs >= grace ? { kind: "expire" } : { kind: "wait", untilMs: grace };
  }
  if (nowMs > grace) return { kind: "expire" };
  const due = times[attemptsMade] ?? grace;
  return nowMs >= due ? { kind: "retry", attempt: attemptsMade + 1, dueAtMs: due } : { kind: "wait", untilMs: due };
}

// ---- refund ----------------------------------------------------------------------------------

export type RefundEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: "window_elapsed" | "benefit_used" | "already_refunded" };

/** Default policy (VR-P2-01, counsel to confirm): full refund within 14 days if no benefit was used since the charge. */
export function refundEligibility(i: {
  readonly chargedAtMs: number;
  readonly nowMs: number;
  readonly benefitUsedSinceCharge: boolean;
  readonly alreadyRefunded: boolean;
}): RefundEligibility {
  if (i.alreadyRefunded) return { eligible: false, reason: "already_refunded" };
  if (i.nowMs - i.chargedAtMs > REFUND_WINDOW_DAYS * DAY_MS) return { eligible: false, reason: "window_elapsed" };
  if (i.benefitUsedSinceCharge) return { eligible: false, reason: "benefit_used" };
  return { eligible: true };
}

// ---- revenue recognition ---------------------------------------------------------------------

/** How many monthly recognition entries are due now: elapsed whole months, capped at the total, minus done. */
export function recognitionDue(i: {
  readonly periodStartMs: number;
  readonly periodsTotal: number;
  readonly periodsRecognised: number;
  readonly nowMs: number;
}): number {
  let elapsed = 0;
  for (let k = 1; k <= i.periodsTotal; k += 1) {
    if (addMonthsUtc(i.periodStartMs, k) <= i.nowMs) elapsed = k;
    else break;
  }
  return Math.max(elapsed - i.periodsRecognised, 0);
}
