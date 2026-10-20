/**
 * Referrals (spec 15.4). Pure domain: no I/O, no clock, no randomness. Money is integer piastres.
 * This module NEVER posts to the ledger or issues credit; it only decides and describes intents.
 */

export interface ReferralConfig {
  /** Friend discount on a first order, piastres (150 EGP). */
  readonly refereeDiscount: bigint;
  /** Minimum merchandise subtotal of the friend's first order, piastres (600 EGP). */
  readonly refereeMinOrder: bigint;
  /** Referrer reward, piastres (100 EGP), emitted as an intent only. */
  readonly referrerReward: bigint;
  /** Every Nth rewarded referral earns a Plus month intent. */
  readonly milestoneEvery: number;
  readonly milestonePlusMonths: number;
  /** Cap on rewarded referrals inside `rewardWindowMs`. */
  readonly maxRewardedPerWindow: number;
  readonly rewardWindowMs: number;
  /** A suspicious-link component strictly larger than this withholds the reward. */
  readonly clusterThreshold: number;
  readonly minAgeYears: number;
}

export const DEFAULT_REFERRAL_CONFIG: ReferralConfig = {
  refereeDiscount: 15_000n,
  refereeMinOrder: 60_000n,
  referrerReward: 10_000n,
  milestoneEvery: 10,
  milestonePlusMonths: 1,
  maxRewardedPerWindow: 50,
  rewardWindowMs: 365 * 24 * 60 * 60 * 1000,
  clusterThreshold: 3,
  minAgeYears: 18,
};

export const REFERRAL_STATUSES = ["attributed", "rewarded", "rejected"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const REJECT_REASONS = [
  "self_referral",
  "same_device",
  "not_new_user",
  "underage",
  "referee_unknown",
  "referrer_unknown",
  "referrer_suspended",
  "order_refunded",
  "order_below_minimum",
  "not_delivered",
  "cod_not_delivered",
  "payment_fingerprint_reuse",
  "referrer_no_delivered_order",
  "cluster_suspected",
  "cap_reached",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export class ReferralConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralConfigError";
  }
}

export class InvalidReferralTransitionError extends Error {
  constructor(
    readonly from: ReferralStatus,
    readonly to: ReferralStatus,
  ) {
    super(`invalid referral transition ${from} -> ${to}`);
    this.name = "InvalidReferralTransitionError";
  }
}

export function validateReferralConfig(c: ReferralConfig): ReferralConfig {
  const posBig = (v: bigint, n: string): void => {
    if (v <= 0n) throw new ReferralConfigError(`${n} must be positive`);
  };
  const posInt = (v: number, n: string): void => {
    if (!Number.isSafeInteger(v) || v <= 0) throw new ReferralConfigError(`${n} must be a positive integer`);
  };
  posBig(c.refereeDiscount, "refereeDiscount");
  posBig(c.refereeMinOrder, "refereeMinOrder");
  posBig(c.referrerReward, "referrerReward");
  if (c.refereeDiscount > c.refereeMinOrder) throw new ReferralConfigError("discount exceeds minimum order");
  posInt(c.milestoneEvery, "milestoneEvery");
  posInt(c.milestonePlusMonths, "milestonePlusMonths");
  posInt(c.maxRewardedPerWindow, "maxRewardedPerWindow");
  posInt(c.rewardWindowMs, "rewardWindowMs");
  posInt(c.clusterThreshold, "clusterThreshold");
  posInt(c.minAgeYears, "minAgeYears");
  return c;
}

const TRANSITIONS: Readonly<Record<ReferralStatus, readonly ReferralStatus[]>> = {
  attributed: ["rewarded", "rejected"],
  rewarded: [],
  rejected: [],
};

export function transitionReferral(from: ReferralStatus, to: ReferralStatus): ReferralStatus {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidReferralTransitionError(from, to);
  return to;
}
