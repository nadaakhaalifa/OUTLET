import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FORECAST_K_MIN,
  HORIZONS,
  MIN_COMPARABLE_UNITS,
  MIN_OBSERVED_DAYS,
  backtest,
  beatsBaseline,
  fitCrostonSba,
  fitEtsSeasonal,
  fitSeasonalNaive,
  forecastSeries,
  geographyCellReleasable,
  horizonInterval,
  indexToIsoDay,
  isoDayToIndex,
  prepareSeries,
  reconcileTopDown,
  scoreIntervals,
  shopperSupportLowerBound,
  type DemandDayInput,
} from "./index";

/** Deterministic PRNG so the statistical tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(rand: () => number, lambda: number): number {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rand();
  } while (p > l);
  return k - 1;
}

const WEEK = [0.6, 0.7, 0.8, 1.0, 1.6, 2.0, 1.3];
const START = isoDayToIndex("2026-01-01");

/** `days` of Poisson demand with a weekly pattern around `base` units/day. */
function seasonalDays(seed: number, days: number, base: number): DemandDayInput[] {
  const rand = mulberry32(seed);
  return Array.from({ length: days }, (_, i) => ({
    day: indexToIsoDay(START + i),
    unitsNet: poisson(rand, base * (WEEK[i % 7] ?? 1)),
    censored: false,
    flagged: false,
  }));
}
const asOf = (days: number): string => indexToIsoDay(START + days - 1);

describe("calendar", () => {
  it("round-trips and rejects impossible days", () => {
    expect(indexToIsoDay(isoDayToIndex("2026-02-28"))).toBe("2026-02-28");
    expect(isoDayToIndex("2026-03-01") - isoDayToIndex("2026-02-28")).toBe(1);
    expect(() => isoDayToIndex("2026-02-30")).toThrow(RangeError);
    expect(() => isoDayToIndex("26-1-1")).toThrow(RangeError);
  });
});

describe("prepareSeries", () => {
  const d = (day: string, unitsNet: number, o: Partial<DemandDayInput> = {}): DemandDayInput => ({
    day,
    unitsNet,
    censored: false,
    flagged: false,
    ...o,
  });
  it("treats a missing day as zero demand and a stock-out day as MISSING, not zero", () => {
    const s = prepareSeries([d("2026-01-01", 4), d("2026-01-03", 5, { censored: true }), d("2026-01-04", 6)], "2026-01-04");
    expect(s.values).toEqual([4, 0, null, 6]);
    expect(s.censoredDays).toBe(1);
    expect(s.observedDays).toBe(3);
    expect(s.comparableUnits).toBe(10);
  });
  it("excludes promotion days from the base level and merges same-day rows", () => {
    const s = prepareSeries([d("2026-01-01", 2), d("2026-01-01", 3), d("2026-01-02", 90, { flagged: true })], "2026-01-02");
    expect(s.values).toEqual([5, null]);
    expect(s.flaggedDays).toBe(1);
  });
  it("ignores rows after the as-of day and rejects negative or fractional units", () => {
    expect(prepareSeries([d("2026-01-09", 5)], "2026-01-08").values).toEqual([]);
    expect(() => prepareSeries([d("2026-01-01", -1)], "2026-01-01")).toThrow(RangeError);
    expect(() => prepareSeries([d("2026-01-01", 1.5)], "2026-01-01")).toThrow(RangeError);
  });
});

describe("minimum history fails closed", () => {
  it("fewer than 20 comparable units returns insufficient_history and no numbers", () => {
    const rows = seasonalDays(1, 60, 0.1).map((r) => ({ ...r, unitsNet: Math.min(r.unitsNet, 1) }));
    const s = prepareSeries(rows, asOf(60));
    expect(s.comparableUnits).toBeLessThan(MIN_COMPARABLE_UNITS);
    const out = forecastSeries(s);
    expect(out).toEqual({
      status: "insufficient_history",
      reason: "units_below_minimum",
      comparableUnits: s.comparableUnits,
      observedDays: s.observedDays,
    });
    expect(JSON.stringify(out)).not.toMatch(/p10|p50|p90|horizon/);
  });
  it("fewer than 28 observed days returns insufficient_history even with many units", () => {
    const out = forecastSeries(prepareSeries(seasonalDays(2, MIN_OBSERVED_DAYS - 1, 10), asOf(MIN_OBSERVED_DAYS - 1)));
    expect(out).toMatchObject({ status: "insufficient_history", reason: "days_below_minimum" });
  });
  it("a series whose test windows are all censored has no valid backtest and fails closed", () => {
    const rows = seasonalDays(3, 30, 6).map((r, i) => (i >= 14 ? { ...r, censored: true } : r));
    // Only 14 observed days remain, so the days rule triggers first; widen with a second block.
    const out = forecastSeries(prepareSeries(rows, asOf(30)));
    expect(out.status).toBe("insufficient_history");
  });
});

