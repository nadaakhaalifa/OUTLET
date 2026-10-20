import { AUTO_BUY_LIMITS, type MandateStatus } from "./types";

export interface MandateView {
  readonly status: MandateStatus;
  readonly skuId: string;
  readonly targetPrice: bigint;
  readonly maxPrice: bigint;
  readonly expiresAtMs: number;
  /** When the most recent attempt for this rule was created, or null. */
  readonly lastAttemptAtMs: number | null;
  /** Any attempt of this rule still open (triggered, notified, charging, SCA, manual review). */
  readonly hasOpenAttempt: boolean;
}

export interface PriceSignal {
  readonly eventId: string;
  readonly skuId: string;
  readonly price: bigint;
  /** A verified price per the Price Integrity Engine (spec 9), not a plain price cut. */
  readonly verified: boolean;
  /** Price-integrity anomaly flag (seller error, ping-pong, spike): never an unattended charge. */
  readonly anomaly: boolean;
  readonly occurredAtMs: number;
}

export type IgnoreReason =
  | "mandate_not_armed"
  | "mandate_expired"
  | "sku_mismatch"
  | "price_above_target"
  | "attempt_in_flight"
  | "cooldown";

export type TriggerDecision =
  | { readonly kind: "ignore"; readonly reason: IgnoreReason }
  | {
      readonly kind: "trigger";
      /**
       * True only for a verified, anomaly-free price: the one case where an unattended charge may
       * follow. Otherwise the shopper is told (notify-and-confirm) and nothing is charged.
       */
      readonly unattendedEligible: boolean;
    };

/**
 * Does this price event start an attempt for this rule. Pure and deterministic. A plain
 * (unverified) price at or below target still notifies, but can never unlock a charge.
 */
export function evaluateTrigger(m: MandateView, s: PriceSignal, nowMs: number): TriggerDecision {
  if (m.status !== "ARMED") return { kind: "ignore", reason: "mandate_not_armed" };
  if (nowMs >= m.expiresAtMs) return { kind: "ignore", reason: "mandate_expired" };
  if (m.skuId !== s.skuId) return { kind: "ignore", reason: "sku_mismatch" };
  if (s.price > m.targetPrice) return { kind: "ignore", reason: "price_above_target" };
  // One attempt in flight per rule: an unresolved charge must be reconciled before any other attempt.
  if (m.hasOpenAttempt) return { kind: "ignore", reason: "attempt_in_flight" };
  if (m.lastAttemptAtMs !== null && nowMs - m.lastAttemptAtMs < AUTO_BUY_LIMITS.cooldownMs) {
    return { kind: "ignore", reason: "cooldown" };
  }
  return { kind: "trigger", unattendedEligible: s.verified && !s.anomaly };
}
