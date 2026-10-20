/**
 * Baseline demand models over a daily series with missing days (`null`). Each fit returns the daily
 * mean for step k = 1, 2, ... after the end of the training data and the one-step residual root mean
 * square. Day position modulo 7 is the weekly season. Options compared: (a) seasonal-naive, (b)
 * additive Holt-Winters without trend (level + weekly seasonal indices; the grid is tiny and
 * deterministic), (c) Croston-SBA for intermittent lot-level demand. All are cheap, explainable and
 * need no features, so none can touch budget or measurement data.
 */
export const SEASON = 7;
export type ModelId = "seasonal_naive" | "ets_seasonal" | "croston_sba";
export const MODEL_VERSION = "baseline-v1";

export interface ModelFit {
  readonly meanAt: (step: number) => number;
  /** Root mean square of one-step in-sample errors; 0 when there are none. */
  readonly sigma: number;
}

export type Values = readonly (number | null)[];

const rms = (errors: readonly number[]): number =>
  errors.length === 0 ? 0 : Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);

function observedMean(values: Values): number {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v !== null) {
      sum += v;
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

export function fitSeasonalNaive(values: Values): ModelFit {
  const n = values.length;
  const fallback = observedMean(values);
  const errors: number[] = [];
  for (let t = SEASON; t < n; t += 1) {
    const a = values[t];
    const b = values[t - SEASON];
    if (a !== null && a !== undefined && b !== null && b !== undefined) errors.push(a - b);
  }
  return {
    sigma: rms(errors),
    meanAt: (step) => {
      // Latest observed value at the same weekly position at or before the end of training.
      let idx = n - 1 + step;
      idx -= SEASON * Math.ceil(step / SEASON);
      while (idx >= 0) {
        const v = values[idx];
        if (v !== null && v !== undefined) return v;
        idx -= SEASON;
      }
      return fallback;
    },
  };
}

const ETS_ALPHAS = [0.1, 0.2, 0.3, 0.5] as const;
const ETS_GAMMAS = [0.1, 0.3] as const;

interface EtsRun {
  readonly sse: number;
  readonly errors: readonly number[];
  readonly level: number;
  readonly seasonal: readonly number[];
}

function runEts(values: Values, alpha: number, gamma: number): EtsRun {
  const n = values.length;
  const first = values.slice(0, Math.min(SEASON, n));
  const level0 = observedMean(first);
  const seasonal: number[] = [];
  for (let j = 0; j < SEASON; j += 1) {
    const v = first[j];
    seasonal.push(v === null || v === undefined ? 0 : v - level0);
  }
  let level = level0;
  const errors: number[] = [];
  let sse = 0;
  for (let t = 0; t < n; t += 1) {
    const x = values[t];
    if (x === null || x === undefined) continue;
    const j = t % SEASON;
    const s = seasonal[j] ?? 0;
    if (t >= SEASON) {
      const e = x - (level + s);
      errors.push(e);
      sse += e * e;
    }
    const nextLevel = alpha * (x - s) + (1 - alpha) * level;
    seasonal[j] = gamma * (x - nextLevel) + (1 - gamma) * s;
    level = nextLevel;
  }
  return { sse, errors, level, seasonal };
}

export function fitEtsSeasonal(values: Values): ModelFit {
  let best: EtsRun | null = null;
  for (const a of ETS_ALPHAS) {
    for (const g of ETS_GAMMAS) {
      const run = runEts(values, a, g);
      if (best === null || run.sse < best.sse) best = run;
    }
  }
  const fit = best ?? runEts(values, 0.2, 0.1);
  const n = values.length;
  return {
    sigma: rms(fit.errors),
    meanAt: (step) => Math.max(0, fit.level + (fit.seasonal[(n - 1 + step) % SEASON] ?? 0)),
  };
}

const CROSTON_ALPHA = 0.1;

export function fitCrostonSba(values: Values): ModelFit {
  let z: number | null = null;
  let p: number | null = null;
  let since = 1;
  const errors: number[] = [];
  const rate = (): number => (z === null || p === null ? 0 : (1 - CROSTON_ALPHA / 2) * (z / p));
  for (let t = 0; t < values.length; t += 1) {
    const x = values[t];
    if (x === null || x === undefined) continue;
    if (t >= 1) errors.push(x - rate());
    if (x > 0) {
      if (z === null || p === null) {
        z = x;
        p = since;
      } else {
        z = z + CROSTON_ALPHA * (x - z);
        p = p + CROSTON_ALPHA * (since - p);
      }
      since = 1;
    } else {
      since += 1;
    }
  }
  const mean = rate();
  return { sigma: rms(errors), meanAt: () => mean };
}

export const FITTERS: Readonly<Record<ModelId, (v: Values) => ModelFit>> = {
  seasonal_naive: fitSeasonalNaive,
  ets_seasonal: fitEtsSeasonal,
  croston_sba: fitCrostonSba,
};
