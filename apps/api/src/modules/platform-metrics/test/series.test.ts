import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bucketContaining, nextBucket, previousSlots, snapWindow, InvalidWindowError, GRAIN_MAX_POINTS, type Bucket, type Grain } from "../domain/buckets";
import { bankersDiv, bps, buildSeriesWire, computePoints, deltaOf, floorDiv, totalOf, wireValue, type HourlyRow, type MetricDef } from "../domain/series";
import { cairoLocalToUtc } from "@outlet/domain";

const H = 3_600_000;
const utc = (s: string): number => Date.parse(s);
const at = (y: number, m: number, d: number, h = 12): number => cairoLocalToUtc(y, m, d, h, 0);

describe("Cairo buckets: pinned DST fixtures (guard against outdated ICU)", () => {
  it.each([
    ["2026-04-24", 23],
    ["2026-10-29", 25],
    ["2027-04-30", 23],
    ["2027-10-28", 25],
    ["2026-07-01", 24],
    ["2026-01-15", 24],
  ])("day %s has %i real hours", (date, hours) => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const b = bucketContaining("day", at(y, m, d, 13));
    expect(b.hours).toBe(hours);
    expect(b.label).toBe(date);
  });
  it("the spring day starts at local 01:00 (22:00 UTC of the previous calendar day)", () => {
    const b = bucketContaining("day", utc("2026-04-24T10:00:00Z"));
    expect(b.startMs).toBe(utc("2026-04-23T22:00:00Z"));
    expect(b.offsetMin).toBe(180);
  });
  it("autumn: local 23:00 occurs twice, fold 0 at UTC+3 then fold 1 at UTC+2", () => {
    const first = bucketContaining("hour", utc("2026-10-29T20:00:00Z"));
    const second = bucketContaining("hour", utc("2026-10-29T21:00:00Z"));
    expect([first.label, first.fold, first.offsetMin]).toEqual(["2026-10-29T23", 0, 180]);
    expect([second.label, second.fold, second.offsetMin]).toEqual(["2026-10-29T23", 1, 120]);
  });
  it("weeks start on Saturday (ADR-0047 Proposed default)", () => {
    const b = bucketContaining("week", at(2026, 10, 14)); // Wednesday
    expect(b.localDate).toBe("2026-10-10");
    expect(Math.round((b.endMs - b.startMs) / H)).toBe(b.hours);
    expect(bucketContaining("week", b.startMs).startMs).toBe(b.startMs);
    expect(bucketContaining("week", b.endMs - 1).startMs).toBe(b.startMs);
  });
});

describe("bucket properties", () => {
  const ms = fc.integer({ min: utc("2025-01-01T00:00:00Z"), max: utc("2028-01-01T00:00:00Z") });
  it.each(["hour", "day", "week", "month"] as const)("every instant is in exactly one %s bucket, contiguous with its neighbours", (grain) => {
    fc.assert(
      fc.property(ms, (t) => {
        const b = bucketContaining(grain, t);
        expect(b.startMs <= t && t < b.endMs).toBe(true);
        expect(nextBucket(grain, b).startMs).toBe(b.endMs);
        expect(bucketContaining(grain, b.endMs - 1).startMs).toBe(b.startMs);
        expect(bucketContaining(grain, b.startMs).endMs).toBe(b.endMs);
      }),
      { numRuns: 1000 },
    );
  });
  it("day hours are always 23, 24 or 25", () => {
    fc.assert(fc.property(ms, (t) => [23, 24, 25].includes(bucketContaining("day", t).hours)), { numRuns: 1000 });
  });
  it("a year has 8,760 or 8,784 hour buckets and the day buckets tile it", () => {
    for (const y of [2025, 2026, 2027]) {
      const from = at(y, 1, 1, 0);
      const to = at(y + 1, 1, 1, 0);
      const hours = Math.round((to - from) / H);
      expect([8760, 8784]).toContain(hours);
      let t = from;
      let sum = 0;
      while (t < to) {
        const d = bucketContaining("day", t);
        sum += d.hours;
        t = d.endMs;
      }
      expect(sum).toBe(hours);
    }
  });
});

