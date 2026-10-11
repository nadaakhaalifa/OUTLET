import { TIERS, type RewardsConfig, type Tier } from "./config";

export const tierRank = (t: Tier): number => TIERS.indexOf(t);

export interface SpendPoint {
  /** Signed piastres: closed order merchandise is positive, refunds are negative. */
  readonly amount: bigint;
  readonly atMs: number;
}

export const YEAR_MS = 365 * 86_400_000;

/** Net spend over the rolling 12 months: delivered minus refunds, never below zero. */
export function netSpend12m(points: readonly SpendPoint[], nowMs: number): bigint {
  const since = nowMs - YEAR_MS;
  let sum = 0n;
  for (const p of points) if (p.atMs > since && p.atMs <= nowMs) sum += p.amount;
  return sum > 0n ? sum : 0n;
}

export function tierFor(cfg: RewardsConfig, netSpend: bigint): Tier {
  if (netSpend >= cfg.blackFrom) return "black";
  if (netSpend >= cfg.goldFrom) return "gold";
  if (netSpend >= cfg.silverFrom) return "silver";
  return "bronze";
}

export interface TierState {
  readonly tier: Tier;
  readonly pendingTier: Tier | null;
  readonly pendingEffectiveAtMs: number | null;
}

export type TierChange =
  | { readonly kind: "none" }
  | { readonly kind: "upgraded"; readonly from: Tier; readonly to: Tier }
  | { readonly kind: "downgrade_announced"; readonly from: Tier; readonly to: Tier; readonly effectiveAtMs: number }
  | { readonly kind: "downgraded"; readonly from: Tier; readonly to: Tier }
  | { readonly kind: "downgrade_cancelled"; readonly tier: Tier };

/**
 * Monthly evaluation. An upgrade applies at once. A drop is announced with a notice period
 * (30 days) and applies only at the first evaluation after that date if spend is still lower.
 */
export function evaluateTier(
  cfg: RewardsConfig,
  state: TierState,
  netSpend: bigint,
  nowMs: number,
): { readonly state: TierState; readonly change: TierChange } {
  const target = tierFor(cfg, netSpend);
  const cur = state.tier;
  if (tierRank(target) > tierRank(cur)) {
    return { state: { tier: target, pendingTier: null, pendingEffectiveAtMs: null }, change: { kind: "upgraded", from: cur, to: target } };
  }
  if (tierRank(target) === tierRank(cur)) {
    if (state.pendingTier !== null) {
      return { state: { tier: cur, pendingTier: null, pendingEffectiveAtMs: null }, change: { kind: "downgrade_cancelled", tier: cur } };
    }
    return { state, change: { kind: "none" } };
  }
  // target is lower
  if (state.pendingTier !== null && state.pendingEffectiveAtMs !== null && state.pendingEffectiveAtMs <= nowMs) {
    return { state: { tier: target, pendingTier: null, pendingEffectiveAtMs: null }, change: { kind: "downgraded", from: cur, to: target } };
  }
  if (state.pendingTier !== null) {
    // keep the announced date; the pending tier follows the current target if it moved further
    return { state: { ...state, pendingTier: target }, change: { kind: "none" } };
  }
  const effectiveAtMs = nowMs + cfg.tierDowngradeNoticeDays * 86_400_000;
  return {
    state: { tier: cur, pendingTier: target, pendingEffectiveAtMs: effectiveAtMs },
    change: { kind: "downgrade_announced", from: cur, to: target, effectiveAtMs },
  };
}

/** Progress to the next tier: piastres still needed, null at the top. */
export function nextTierProgress(cfg: RewardsConfig, netSpend: bigint): { next: Tier; remaining: bigint } | null {
  const tier = tierFor(cfg, netSpend);
  const next = TIERS[tierRank(tier) + 1];
  if (next === undefined) return null;
  const threshold = next === "silver" ? cfg.silverFrom : next === "gold" ? cfg.goldFrom : cfg.blackFrom;
  return { next, remaining: threshold - netSpend };
}
