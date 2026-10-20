import { cairoMonthKey, nextCairoMonthStartMs, nextMonthKey, previousMonthKey } from "./cairo";
import type { RewardsConfig, StreakMilestone } from "./config";

export interface StreakState {
  readonly length: number;
  /** First Cairo month of the current run (YYYY-MM), null when length is 0. Part of milestone idempotency keys. */
  readonly startMonthKey: string | null;
  /** True when the current Cairo month already has a kept order. */
  readonly currentMonthDone: boolean;
  /** Real reset instant: when the streak is lost if nothing is bought, or null when length is 0. */
  readonly resetsAtMs: number | null;
}

/**
 * A streak counts consecutive Cairo months with at least one closed, kept order. It stays alive
 * through the current month when the previous month had an order, so there is never an artificial
 * deadline: the reset instant is the real end of the month in which the streak would break.
 */
export function streakState(monthsWithOrders: ReadonlySet<string>, nowMs: number): StreakState {
  const current = cairoMonthKey(nowMs);
  const done = monthsWithOrders.has(current);
  let cursor = done ? current : previousMonthKey(current);
  let length = 0;
  let start: string | null = null;
  while (monthsWithOrders.has(cursor)) {
    length += 1;
    start = cursor;
    cursor = previousMonthKey(cursor);
  }
  if (length === 0) return { length: 0, startMonthKey: null, currentMonthDone: done, resetsAtMs: null };
  // If this month is done the streak next breaks at the end of next month; otherwise at the end of this month.
  const resetsAtMs = done ? nextCairoMonthStartMs(nextCairoMonthStartMs(nowMs)) : nextCairoMonthStartMs(nowMs);
  return { length, startMonthKey: start, currentMonthDone: done, resetsAtMs };
}

/** The milestone reached exactly at `length`, if any. Each milestone pays once per streak run. */
export function milestoneAt(cfg: RewardsConfig, length: number): StreakMilestone | null {
  return cfg.streakMilestones.find((m) => m.months === length) ?? null;
}

export { nextMonthKey };
