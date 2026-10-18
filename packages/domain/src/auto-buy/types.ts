import { AUTO_BUY_CANCEL_WINDOW_MINUTES } from "../state-machine";

/**
 * Price-drop auto-buy (spec docs/specs/phase-3/price-drop-auto-buy.md, ADR-0036).
 * Money is integer piastres (bigint); the feature is EGP only.
 */
export const AUTO_BUY_MODES = ["notify_confirm", "unattended"] as const;
export type AutoBuyMode = (typeof AUTO_BUY_MODES)[number];

/** Lifecycle of the standing rule. Attempts use the table-driven `priceDropAutoBuyMachine`. */
export const MANDATE_STATUSES = ["ARMED", "PURCHASED", "DISARMED", "EXPIRED"] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const AUTO_BUY_LIMITS = {
  /** Max 1 unit per rule (master prompt 28 row 1). */
  maxUnits: 1,
  /** Max active rules per user (configurable at the application layer). */
  maxActivePerUser: 5,
  maxExpiryDays: 90,
  /** Pre-charge window the shopper can cancel in. Single source: the state machine constant. */
  cancelWindowMs: AUTO_BUY_CANCEL_WINDOW_MINUTES * MINUTE_MS,
  /** One attempt per armed cycle: a new attempt for the same rule waits this long. */
  cooldownMs: DAY_MS,
  /**
   * A notice older than window + this is stale: the charge is skipped and the rule re-armed.
   * Equal to the payment allowance in the stock hold TTL, so a charge never runs on an expired hold.
   */
  noticeGraceMs: 10 * MINUTE_MS,
  /** Stock hold covers the window plus the time a payment may take. */
  reservationPaymentMs: 10 * MINUTE_MS,
  /** A charge with no outcome this long is reconciled by idempotency key, never guessed. */
  chargeUnresolvedMs: 10 * MINUTE_MS,
  /** A charge still "in progress" at the PSP this long after the claim goes to MANUAL_REVIEW, never FAILED. */
  chargeEscalateMs: 60 * MINUTE_MS,
  /** SCA requested but never completed. */
  scaAbandonMs: 30 * MINUTE_MS,
  sizeLabelMax: 32,
} as const;

export const MANDATE_TEXT_VERSION = 1;
export const MANDATE_LOCALES = ["ar", "en"] as const;
export type MandateLocale = (typeof MANDATE_LOCALES)[number];

export const idempotencyKeyFor = (mandateId: string, priceEventId: string): string => `auto_buy:${mandateId}:${priceEventId}`;

export const reservationTtlMs = (): number => AUTO_BUY_LIMITS.cancelWindowMs + AUTO_BUY_LIMITS.reservationPaymentMs;
