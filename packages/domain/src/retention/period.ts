/** Retention periods and cutoffs (spec B1). Pure, UTC calendar arithmetic. */
export type RetentionUnit = "hours" | "days" | "months" | "years";
export interface RetentionPeriod {
  readonly value: number;
  readonly unit: RetentionUnit;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function subtractMonths(nowMs: number, months: number): number {
  const d = new Date(nowMs);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() - months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** Instant at or before which a row has reached the end of the period. Rows strictly OLDER than the cutoff are eligible. */
export function retentionCutoffMs(nowMs: number, p: RetentionPeriod): number {
  if (!Number.isInteger(p.value) || p.value <= 0) throw new RangeError("retention period must be a positive integer");
  switch (p.unit) {
    case "hours":
      return nowMs - p.value * HOUR;
    case "days":
      return nowMs - p.value * DAY;
    case "months":
      return subtractMonths(nowMs, p.value);
    case "years":
      return subtractMonths(nowMs, p.value * 12);
  }
}

/** A row exactly at the cutoff is kept; one millisecond older is eligible. */
export function isPurgeEligible(rowAtMs: number, cutoffMs: number): boolean {
  return rowAtMs < cutoffMs;
}

/** Spec B1: tax-law period is "assume 5-7 years, VERIFY". Financial rules must never be shorter than the floor. */
export const FINANCIAL_FLOOR: RetentionPeriod = { value: 5, unit: "years" };

export class FinancialRetentionError extends Error {
  constructor(readonly ruleId: string) {
    super(`financial retention rule ${ruleId} is shorter than the ${FINANCIAL_FLOOR.value}-year legal floor`);
    this.name = "FinancialRetentionError";
  }
}

/**
 * Cutoff for a rule. For financial rules the result is never later than the floor cutoff, so a mis-tagged
 * short period in the inventory cannot cause a record inside the tax period to be purged. It throws instead.
 */
export function effectiveCutoffMs(nowMs: number, ruleId: string, p: RetentionPeriod, financial: boolean): number {
  const c = retentionCutoffMs(nowMs, p);
  if (!financial) return c;
  const floor = retentionCutoffMs(nowMs, FINANCIAL_FLOOR);
  if (c > floor) throw new FinancialRetentionError(ruleId);
  return c;
}