describe("snapWindow and previous period", () => {
  const now = utc("2026-10-20T12:00:00Z");
  it("snaps outward and clamps to the end of the current bucket", () => {
    const b = snapWindow("day", utc("2026-10-10T05:00:00Z"), utc("2026-12-31T00:00:00Z"), now);
    expect((b[0] as Bucket).label).toBe("2026-10-10");
    expect((b[b.length - 1] as Bucket).label).toBe("2026-10-20");
  });
  it("from >= to, or a window wholly in the future, is invalid_window; too many points is window_too_large", () => {
    expect(() => snapWindow("day", 10, 10, now)).toThrow(InvalidWindowError);
    expect(() => snapWindow("day", now + 5 * 86_400_000, now + 6 * 86_400_000, now)).toThrow(InvalidWindowError);
    expect(() => snapWindow("hour", now - 8 * 86_400_000, now, now)).toThrowError("window_too_large");
    expect(snapWindow("hour", now - 7 * 86_400_000, now, now).length).toBeLessThanOrEqual(GRAIN_MAX_POINTS.hour);
    expect(() => snapWindow("day", now - 400 * 86_400_000, now, now)).toThrowError("window_too_large");
  });
  it.each(["day", "week", "month"] as const)("%s: previous has the same bucket count, immediately before, aligned by index", (grain) => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 0, max: 700 }), (n, back) => {
        const end = now - back * 86_400_000;
        let start = bucketContaining(grain, end);
        for (let i = 1; i < n; i++) start = bucketContaining(grain, start.startMs - 1);
        const cur = snapWindow(grain, start.startMs, end, end + 1);
        const prev = previousSlots(grain, cur);
        expect(prev).toHaveLength(cur.length);
        expect((prev[prev.length - 1]?.bucket as Bucket).endMs).toBe((cur[0] as Bucket).startMs);
        for (let i = 1; i < prev.length; i++) expect((prev[i]?.bucket as Bucket).startMs).toBe((prev[i - 1]?.bucket as Bucket).endMs);
      }),
      { numRuns: 200 },
    );
  });
  it("a 23-hour day aligns by index with a 24-hour day", () => {
    const cur = snapWindow("day", at(2026, 4, 24, 3), at(2026, 4, 25, 0), utc("2026-05-01T00:00:00Z"));
    const prev = previousSlots("day", cur);
    expect((cur[0] as Bucket).hours).toBe(23);
    expect((prev[0]?.bucket as Bucket).hours).toBe(24);
    expect((prev[0]?.bucket as Bucket).label).toBe("2026-04-23");
  });
  it("hour grain: no_bucket appears only at DST slots (spring hour absent, fold 1 against a normal day)", () => {
    const grain: Grain = "hour";
    // Window = the spring day 2026-04-24 (23 hours) against the normal day before it: every current hour has a counterpart, none is a gap.
    const spring = snapWindow(grain, at(2026, 4, 24, 1), at(2026, 4, 25, 0), utc("2026-05-01T00:00:00Z"));
    expect(previousSlots(grain, spring).filter((s) => s.bucket === null)).toHaveLength(0);
    // Window = the autumn day (25 hours): the fold-1 hour has no counterpart on the normal day before it.
    const autumn = snapWindow(grain, at(2026, 10, 29, 0), at(2026, 10, 30, 0), utc("2026-11-05T00:00:00Z"));
    const gaps = previousSlots(grain, autumn).flatMap((s, i) => (s.bucket === null ? [autumn[i] as Bucket] : []));
    expect(gaps.map((b) => [b.label, b.fold])).toEqual([["2026-10-29T23", 1]]);
    // Window = the day after the spring day: its previous day is the 23-hour day, whose local hour 00 does not exist.
    const after = snapWindow(grain, at(2026, 4, 25, 0), at(2026, 4, 26, 0), utc("2026-05-01T00:00:00Z"));
    const gaps2 = previousSlots(grain, after).flatMap((s, i) => (s.bucket === null ? [(after[i] as Bucket).label] : []));
    expect(gaps2).toEqual(["2026-04-25T00"]);
  });
});

