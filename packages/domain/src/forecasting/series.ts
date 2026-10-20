import { isoDayToIndex } from "./calendar";

/** One stored day of net demand for a series (rows for the same day are merged by `prepareSeries`). */
export interface DemandDayInput {
  readonly day: string;
  /** Net units (gross minus returns attributed to the order day), never negative. */
  readonly unitsNet: number;
  /** Sales that day were limited by stock-out. The day carries no demand information (not zero demand). */
  readonly censored: boolean;
  /** A promotion or drop spike. Excluded from the base level. */
  readonly flagged: boolean;
}

/**
 * Dense daily series from the first stored day to the as-of day inclusive. `values[i]` is the net
 * units on day `startIndex + i`, or `null` when the day is not usable for learning (censored or
 * flagged). A day with no stored row is a genuine zero.
 */
export interface PreparedSeries {
  readonly startIndex: number;
  readonly values: readonly (number | null)[];
  readonly censoredDays: number;
  readonly flaggedDays: number;
  readonly observedDays: number;
  /** Units on usable days: the "comparable units" of the minimum-history rule. */
  readonly comparableUnits: number;
  readonly lastObservedIndex: number | null;
}

export function prepareSeries(rows: readonly DemandDayInput[], asOfDay: string): PreparedSeries {
  const asOf = isoDayToIndex(asOfDay);
  const byDay = new Map<number, { units: number; censored: boolean; flagged: boolean }>();
  for (const r of rows) {
    if (!Number.isInteger(r.unitsNet) || r.unitsNet < 0) throw new RangeError("unitsNet must be a non-negative integer");
    const i = isoDayToIndex(r.day);
    if (i > asOf) continue;
    const cur = byDay.get(i) ?? { units: 0, censored: false, flagged: false };
    byDay.set(i, { units: cur.units + r.unitsNet, censored: cur.censored || r.censored, flagged: cur.flagged || r.flagged });
  }
  if (byDay.size === 0) {
    return { startIndex: asOf, values: [], censoredDays: 0, flaggedDays: 0, observedDays: 0, comparableUnits: 0, lastObservedIndex: null };
  }
  const startIndex = Math.min(...byDay.keys());
  const values: (number | null)[] = [];
  let censoredDays = 0;
  let flaggedDays = 0;
  let observedDays = 0;
  let comparableUnits = 0;
  let lastObservedIndex: number | null = null;
  for (let i = startIndex; i <= asOf; i += 1) {
    const d = byDay.get(i);
    if (d === undefined) {
      values.push(0);
      observedDays += 1;
      lastObservedIndex = i;
    } else if (d.censored) {
      values.push(null);
      censoredDays += 1;
    } else if (d.flagged) {
      values.push(null);
      flaggedDays += 1;
    } else {
      values.push(d.units);
      observedDays += 1;
      comparableUnits += d.units;
      lastObservedIndex = i;
    }
  }
  return { startIndex, values, censoredDays, flaggedDays, observedDays, comparableUnits, lastObservedIndex };
}

/** Minimum-history rules. Below any of them no number is produced at all (fail closed). */
export const MIN_COMPARABLE_UNITS = 20;
export const MIN_OBSERVED_DAYS = 28;

export type InsufficientReason = "units_below_minimum" | "days_below_minimum" | "no_valid_backtest";

export function historyShortfall(s: PreparedSeries): InsufficientReason | null {
  if (s.comparableUnits < MIN_COMPARABLE_UNITS) return "units_below_minimum";
  if (s.observedDays < MIN_OBSERVED_DAYS) return "days_below_minimum";
  return null;
}