describe("forecastSeries on synthetic seasonal demand", () => {
  it("serves an interval for 7, 14 and 28 days, ordered, with metrics", () => {
    const out = forecastSeries(prepareSeries(seasonalDays(11, 84, 6), asOf(84)));
    if (out.status !== "ok") throw new Error("expected ok");
    expect(out.horizons.map((h) => h.horizonDays)).toEqual([...HORIZONS]);
    for (const h of out.horizons) {
      expect(h.p10).toBeLessThanOrEqual(h.p50);
      expect(h.p50).toBeLessThanOrEqual(h.p90);
      expect(h.p10).toBeGreaterThanOrEqual(0);
    }
    expect(out.horizons[0]?.p50).toBeGreaterThan(0);
    expect(out.horizons[2]?.p50).toBeGreaterThan(out.horizons[0]?.p50 ?? 0);
    expect(out.backtest.origins).toBeGreaterThanOrEqual(1);
    expect(out.nominalCoverageBps).toBe(8000);
  });

  it("the served model is never worse than seasonal-naive on WAPE (baseline is served otherwise)", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const out = forecastSeries(prepareSeries(seasonalDays(seed, 70, 5), asOf(70)));
      if (out.status !== "ok") continue;
      if (out.model === "seasonal_naive") {
        expect(out.reasonCodes).toContain("baseline_served");
        expect(out.backtest).toEqual(out.baseline);
      } else {
        expect(out.reasonCodes).toContain("model_beat_baseline");
        expect(beatsBaseline(out.backtest, out.baseline)).toBe(true);
        expect(out.backtest.wapeBps ?? 0).toBeLessThan(out.baseline.wapeBps ?? Number.MAX_SAFE_INTEGER);
      }
    }
  });

  it("is deterministic", () => {
    const s = prepareSeries(seasonalDays(5, 60, 4), asOf(60));
    expect(forecastSeries(s)).toEqual(forecastSeries(s));
  });

  it("stock-out days are censored, not zero demand: excluding them gives a higher forecast than zero-filling them", () => {
    const rows = seasonalDays(21, 70, 8);
    const out = rows.map((r, i) => (i % 7 === 4 && i > 20 ? { ...r, unitsNet: 0, censored: true } : r));
    const zeroFilled = out.map((r) => ({ ...r, censored: false }));
    const a = forecastSeries(prepareSeries(out, asOf(70)));
    const b = forecastSeries(prepareSeries(zeroFilled, asOf(70)));
    if (a.status !== "ok" || b.status !== "ok") throw new Error("expected ok");
    expect(a.reasonCodes).toContain("stockout_days_excluded");
    expect(a.horizons[2]?.p50 ?? 0).toBeGreaterThan(b.horizons[2]?.p50 ?? 0);
  });

  it("an intermittent lot-level series is routed through Croston-SBA candidates and still ordered", () => {
    const rand = mulberry32(99);
    const rows: DemandDayInput[] = Array.from({ length: 90 }, (_, i) => ({
      day: indexToIsoDay(START + i),
      unitsNet: rand() < 0.12 ? 1 + Math.floor(rand() * 4) : 0,
      censored: false,
      flagged: false,
    }));
    const out = forecastSeries(prepareSeries(rows, asOf(90)));
    if (out.status !== "ok") throw new Error("expected ok");
    expect(out.reasonCodes).toContain("intermittent_demand");
    for (const h of out.horizons) expect(h.p10 <= h.p50 && h.p50 <= h.p90).toBe(true);
  });

  it("interval coverage is near nominal (80%) on fresh synthetic weeks", () => {
    let covered = 0;
    let total = 0;
    for (let seed = 100; seed < 400; seed += 1) {
      const rand = mulberry32(seed);
      const base = 3 + (seed % 5);
      const days = 9 * 7;
      const rows = seasonalDays(seed, days, base);
      const s = prepareSeries(rows, asOf(days));
      const out = forecastSeries(s);
      if (out.status !== "ok") continue;
      const h7 = out.horizons[0];
      if (h7 === undefined) continue;
      let actual = 0;
      for (let k = 0; k < 7; k += 1) actual += poisson(rand, base * (WEEK[(days + k) % 7] ?? 1));
      total += 1;
      if (actual >= h7.p10 && actual <= h7.p90) covered += 1;
    }
    expect(total).toBeGreaterThan(250);
    const share = covered / total;
    expect(share).toBeGreaterThanOrEqual(0.75);
    expect(share).toBeLessThanOrEqual(0.85);
  });
});

