import { InvalidRewardsConfigError } from "./errors";

export const TIERS = ["bronze", "silver", "gold", "black"] as const;
export type Tier = (typeof TIERS)[number];

/** Spec 15.5 earn reasons. A reason is part of the idempotency key `(source_ref, kind)`. */
export const EARN_REASONS = [
  "purchase",
  "photo_review",
  "profile_completion",
  "fit_feedback",
  "referral",
  "streak",
  "challenge",
  "game",
] as const;
export type EarnReason = (typeof EARN_REASONS)[number];

export interface StreakMilestone {
  /** Consecutive Cairo calendar months with at least one closed, kept order. */
  readonly months: number;
  readonly coins: bigint;
}

/**
 * Versioned rewards configuration (admin editable, dual approved, audited). All money values are
 * integer piastres, all coin values are integer coins. 1 coin = `piastresPerCoin` piastres at
 * the moment of award (the rate is snapshotted on each coin event).
 *
 * Defaults are engineering proposals: purchase rate, review and tier numbers need product sign-off
 * (docs/specs/phase2/06 Build notes). Coins stay disabled in production until VR-P2-04.
 */
export interface RewardsConfig {
  readonly version: number;
  readonly piastresPerCoin: bigint;
  /** Coins earned on net merchandise, as basis points of its value in piastres (100 = 1%). */
  readonly purchaseBps: bigint;
  /** Plus entitlement `coins_plus_5pct`: multiplier on earned purchase coins, in bps (500 = +5%). */
  readonly plusBonusBps: bigint;
  readonly reviewBaseCoins: bigint;
  readonly reviewPhotoCoins: bigint;
  readonly reviewFitCoins: bigint;
  readonly profileCompletionCoins: bigint;
  readonly fitFeedbackCoins: bigint;
  /** Safety cap per single event (defense against a misconfigured rate). */
  readonly maxCoinsPerEvent: bigint;
  readonly expiryMonths: number;
  readonly expiringNoticeDays: number;
  /** 12-month net spend thresholds in piastres. Bronze is the floor (0). */
  readonly silverFrom: bigint;
  readonly goldFrom: bigint;
  readonly blackFrom: bigint;
  readonly tierDowngradeNoticeDays: number;
  readonly streakMilestones: readonly StreakMilestone[];
  /** Plays per game per Cairo day. The API rate limit (3/day) sits above this. */
  readonly dailyPlaysPerGame: number;
  /** Hours between publishing an odds version and it taking effect (spec: publish before effect). */
  readonly oddsPublishLeadHours: number;
  /** Hard ceiling of coins a game outcome may carry. */
  readonly maxGameCoins: bigint;
}

export const DEFAULT_REWARDS_CONFIG: RewardsConfig = {
  version: 1,
  piastresPerCoin: 1n,
  purchaseBps: 100n,
  plusBonusBps: 500n,
  reviewBaseCoins: 2_000n,
  reviewPhotoCoins: 3_000n,
  reviewFitCoins: 2_000n,
  profileCompletionCoins: 5_000n,
  fitFeedbackCoins: 1_000n,
  maxCoinsPerEvent: 1_000_000n,
  expiryMonths: 12,
  expiringNoticeDays: 30,
  silverFrom: 500_000n,
  goldFrom: 2_000_000n,
  blackFrom: 5_000_000n,
  tierDowngradeNoticeDays: 30,
  streakMilestones: [
    { months: 3, coins: 5_000n },
    { months: 6, coins: 15_000n },
    { months: 12, coins: 40_000n },
  ],
  dailyPlaysPerGame: 1,
  oddsPublishLeadHours: 24,
  maxGameCoins: 50_000n,
};

export function validateRewardsConfig(c: RewardsConfig): RewardsConfig {
  const bad = (m: string): never => {
    throw new InvalidRewardsConfigError(m);
  };
  if (!Number.isInteger(c.version) || c.version < 1) bad("version must be a positive integer");
  if (c.piastresPerCoin < 1n) bad("piastresPerCoin must be at least 1");
  for (const [k, v] of [
    ["purchaseBps", c.purchaseBps],
    ["plusBonusBps", c.plusBonusBps],
  ] as const) {
    if (v < 0n || v > 10_000n) bad(`${k} must be within 0..10000`);
  }
  for (const [k, v] of [
    ["reviewBaseCoins", c.reviewBaseCoins],
    ["reviewPhotoCoins", c.reviewPhotoCoins],
    ["reviewFitCoins", c.reviewFitCoins],
    ["profileCompletionCoins", c.profileCompletionCoins],
    ["fitFeedbackCoins", c.fitFeedbackCoins],
  ] as const) {
    if (v < 0n) bad(`${k} must not be negative`);
  }
  if (c.maxCoinsPerEvent < 1n) bad("maxCoinsPerEvent must be positive");
  if (c.reviewBaseCoins + c.reviewPhotoCoins + c.reviewFitCoins > c.maxCoinsPerEvent) bad("review coins exceed the per-event cap");
  if (!Number.isInteger(c.expiryMonths) || c.expiryMonths < 1 || c.expiryMonths > 36) bad("expiryMonths must be 1..36");
  if (!Number.isInteger(c.expiringNoticeDays) || c.expiringNoticeDays < 1) bad("expiringNoticeDays must be positive");
  if (!(c.silverFrom > 0n && c.goldFrom > c.silverFrom && c.blackFrom > c.goldFrom)) bad("tier thresholds must be strictly increasing and positive");
  if (!Number.isInteger(c.tierDowngradeNoticeDays) || c.tierDowngradeNoticeDays < 1) bad("tierDowngradeNoticeDays must be positive");
  let prev = 0;
  for (const m of c.streakMilestones) {
    if (!Number.isInteger(m.months) || m.months <= prev) bad("streak milestones must be strictly increasing");
    if (m.coins <= 0n || m.coins > c.maxCoinsPerEvent) bad("streak milestone coins out of range");
    prev = m.months;
  }
  if (!Number.isInteger(c.dailyPlaysPerGame) || c.dailyPlaysPerGame < 1 || c.dailyPlaysPerGame > 3) bad("dailyPlaysPerGame must be 1..3");
  if (!Number.isInteger(c.oddsPublishLeadHours) || c.oddsPublishLeadHours < 0) bad("oddsPublishLeadHours must not be negative");
  if (c.maxGameCoins < 1n || c.maxGameCoins > c.maxCoinsPerEvent) bad("maxGameCoins out of range");
  return c;
}
