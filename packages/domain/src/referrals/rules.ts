import { detectSelfReferral, isClusterSuspicious, sharesPaymentFingerprint } from "./fraud";
import type { ReferralConfig, RejectReason } from "./types";

// ---- Attribution eligibility -------------------------------------------------------------------

export interface PartyProfile {
  readonly ageYears: number | null;
  /** True when the verified phone has never belonged to another account. */
  readonly phoneIsNew: boolean;
  readonly priorOrderCount: number;
  readonly deviceHashes: readonly string[];
  readonly active: boolean;
}

export type AttributionDecision = { readonly ok: true } | { readonly ok: false; readonly reason: RejectReason };

/**
 * Friend must be a new phone, new device, 18+ and have no prior order. Payment fingerprint is
 * only known at the first order and is checked at settlement. Failures are never shown to the
 * caller (silent), only recorded.
 */
export function evaluateAttribution(
  config: ReferralConfig,
  input: { readonly referrerId: string; readonly refereeId: string; readonly referrer: PartyProfile | null; readonly referee: PartyProfile | null },
): AttributionDecision {
  const { referrer, referee } = input;
  if (referee === null) return { ok: false, reason: "referee_unknown" };
  if (input.referrerId === input.refereeId) return { ok: false, reason: "self_referral" };
  if (referrer === null) return { ok: false, reason: "referrer_unknown" };
  if (!referrer.active) return { ok: false, reason: "referrer_suspended" };
  const self = detectSelfReferral({
    referrerId: input.referrerId,
    refereeId: input.refereeId,
    referrerDeviceHashes: referrer.deviceHashes,
    refereeDeviceHashes: referee.deviceHashes,
  });
  if (self !== null) return { ok: false, reason: self };
  if (referee.ageYears === null || referee.ageYears < config.minAgeYears) return { ok: false, reason: "underage" };
  if (!referee.phoneIsNew || referee.priorOrderCount > 0) return { ok: false, reason: "not_new_user" };
  return { ok: true };
}

// ---- Friend offer ------------------------------------------------------------------------------

/** Discount applied to the friend's first order; zero below the minimum. Never exceeds subtotal. */
export function refereeDiscountFor(config: ReferralConfig, subtotal: bigint): bigint {
  if (subtotal < config.refereeMinOrder) return 0n;
  return config.refereeDiscount < subtotal ? config.refereeDiscount : subtotal;
}

// ---- Settlement --------------------------------------------------------------------------------

export interface OrderClosure {
  readonly isFirstOrder: boolean;
  readonly merchandiseSubtotal: bigint;
  readonly refunded: boolean;
  readonly paymentMethod: "cod" | "prepaid";
  readonly deliveredAtMs: number | null;
  readonly closedAtMs: number;
  readonly paymentFingerprintHash: string | null;
}

export interface ReferrerContext {
  readonly hasDeliveredOrder: boolean;
  readonly active: boolean;
  readonly deviceHashes: readonly string[];
  readonly paymentFingerprintHashes: readonly string[];
  readonly rewardedInWindow: number;
  readonly rewardedTotal: number;
}

export type SettlementDecision =
  | { readonly kind: "ignore" }
  | { readonly kind: "reject"; readonly reason: RejectReason }
  | {
      readonly kind: "reward";
      readonly amount: bigint;
      /** Plus months to grant as an intent when this reward completes a milestone, else 0. */
      readonly plusMonths: number;
    };

/**
 * Decides the referrer reward once the friend's first order has CLOSED (return window over).
 * Check order is part of the contract and is covered by tests. `clusterSize` is the size of the
 * suspicious-link component containing the friend.
 */
export function decideSettlement(input: {
  readonly config: ReferralConfig;
  readonly referralStatus: "attributed" | "rewarded" | "rejected";
  readonly closure: OrderClosure;
  readonly referrer: ReferrerContext;
  readonly clusterSize: number;
}): SettlementDecision {
  const { config, closure, referrer } = input;
  if (input.referralStatus !== "attributed") return { kind: "ignore" };
  if (!closure.isFirstOrder) return { kind: "ignore" };
  if (closure.refunded) return { kind: "reject", reason: "order_refunded" };
  if (closure.merchandiseSubtotal < config.refereeMinOrder) return { kind: "reject", reason: "order_below_minimum" };
  if (closure.deliveredAtMs === null || closure.closedAtMs < closure.deliveredAtMs) {
    return { kind: "reject", reason: closure.paymentMethod === "cod" ? "cod_not_delivered" : "not_delivered" };
  }
  if (!referrer.active) return { kind: "reject", reason: "referrer_suspended" };
  if (sharesPaymentFingerprint(closure.paymentFingerprintHash, referrer.paymentFingerprintHashes)) {
    return { kind: "reject", reason: "payment_fingerprint_reuse" };
  }
  if (!referrer.hasDeliveredOrder) return { kind: "reject", reason: "referrer_no_delivered_order" };
  if (isClusterSuspicious(input.clusterSize, config.clusterThreshold)) return { kind: "reject", reason: "cluster_suspected" };
  if (referrer.rewardedInWindow >= config.maxRewardedPerWindow) return { kind: "reject", reason: "cap_reached" };
  const nth = referrer.rewardedTotal + 1;
  return {
    kind: "reward",
    amount: config.referrerReward,
    plusMonths: nth % config.milestoneEvery === 0 ? config.milestonePlusMonths : 0,
  };
}