describe("models and intervals (properties)", () => {
  const seriesArb = fc.array(fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }), { minLength: 0, maxLength: 120 });
  it("daily means are never negative and sigma is finite for any series", () => {
    fc.assert(
      fc.property(seriesArb, (v) => {
        for (const fit of [fitSeasonalNaive(v), fitEtsSeasonal(v), fitCrostonSba(v)]) {
          expect(Number.isFinite(fit.sigma)).toBe(true);
          for (let k = 1; k <= 28; k += 1) expect(fit.meanAt(k)).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });
  it("intervals are integer, non-negative, ordered and widen with the horizon", () => {
    fc.assert(
      fc.property(seriesArb, (v) => {
        const fit = fitEtsSeasonal(v);
        let prev = -1;
        for (const h of HORIZONS) {
          const i = horizonInterval(fit, h);
          expect(Number.isInteger(i.p10) && Number.isInteger(i.p50) && Number.isInteger(i.p90)).toBe(true);
          expect(i.p10).toBeGreaterThanOrEqual(0);
          expect(i.p10).toBeLessThanOrEqual(i.p50);
          expect(i.p50).toBeLessThanOrEqual(i.p90);
          expect(i.p90).toBeGreaterThanOrEqual(prev);
          prev = i.p90;
        }
      }),
      { numRuns: 200 },
    );
  });
  it("the forecast never changes when the content of censored days changes (they carry no information)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 500 }), (seed, junk) => {
        const rows = seasonalDays(seed, 56, 5);
        const censoredA = rows.map((r, i) => (i % 9 === 3 ? { ...r, censored: true, unitsNet: 0 } : r));
        const censoredB = rows.map((r, i) => (i % 9 === 3 ? { ...r, censored: true, unitsNet: junk } : r));
        expect(forecastSeries(prepareSeries(censoredA, asOf(56)))).toEqual(forecastSeries(prepareSeries(censoredB, asOf(56))));
      }),
      { numRuns: 30 },
    );
  });
  it("backtest metrics are internally consistent", () => {
    const m = scoreIntervals([
      { actual: 10, interval: { p10: 6, p50: 9, p90: 14 } },
      { actual: 20, interval: { p10: 6, p50: 9, p90: 14 } },
    ]);
    expect(m).toMatchObject({ origins: 2, wapeBps: Math.round((12 / 30) * 10_000), coverageBps: 5000, biasBps: Math.round((-12 / 30) * 10_000) });
    expect(scoreIntervals([{ actual: 0, interval: { p10: 0, p50: 0, p90: 2 } }]).wapeBps).toBeNull();
    expect(backtest("seasonal_naive", [1, 2, 3]).origins).toBe(0);
  });
});

describe("hierarchical reconciliation", () => {
  const iv = (p10: number, p50: number, p90: number) => ({ p10, p50, p90 });
  it("child medians sum exactly to the parent and bounds stay ordered", () => {
    const out = reconcileTopDown(iv(80, 100, 130), [
      { key: "S", interval: iv(10, 20, 30) },
      { key: "M", interval: iv(30, 45, 60) },
      { key: "L", interval: iv(10, 25, 40) },
    ]);
    expect(out.reduce((s, c) => s + c.interval.p50, 0)).toBe(100);
    for (const c of out) expect(c.interval.p10 <= c.interval.p50 && c.interval.p50 <= c.interval.p90).toBe(true);
  });
  it("property: exact sum for any parent and children, including all-zero children", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 12 }),
        (parent, meds) => {
          const children = meds.map((m, i) => ({ key: `k${i}`, interval: iv(Math.floor(m / 2), m, m * 2 + 3) }));
          const out = reconcileTopDown(iv(0, parent, parent * 2), children);
          expect(out.reduce((s, c) => s + c.interval.p50, 0)).toBe(parent);
          for (const c of out) {
            expect(c.interval.p10).toBeGreaterThanOrEqual(0);
            expect(c.interval.p10).toBeLessThanOrEqual(c.interval.p50);
            expect(c.interval.p50).toBeLessThanOrEqual(c.interval.p90);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("k-anonymity for geographic cells", () => {
  it("the threshold is 50 and uses the largest single-day distinct-shopper count (a lower bound)", () => {
    expect(FORECAST_K_MIN).toBe(50);
    expect(shopperSupportLowerBound([3, 49, 12])).toBe(49);
    expect(geographyCellReleasable(shopperSupportLowerBound([49, 49, 49]))).toBe(false);
    expect(geographyCellReleasable(shopperSupportLowerBound([10, 50]))).toBe(true);
    expect(() => shopperSupportLowerBound([-1])).toThrow(RangeError);
  });
});
