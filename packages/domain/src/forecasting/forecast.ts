import { backtest, type BacktestMetrics } from "./backtest";
import { horizonInterval, NOMINAL_COVERAGE_BPS, type DemandInterval } from "./interval";
import { FITTERS, MODEL_VERSION, type ModelId } from "./models";
import { historyShortfall, type InsufficientReason, type PreparedSeries } from "./series";

export const HORIZONS = [7, 14, 28] as const;
export type HorizonDays = (typeof HORIZONS)[number];

export type ReasonCode =
  | "weekly_seasonality"
  | "intermittent_demand"
  | "stockout_days_excluded"
  | "promotion_days_excluded"
  | "baseline_served"
  | "model_beat_baseline"
  | "not_reconciled_partial_children"
  | "reconciled_to_parent";

export interface HorizonForecast extends DemandInterval {
  readonly horizonDays: HorizonDays;
}

export interface ForecastOk {
  readonly status: "ok";
  readonly model: ModelId;
  readonly modelVersion: string;
  readonly horizons: readonly HorizonForecast[];
  /** Backtest of the model that is served. */
  readonly backtest: BacktestMetrics;
  /** Backtest of the seasonal-naive baseline it had to beat. */
  readonly baseline: BacktestMetrics;
  readonly nominalCoverageBps: number;
  readonly reasonCodes: readonly ReasonCode[];
  readonly comparableUnits: number;
  readonly observedDays: number;
}

export interface ForecastInsufficient {
  readonly status: "insufficient_history";
  readonly reason: InsufficientReason;
  readonly comparableUnits: number;
  readonly observedDays: number;
}

export type ForecastOutcome = ForecastOk | ForecastInsufficient;

/** Zero days among the usable days at or above this share make a series intermittent. */
export const INTERMITTENT_ZERO_SHARE = 0.5;

function intermittent(values: PreparedSeries["values"]): boolean {
  let zeros = 0;
  let n = 0;
  for (const v of values) {
    if (v === null) continue;
    n += 1;
    if (v === 0) zeros += 1;
  }
  return n > 0 && zeros / n >= INTERMITTENT_ZERO_SHARE;
}

/** A candidate replaces the baseline only if it is strictly better on WAPE and no worse on pinball loss. */
export function beatsBaseline(candidate: BacktestMetrics, baseline: BacktestMetrics): boolean {
  if (candidate.origins === 0 || baseline.origins === 0) return false;
  if (candidate.wapeBps === null || baseline.wapeBps === null) {
    return candidate.pinballMilli < baseline.pinballMilli;
  }
  return candidate.wapeBps < baseline.wapeBps && candidate.pinballMilli <= baseline.pinballMilli;
}

/**
 * Forecast one series. Fails closed: too little history, or no backtest window to validate
 * calibration on, yields `insufficient_history` and no numbers. Seasonal-naive is the mandatory
 * baseline; ETS (and Croston-SBA for intermittent series) is served only when it beats it on the
 * rolling-origin backtest.
 */
export function forecastSeries(series: PreparedSeries): ForecastOutcome {
  const shortfall = historyShortfall(series);
  const base = { comparableUnits: series.comparableUnits, observedDays: series.observedDays };
  if (shortfall !== null) return { status: "insufficient_history", reason: shortfall, ...base };

  const baselineMetrics = backtest("seasonal_naive", series.values);
  if (baselineMetrics.origins === 0) {
    return { status: "insufficient_history", reason: "no_valid_backtest", ...base };
  }
  const isIntermittent = intermittent(series.values);
  const candidates: readonly ModelId[] = isIntermittent ? ["croston_sba", "ets_seasonal"] : ["ets_seasonal"];
  let served: ModelId = "seasonal_naive";
  let servedMetrics = baselineMetrics;
  for (const c of candidates) {
    const m = backtest(c, series.values);
    if (!beatsBaseline(m, baselineMetrics)) continue;
    if (served === "seasonal_naive" || beatsBaseline(m, servedMetrics)) {
      served = c;
      servedMetrics = m;
    }
  }
  const fit = FITTERS[served](series.values);
  const reasonCodes: ReasonCode[] = [];
  reasonCodes.push(isIntermittent ? "intermittent_demand" : "weekly_seasonality");
  if (series.censoredDays > 0) reasonCodes.push("stockout_days_excluded");
  if (series.flaggedDays > 0) reasonCodes.push("promotion_days_excluded");
  reasonCodes.push(served === "seasonal_naive" ? "baseline_served" : "model_beat_baseline");
  return {
    status: "ok",
    model: served,
    modelVersion: MODEL_VERSION,
    horizons: HORIZONS.map((h) => ({ horizonDays: h, ...horizonInterval(fit, h) })),
    backtest: servedMetrics,
    baseline: baselineMetrics,
    nominalCoverageBps: NOMINAL_COVERAGE_BPS,
    reasonCodes,
    comparableUnits: series.comparableUnits,
    observedDays: series.observedDays,
  };
}
