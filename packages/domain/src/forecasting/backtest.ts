import { horizonInterval, type DemandInterval } from "./interval";
import { FITTERS, type ModelId, type Values } from "./models";

export const BACKTEST_HORIZON_DAYS = 7;
export const BACKTEST_MIN_TRAIN_DAYS = 14;

export interface BacktestMetrics {
  /** Rolling origins with a fully observed test window. */
  readonly origins: number;
  /** Weighted absolute percentage error in basis points; null when the test windows held no demand. */
  readonly wapeBps: number | null;
  /** Mean pinball loss over q = 0.1, 0.5, 0.9, in thousandths of a unit per week. */
  readonly pinballMilli: number;
  /** Share of weeks whose actual fell inside [p10, p90], in basis points. Nominal is 8000. */
  readonly coverageBps: number;
  /** (forecast - actual) / actual in basis points; null when the test windows held no demand. Positive = over-forecast. */
  readonly biasBps: number | null;
}

const pinball = (q: number, actual: number, predicted: number): number =>
  actual >= predicted ? q * (actual - predicted) : (1 - q) * (predicted - actual);

const bps = (num: number, den: number): number => Math.round((num * 10_000) / den);

export function scoreIntervals(pairs: readonly { readonly actual: number; readonly interval: DemandInterval }[]): BacktestMetrics {
  let absErr = 0;
  let signed = 0;
  let total = 0;
  let loss = 0;
  let covered = 0;
  for (const { actual, interval } of pairs) {
    absErr += Math.abs(actual - interval.p50);
    signed += interval.p50 - actual;
    total += actual;
    loss += (pinball(0.1, actual, interval.p10) + pinball(0.5, actual, interval.p50) + pinball(0.9, actual, interval.p90)) / 3;
    if (actual >= interval.p10 && actual <= interval.p90) covered += 1;
  }
  const n = pairs.length;
  return {
    origins: n,
    wapeBps: total === 0 ? null : bps(absErr, total),
    pinballMilli: n === 0 ? 0 : Math.round((loss / n) * 1000),
    coverageBps: n === 0 ? 0 : bps(covered, n),
    biasBps: total === 0 ? null : bps(signed, total),
  };
}

/** Rolling-origin backtest of one model on weekly sums. Windows touching a censored or flagged day are skipped. */
export function backtest(model: ModelId, values: Values): BacktestMetrics {
  const fit = FITTERS[model];
  const pairs: { actual: number; interval: DemandInterval }[] = [];
  for (let o = BACKTEST_MIN_TRAIN_DAYS; o + BACKTEST_HORIZON_DAYS <= values.length; o += BACKTEST_HORIZON_DAYS) {
    let actual = 0;
    let complete = true;
    for (let i = o; i < o + BACKTEST_HORIZON_DAYS; i += 1) {
      const v = values[i];
      if (v === null || v === undefined) {
        complete = false;
        break;
      }
      actual += v;
    }
    if (!complete) continue;
    pairs.push({ actual, interval: horizonInterval(fit(values.slice(0, o)), BACKTEST_HORIZON_DAYS) });
  }
  return scoreIntervals(pairs);
}