describe("series arithmetic", () => {
  const sumDef = (calc: MetricDef["calc"], unit: MetricDef["unit"] = "piastres", additive = true): MetricDef => ({ id: "t.x", unit, additive, basis: "rollup", notes: [], calc });
  const now = utc("2026-10-20T12:00:00Z");

  it("day sums equal hour sums equal the window total (additive)", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 10n ** 15n }), { minLength: 24 * 6, maxLength: 24 * 6 }), (vals) => {
        const start = at(2026, 10, 1, 0);
        const rows: HourlyRow[] = vals.map((v, i) => ({ hourUtcMs: start + i * H, value: v, held: 0n }));
        const days = snapWindow("day", start, start + 6 * 86_400_000, now);
        const hours = snapWindow("hour", start, start + 144 * H, now + 40 * 86_400_000);
        const def = sumDef({ kind: "sum", metric: "m" });
        const dp = computePoints(def, days, () => rows, now + 40 * 86_400_000);
        const hp = computePoints(def, hours, () => rows, now + 40 * 86_400_000);
        const all = vals.reduce((s, v) => s + v, 0n);
        // days may cover slightly more than the 144 hours around DST; rows only exist for 144
        expect(totalOf(def, dp)).toBe(all);
        expect(totalOf(def, hp)).toBe(all);
      }),
      { numRuns: 200 },
    );
  });
  it("money above 2^53 stays exact (bigint end to end)", () => {
    const big = 2n ** 60n + 1n;
    const rows: HourlyRow[] = [{ hourUtcMs: at(2026, 10, 1, 5), value: big, held: 0n }];
    const days = snapWindow("day", at(2026, 10, 1, 0), at(2026, 10, 2, 0), now);
    const def = sumDef({ kind: "sum", metric: "m" });
    const p = computePoints(def, days, () => rows, now);
    expect(wireValue("piastres", totalOf(def, p))).toBe(big.toString());
  });
  it("the current bucket is partial; a held hour makes the bucket held with v null (never zero)", () => {
    const todayStart = bucketContaining("day", now).startMs;
    const rows: HourlyRow[] = [{ hourUtcMs: todayStart + H, value: 5n, held: 0n }, { hourUtcMs: at(2026, 10, 19, 3), value: 7n, held: 4n }];
    const b = snapWindow("day", at(2026, 10, 19, 0), now, now);
    const p = computePoints(sumDef({ kind: "sum", metric: "m" }), b, () => rows, now);
    expect(p.map((x) => [x.state, x.v])).toEqual([["held", null], ["partial", 5n]]);
    expect(totalOf(sumDef({ kind: "sum", metric: "m" }), p)).toBe(5n);
  });
  it("AOV uses banker's rounding at one point; ties go to even; zero orders is null/ok", () => {
    expect(bankersDiv(5n, 2n)).toBe(2n);
    expect(bankersDiv(7n, 2n)).toBe(4n);
    expect(bankersDiv(9n, 4n)).toBe(2n);
    expect(bankersDiv(11n, 4n)).toBe(3n);
    const rows = (m: string): HourlyRow[] => [{ hourUtcMs: at(2026, 10, 1, 5), value: m === "g" ? 10n : m === "o" ? 4n : 0n, held: 0n }];
    const def = sumDef({ kind: "aov", num: "g", den: "o" }, "piastres", false);
    const days = snapWindow("day", at(2026, 10, 1, 0), at(2026, 10, 3, 0), now);
    const p = computePoints(def, days, rows, now);
    expect(p.map((x) => [x.v, x.state])).toEqual([[2n, "ok"], [null, "ok"]]);
    expect(totalOf(def, p)).toBe(2n);
  });
  it("bps floors and delta_bps floors toward minus infinity", () => {
    expect(bps(1n, 3n)).toBe(3333n);
    expect(floorDiv(-1n, 3n)).toBe(-1n);
    expect(deltaOf(90n, 100n)).toEqual({ delta: -10n, deltaBps: -1000n });
    expect(deltaOf(1n, 3n).deltaBps).toBe(-6667n);
    expect(deltaOf(5n, 0n).deltaBps).toBeNull();
    expect(deltaOf(null, 5n)).toEqual({ delta: null, deltaBps: null });
  });
  it("non-additive totals are computed over window components, never a sum of points", () => {
    const rows = (m: string): HourlyRow[] => [
      { hourUtcMs: at(2026, 10, 1, 5), value: m === "p" ? 1n : 10n, held: 0n },
      { hourUtcMs: at(2026, 10, 2, 5), value: m === "p" ? 9n : 10n, held: 0n },
    ];
    const def = sumDef({ kind: "bps", num: "p", den: "v" }, "bps", false);
    const p = computePoints(def, snapWindow("day", at(2026, 10, 1, 0), at(2026, 10, 3, 0), now), rows, now);
    expect(p.map((x) => x.v)).toEqual([1000n, 9000n]);
    expect(totalOf(def, p)).toBe(5000n);
  });
  it("wire document: no_bucket previous slots, compare none, window and totals", () => {
    const def = sumDef({ kind: "sum", metric: "m" }, "count");
    const rows: HourlyRow[] = [{ hourUtcMs: at(2026, 10, 19, 5), value: 3n, held: 0n }];
    const cur = snapWindow("day", at(2026, 10, 19, 0), at(2026, 10, 20, 0), now);
    const slots = previousSlots("day", cur).map((s) => s.bucket);
    const w = buildSeriesWire({
      def, grain: "day", buckets: cur, requested: { fromMs: at(2026, 10, 19, 5), toMs: at(2026, 10, 20, 5) },
      current: computePoints(def, cur, () => rows, now), previous: { slots, points: computePoints(def, slots, () => rows, now) }, asOfMs: null,
    });
    expect(w.series.map((s) => s.key)).toEqual(["current", "previous"]);
    expect(w.totals).toEqual({ current: 3, previous: 0, delta: 3, delta_bps: null });
    expect(w.as_of).toBeNull();
    expect(w.window.tz).toBe("Africa/Cairo");
    expect(w.suppressed).toEqual({ k: 50, primary: 0, complementary: 0, memo: 0, whole_series: false });
  });
});
