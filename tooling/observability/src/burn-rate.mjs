// Burn-rate arithmetic for multi-window, multi-burn-rate SLO alerting.
// Source: Google SRE Workbook, "Alerting on SLOs". Pure functions, no I/O.
//
//   budget            = 1 - objective
//   burn rate         = (fraction of budget consumed) * period / alert window
//   error threshold   = burn rate * budget
//   time to exhaustion at a constant burn rate = period / burn rate

const UNIT_HOURS = { m: 1 / 60, h: 1, d: 24 };

/** Parse a duration such as "5m", "6h" or "28d" into hours. Only m, h, d are accepted. */
export function windowToHours(window) {
  const match = /^([1-9][0-9]*)([mhd])$/.exec(window);
  if (!match) {
    throw new RangeError(`Invalid window "${window}": expected <int>m, <int>h or <int>d`);
  }
  return Number(match[1]) * UNIT_HOURS[match[2]];
}

/** Trim binary floating point noise (14.4 * 0.005 = 0.07200000000000001) for stable output. */
export function clean(value) {
  return Number(value.toPrecision(12));
}

export function errorBudget(objective) {
  if (!(objective >= 0 && objective < 1)) {
    throw new RangeError(`objective must be in [0, 1), got ${objective}`);
  }
  return clean(1 - objective);
}

export function burnRateFor({ budgetFraction, periodHours, windowHours }) {
  if (!(budgetFraction > 0 && budgetFraction <= 1)) {
    throw new RangeError(`budgetFraction must be in (0, 1], got ${budgetFraction}`);
  }
  if (!(periodHours > 0 && windowHours > 0 && windowHours <= periodHours)) {
    throw new RangeError('windows must be positive and the alert window must not exceed the period');
  }
  return clean((budgetFraction * periodHours) / windowHours);
}

export function budgetConsumed({ burnRate, periodHours, windowHours }) {
  return clean((burnRate * windowHours) / periodHours);
}

export function errorRateThreshold({ burnRate, objective }) {
  return clean(burnRate * errorBudget(objective));
}

export function hoursToExhaustion({ burnRate, periodHours }) {
  if (!(burnRate > 0)) throw new RangeError('burnRate must be positive');
  return clean(periodHours / burnRate);
}

/** The largest burn rate an SLO can ever show: every event bad, error ratio 1. */
export function maxBurnRate(objective) {
  return clean(1 / errorBudget(objective));
}

/**
 * Resolve the alert tiers for an SLO into concrete numbers.
 * An alert can only fire when its error-ratio threshold is below 1.
 */
export function resolveTiers({ objective, periodHours, tiers }) {
  return tiers.map((tier) => {
    const longHours = windowToHours(tier.long);
    const shortHours = windowToHours(tier.short);
    if (shortHours >= longHours) {
      throw new RangeError(`short window ${tier.short} must be shorter than long window ${tier.long}`);
    }
    const burnRate = burnRateFor({
      budgetFraction: tier.budgetFraction,
      periodHours,
      windowHours: longHours,
    });
    const threshold = errorRateThreshold({ burnRate, objective });
    return { ...tier, longHours, shortHours, burnRate, threshold };
  });
}
