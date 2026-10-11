import type { SubscriptionState } from "../state-machine";

export const DAY_MS = 86_400_000;

export const PLUS_INTERVALS = ["month", "year"] as const;
export type PlusInterval = (typeof PLUS_INTERVALS)[number];

/** Plan A (ADR-0004): every perk is commerce-only. */
export const COMMERCE_BENEFIT_KEYS = [
  "free_delivery",
  "early_access_24h",
  "coins_plus_5pct",
  "free_returns",
  "plus_day",
  "monthly_voucher",
  "birthday_gift",
  "priority_support",
] as const;
export type CommerceBenefitKey = (typeof COMMERCE_BENEFIT_KEYS)[number];

/** Reserved for Plan B ("Stylist Pro" IAP). Empty by default; the stylist is never gated by Plus. */
export const APP_FEATURE_KEYS = [] as const;

export const ENTITLEMENT_GROUPS = ["commerce_benefits", "app_features"] as const;
export type EntitlementGroup = (typeof ENTITLEMENT_GROUPS)[number];

export interface EntitlementGrant {
  readonly group: EntitlementGroup;
  readonly key: string;
}

export const DUNNING_RETRY_DAYS = [1, 3, 7] as const;
export const GRACE_DAYS = 7;
export const REFUND_WINDOW_DAYS = 14;
export const PRICE_NOTICE_DAYS = 30;
export const TRIAL_REMINDER_DAYS = 2;
export const PAUSE_MONTHS_MIN = 1;
export const PAUSE_MONTHS_MAX = 3;
export const DEFAULT_PLUS_MIN_AGE = 21;
export const PLUS_VAT_BPS = 1_400n;

export interface PlusPlan {
  readonly id: string;
  readonly code: string;
  readonly interval: PlusInterval;
  readonly priceMinor: bigint;
  readonly version: number;
  readonly active: boolean;
  readonly trialDays: number;
  readonly effectiveFromMs: number;
  readonly notifiedAtMs: number | null;
}

/** Times are epoch milliseconds, stored UTC, shown in Africa/Cairo by clients. */
export interface PlusSubscription {
  readonly id: string;
  readonly userId: string;
  readonly planId: string;
  readonly planCode: string;
  readonly planVersion: number;
  readonly interval: PlusInterval;
  readonly status: SubscriptionState;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly trialEndMs: number | null;
  readonly cancelAtMs: number | null;
  readonly pausedAtMs: number | null;
  readonly pausedUntilMs: number | null;
  readonly graceEndsAtMs: number | null;
  readonly failedAtMs: number | null;
  readonly dunningAttempts: number;
  /** The billing cycle being, or last, charged. Part of the idempotency key. */
  readonly cycle: number;
  readonly nextActionAtMs: number | null;
  readonly pendingPlanCode: string | null;
  readonly trialReminderSentAtMs: number | null;
  readonly pspTokenRef: string;
  readonly createdAtMs: number;
  /** Optimistic concurrency token, incremented by the store on every save. */
  readonly version: number;
}

/** Spec 01 launch prices (piastres). Admin-versioned in `plans`; used to seed dev and tests only. */
export const DEFAULT_PLAN_DEFINITIONS = [
  { code: "plus_monthly", interval: "month", priceMinor: 20_000n, trialDays: 14 },
  { code: "plus_yearly", interval: "year", priceMinor: 80_000n, trialDays: 14 },
] as const;
