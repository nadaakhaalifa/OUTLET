/**
 * Single seam to the pure rewards domain. `packages/domain/src/index.ts` is owned by the integrator
 * and will re-export it as `rewards`; until then the module is imported by its package subpath.
 * Aliases and re-exports only; no behaviour (ADR-0018 vocabulary rule).
 */
import { rewards } from "@outlet/domain";
export import DEFAULT_REWARDS_CONFIG = rewards.DEFAULT_REWARDS_CONFIG;
export import EARN_REASONS = rewards.EARN_REASONS;
export import GAMES = rewards.GAMES;
export import OUTCOME_KINDS = rewards.OUTCOME_KINDS;
export import PPM = rewards.PPM;
export import TIERS = rewards.TIERS;
export import InvalidOddsTableError = rewards.InvalidOddsTableError;
export import InvalidRewardsConfigError = rewards.InvalidRewardsConfigError;
export import RewardsDomainError = rewards.RewardsDomainError;
export import cairoDayKey = rewards.cairoDayKey;
export import cairoMonthKey = rewards.cairoMonthKey;
export import clawbackCoins = rewards.clawbackCoins;
export import coinClawbackEntry = rewards.coinClawbackEntry;
export import coinExpiryMs = rewards.coinExpiryMs;
export import coinGrantEntry = rewards.coinGrantEntry;
export import drawMessage = rewards.drawMessage;
export import evaluateTier = rewards.evaluateTier;
export import expiringSoon = rewards.expiringSoon;
export import milestoneAt = rewards.milestoneAt;
export import netAgainstDebt = rewards.netAgainstDebt;
export import netSpend12m = rewards.netSpend12m;
export import nextCairoDayStartMs = rewards.nextCairoDayStartMs;
export import nextTierProgress = rewards.nextTierProgress;
export import oddsDisclosure = rewards.oddsDisclosure;
export import planCoinExpiry = rewards.planCoinExpiry;
export import purchaseCoins = rewards.purchaseCoins;
export import reviewCoins = rewards.reviewCoins;
export import rollFromBlocks = rewards.rollFromBlocks;
export import selectOutcome = rewards.selectOutcome;
export import streakState = rewards.streakState;
export import tierFor = rewards.tierFor;
export import validateOddsTable = rewards.validateOddsTable;
export import validateRewardsConfig = rewards.validateRewardsConfig;
export type CoinLot = rewards.CoinLot;
export type CoinSub = rewards.CoinSub;
export type EarnReason = rewards.EarnReason;
export type Game = rewards.Game;
export type OddsDisclosureLine = rewards.OddsDisclosureLine;
export type OddsOutcome = rewards.OddsOutcome;
export type OddsTable = rewards.OddsTable;
export type OutcomeKind = rewards.OutcomeKind;
export type RewardsConfig = rewards.RewardsConfig;
export type SpendPoint = rewards.SpendPoint;
export type StreakMilestone = rewards.StreakMilestone;
export type StreakState = rewards.StreakState;
export type Tier = rewards.Tier;
export type TierChange = rewards.TierChange;
export type TierState = rewards.TierState;
