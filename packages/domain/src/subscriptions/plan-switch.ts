import { SubscriptionRuleError } from "./errors";
import type { PlusInterval } from "./types";

/**
 * Plan switching by price as well as interval (Phase 3). The Phase 2 `switchKind` only compares
 * intervals, which cannot tell family (1,200/year) from yearly (800/year). The money rules stay
 * those of the existing calculator: an upgrade is immediate, the credit is the unused whole days
 * of what was paid (`prorationCredit`), the charge is never negative (`upgradeCharge`); a
 * downgrade waits for the period end and moves no money.
 */
export type PlanSwitch = "same" | "upgrade_now" | "downgrade_at_period_end";

export interface PlanTerms {
  readonly code: string;
  readonly interval: PlusInterval;
  readonly priceMinor: bigint;
}

/** Longer interval, or the same interval at a higher price, is an upgrade; everything else waits. */
export function planSwitch(from: PlanTerms, to: PlanTerms): PlanSwitch {
  if (from.priceMinor <= 0n || to.priceMinor <= 0n) throw new SubscriptionRuleError("prices must be positive");
  if (from.code === to.code) return "same";
  if (from.interval === to.interval) {
    if (to.priceMinor === from.priceMinor) return "same";
    return to.priceMinor > from.priceMinor ? "upgrade_now" : "downgrade_at_period_end";
  }
  return from.interval === "month" ? "upgrade_now" : "downgrade_at_period_end";
}
