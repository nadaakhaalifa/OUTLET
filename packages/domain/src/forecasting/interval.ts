import type { ModelFit } from "./models";

/** Nominal central interval: p10 to p90 (80%). z for the 90th percentile of a standard normal. */
export const NOMINAL_COVERAGE_BPS = 8000;
const Z90 = 1.2815515655446004;

/** An integer-unit prediction interval. There is deliberately no standalone point-estimate type. */
export interface DemandInterval {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
}

/**
 * Horizon-sum interval. Daily variance is the larger of the one-step residual variance and the
 * mean (counts are at least Poisson-dispersed, so an in-sample fit that happens to be perfect never
 * yields a zero-width interval). Errors are treated as independent across days. Rounding is explicit:
 * the lower bound is floored, the upper bound is ceiled, the median is rounded, so the interval is
 * never narrower than the model states, and p10 <= p50 <= p90 always.
 */
export function horizonInterval(fit: ModelFit, horizonDays: number): DemandInterval {
  if (!Number.isInteger(horizonDays) || horizonDays < 1) throw new RangeError("horizonDays must be a positive integer");
  let mean = 0;
  let variance = 0;
  for (let k = 1; k <= horizonDays; k += 1) {
    const m = Math.max(0, fit.meanAt(k));
    mean += m;
    variance += Math.max(fit.sigma * fit.sigma, m);
  }
  const sd = Math.sqrt(variance);
  const p50 = Math.round(mean);
  const p10 = Math.min(p50, Math.max(0, Math.floor(mean - Z90 * sd)));
  const p90 = Math.max(p50, Math.ceil(mean + Z90 * sd));
  return { p10, p50, p90 };
}
