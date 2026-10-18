import { K_ANONYMITY_MIN } from "../seller-analytics/kanon";

/**
 * Release gate for geographic cells (spec 19.1: aggregated demographics need k-anonymity >= 50).
 * Daily distinct-shopper counts cannot be summed (the same shopper may buy on several days), so
 * the released support is the LARGEST single-day count: a true lower bound on the distinct shoppers
 * in the window. Conservative by construction: it can only under-release.
 */
export function shopperSupportLowerBound(dailyDistinctShoppers: readonly number[]): number {
  let max = 0;
  for (const n of dailyDistinctShoppers) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError("distinct shoppers must be a non-negative integer");
    if (n > max) max = n;
  }
  return max;
}

export const FORECAST_K_MIN = K_ANONYMITY_MIN;

export function geographyCellReleasable(supportLowerBound: number): boolean {
  return supportLowerBound >= FORECAST_K_MIN;
}
