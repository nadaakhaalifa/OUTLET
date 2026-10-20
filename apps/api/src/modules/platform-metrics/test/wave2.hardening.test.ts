import { cairoLocalToUtc } from "@outlet/domain";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  GRAIN_MAX_POINTS,
  InvalidWindowError,
  bucketContaining,
  nextBucket,
  previousSlots,
  snapWindow,
  type Bucket,
  type Grain,
} from "../domain/buckets";
import { ADMIN_METRICS } from "../domain/registry";
import { bankersDiv, bps, computePoints, deltaOf, floorDiv, totalOf, type HourlyRow, type MetricDef } from "../domain/series";
import { adminRole, bearer, createHarness, NOW, subject, type Harness } from "./harness";

const H = 3_600_000;
const utc = (s: string): number => Date.parse(s);
const iso = (s: string): string => encodeURIComponent(s);

const cairoWeekday = (ms: number): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short" }).format(new Date(ms));
const cairoYmdHm = (ms: number): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

describe("Cairo bucketing across DST (property tests)", () => {
  const dstWindows = [
    ["spring 2026", utc("2026-04-15T00:00:00Z"), utc("2026-05-05T00:00:00Z")],
    ["autumn 2026", utc("2026-10-20T00:00:00Z"), utc("2026-11-08T00:00:00Z")],
  ] as const;

  it.each(dstWindows)("%s: every instant lands in exactly one bucket per grain, buckets are contiguous and non-empty", (_n, lo, hi) => {
    for (const grain of ["hour", "day", "week", "month"] as Grain[]) {
      fc.assert(
        fc.property(fc.integer({ min: lo, max: hi }), (t) => {
          const b = bucketContaining(grain, t);
          expect(b.startMs <= t && t < b.endMs).toBe(true);
          expect(b.endMs).toBeGreaterThan(b.startMs);
          const n = nextBucket(grain, b);
          expect(n.startMs).toBe(b.endMs);
          expect(bucketContaining(grain, b.startMs).startMs).toBe(b.startMs);
          expect(bucketContaining(grain, b.endMs - 1).startMs).toBe(b.startMs);
        }),
        { numRuns: 300 },
      );
    }
  });

  it("2026-04 spring: the day of the jump is 23h, starts local 01:00, hour label 2026-04-24T00 never exists", () => {
    const day = bucketContaining("day", utc("2026-04-24T12:00:00Z"));
    expect(day.hours).toBe(23);
    expect(day.label).toBe("2026-04-24");
    const labels = new Set<string>();
    for (let t = day.startMs; t < day.endMs; t += H) labels.add(bucketContaining("hour", t).label);
    expect(labels.size).toBe(23);
    expect(labels.has("2026-04-24T00")).toBe(false);
    // neighbours are normal
    expect(bucketContaining("day", day.startMs - 1).hours).toBe(24);
    expect(bucketContaining("day", day.endMs).hours).toBe(24);
  });

  it("2026-10-29/30 autumn: Oct 29 is 25h, Oct 30 is 24h, the ambiguous 23:00 yields two distinct hour buckets (fold 0 then 1)", () => {
    const d29 = bucketContaining("day", utc("2026-10-29T12:00:00Z"));
    const d30 = bucketContaining("day", utc("2026-10-30T12:00:00Z"));
    expect([d29.hours, d29.label, d30.hours, d30.label]).toEqual([25, "2026-10-29", 24, "2026-10-30"]);
    expect(d29.endMs).toBe(d30.startMs);
    const hours: Bucket[] = [];
    for (let t = d29.startMs; t < d29.endMs; t += H) hours.push(bucketContaining("hour", t));
    const amb = hours.filter((b) => b.label === "2026-10-29T23");
    expect(amb).toHaveLength(2);
    expect(amb.map((b) => b.fold)).toEqual([0, 1]);
    expect(amb.map((b) => b.offsetMin)).toEqual([180, 120]);
    expect(amb[1]!.startMs - amb[0]!.startMs).toBe(H);
    // (label, fold) is unique across the day
    expect(new Set(hours.map((b) => `${b.label}|${b.fold}`)).size).toBe(25);
    // no other hour is folded
    expect(hours.filter((b) => b.fold === 1)).toHaveLength(1);
  });

  it("hour buckets in a window across the autumn change are 1h wide, sorted and strictly contiguous", () => {
    const got = snapWindow("hour", utc("2026-10-29T00:00:00Z"), utc("2026-10-31T00:00:00Z"), utc("2026-11-01T00:00:00Z"));
    for (let i = 1; i < got.length; i++) {
      expect(got[i]!.startMs).toBe(got[i - 1]!.endMs);
      expect(got[i]!.hours).toBe(1);
    }
    const labels = got.map((b) => `${b.label}|${b.fold}`);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("weeks start on Saturday local midnight, are 167/168/169 h, and tile across both DST changes", () => {
    fc.assert(
      fc.property(fc.integer({ min: utc("2026-01-01T00:00:00Z"), max: utc("2027-12-31T00:00:00Z") }), (t) => {
        const w = bucketContaining("week", t);
        expect(cairoWeekday(w.startMs)).toBe("Sat");
        expect(cairoYmdHm(w.startMs).endsWith("00:00") || cairoYmdHm(w.startMs).endsWith("24:00")).toBe(true);
        expect([167, 168, 169]).toContain(w.hours);
        expect(nextBucket("week", w).startMs).toBe(w.endMs);
        expect(cairoWeekday(w.endMs)).toBe("Sat");
      }),
      { numRuns: 400 },
    );
    const spring = bucketContaining("week", utc("2026-04-24T12:00:00Z"));
    const autumn = bucketContaining("week", utc("2026-10-29T12:00:00Z"));
    expect(spring.hours).toBe(167);
    expect(autumn.hours).toBe(169);
  });

  it("a week and the days inside it agree: the week's hours equal the sum of its day buckets' hours", () => {
    fc.assert(
      fc.property(fc.integer({ min: utc("2026-01-01T00:00:00Z"), max: utc("2027-12-31T00:00:00Z") }), (t) => {
        const w = bucketContaining("week", t);
        let sum = 0;
        let d = bucketContaining("day", w.startMs);
        expect(d.startMs).toBe(w.startMs);
        while (d.startMs < w.endMs) {
          sum += d.hours;
          d = nextBucket("day", d);
        }
        expect(d.startMs).toBe(w.endMs);
        expect(sum).toBe(w.hours);
      }),
      { numRuns: 300 },
    );
  });

  it("month boundaries: starts at local midnight of the 1st, month hours equal the sum of its days, Dec->Jan and leap February work", () => {
    fc.assert(
      fc.property(fc.integer({ min: utc("2025-06-01T00:00:00Z"), max: utc("2029-03-01T00:00:00Z") }), (t) => {
        const m = bucketContaining("month", t);
        expect(m.localDate.endsWith("-01")).toBe(true);
        expect(m.label).toBe(m.localDate.slice(0, 7));
        let sum = 0;
        let d = bucketContaining("day", m.startMs);
        expect(d.startMs).toBe(m.startMs);
        while (d.startMs < m.endMs) {
          sum += d.hours;
          d = nextBucket("day", d);
        }
        expect(d.startMs).toBe(m.endMs);
        expect(sum).toBe(m.hours);
      }),
      { numRuns: 300 },
    );
    const dec = bucketContaining("month", cairoLocalToUtc(2026, 12, 31, 23, 30));
    expect(dec.label).toBe("2026-12");
    expect(nextBucket("month", dec).label).toBe("2027-01");
    expect(bucketContaining("month", cairoLocalToUtc(2028, 2, 15, 12, 0)).hours).toBe(29 * 24);
    expect(bucketContaining("month", cairoLocalToUtc(2026, 2, 15, 12, 0)).hours).toBe(28 * 24);
    // the month holding the spring jump is one hour short, the month holding the autumn jump one hour long
    expect(bucketContaining("month", utc("2026-04-10T00:00:00Z")).hours).toBe(30 * 24 - 1);
    expect(bucketContaining("month", utc("2026-10-10T00:00:00Z")).hours).toBe(31 * 24 + 1);
  });

  it("an instant in the last second of a Cairo day belongs to that day, one ms later to the next (UTC midnight is NOT a boundary)", () => {
    const d = bucketContaining("day", utc("2026-07-01T20:59:59.999Z")); // 23:59:59.999 at UTC+3
    expect(d.label).toBe("2026-07-01");
    expect(bucketContaining("day", utc("2026-07-01T21:00:00.000Z")).label).toBe("2026-07-02");
    expect(bucketContaining("day", utc("2026-07-01T22:30:00Z")).label).toBe("2026-07-02");
  });
});

describe("previous-period alignment", () => {
  it.each(["day", "week", "month"] as const)("%s: previous slots are contiguous, same length, end exactly where current starts, no nulls", (grain) => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 14 }), fc.integer({ min: 0, max: 400 }), (n, back) => {
        const now = utc("2026-10-16T12:00:00Z");
        let b = bucketContaining(grain, now - back * 86_400_000);
        const cur: Bucket[] = [b];
        for (let i = 1; i < n; i++) cur.push((b = nextBucket(grain, b)));
        const prev = previousSlots(grain, cur).map((s) => s.bucket);
        expect(prev).toHaveLength(cur.length);
        expect(prev.every((p) => p !== null)).toBe(true);
        const ps = prev as Bucket[];
        for (let i = 1; i < ps.length; i++) expect(ps[i]!.startMs).toBe(ps[i - 1]!.endMs);
        expect(ps[ps.length - 1]!.endMs).toBe(cur[0]!.startMs);
      }),
      { numRuns: 200 },
    );
  });

  it("hour grain across the autumn change: previous of a 25h day is the same local day-slot count earlier, only fold 1 can be null", () => {
    const cur = snapWindow("hour", utc("2026-10-28T21:00:00Z"), utc("2026-10-29T21:00:00Z"), utc("2026-11-02T00:00:00Z"));
    const slots = previousSlots("hour", cur);
    expect(slots).toHaveLength(cur.length);
    cur.forEach((c, i) => {
      if (slots[i]!.bucket === null) expect(c.fold).toBe(1);
    });
  });

  it("hour grain across the spring change: the slot aligned to the skipped hour is null, others are real", () => {
    const cur = snapWindow("hour", utc("2026-04-24T22:00:00Z"), utc("2026-04-25T22:00:00Z"), utc("2026-05-02T00:00:00Z"));
    const slots = previousSlots("hour", cur);
    const nulls = slots.filter((s) => s.bucket === null).length;
    // current is a normal day, previous local day is the 23h day: exactly one null
    expect(nulls).toBe(1);
  });

  it("over HTTP compare=previous_period returns the same number of points as current and the previous series ends where current starts", async () => {
    h = await createHarness();
    const fin = h.add(subject(60, [adminRole("finance")]));
    const r = await h.http().get(`/v1/admin/metrics/platform.orders.placed?from=${iso("2026-10-10T00:00:00Z")}&to=${iso("2026-10-14T00:00:00Z")}&grain=day`).set(bearer(fin));
    expect(r.status).toBe(200);
    const [cur, prev] = r.body.series;
    expect(prev.points).toHaveLength(cur.points.length);
    expect(prev.to).toBe(cur.from);
  });
});

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("integer-only arithmetic", () => {
  const big = fc.bigInt({ min: 0n, max: 10n ** 18n });

  it("bankersDiv: result is the nearest integer, ties go to even, never off by more than half", () => {
    fc.assert(
      fc.property(big, fc.bigInt({ min: 1n, max: 10n ** 9n }), (n, d) => {
        const q = bankersDiv(n, d);
        const err2 = (n - q * d) * 2n;
        const abs = err2 < 0n ? -err2 : err2;
        expect(abs <= d).toBe(true);
        if (abs === d) expect(q % 2n).toBe(0n);
      }),
      { numRuns: 1000 },
    );
  });

  it("bankersDiv: pinned half cases and invalid input throws RangeError (no silent NaN/float)", () => {
    expect([bankersDiv(1n, 2n), bankersDiv(3n, 2n), bankersDiv(5n, 2n), bankersDiv(7n, 2n), bankersDiv(25n, 10n), bankersDiv(35n, 10n)]).toEqual([0n, 2n, 2n, 4n, 2n, 4n]);
    expect(() => bankersDiv(1n, 0n)).toThrow(RangeError);
    expect(() => bankersDiv(-1n, 2n)).toThrow(RangeError);
  });

  it("floorDiv and bps are exact for negatives and huge values", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), (a, b) => {
        const q = floorDiv(a, b);
        expect(q * b <= a && a < (q + 1n) * b).toBe(true);
      }),
      { numRuns: 500 },
    );
    expect(bps(1n, 3n)).toBe(3333n);
    expect(deltaOf(90n, 100n)).toEqual({ delta: -10n, deltaBps: -1000n });
    expect(deltaOf(1n, 0n)).toEqual({ delta: 1n, deltaBps: null });
  });

  it("ledger-style invariant: net = gmv - commission per bucket and in total, for random hourly rows (diff metric)", () => {
    const diffDef: MetricDef = { id: "t.net", unit: "piastres", additive: true, basis: "rollup", notes: [], calc: { kind: "diff", a: "gmv", b: "commission" } };
    const sumDef = (m: string): MetricDef => ({ id: `t.${m}`, unit: "piastres", additive: true, basis: "rollup", notes: [], calc: { kind: "sum", metric: m } });
    const buckets = snapWindow("day", utc("2026-10-25T00:00:00Z"), utc("2026-11-03T00:00:00Z"), utc("2026-11-10T00:00:00Z"));
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 9 * 24 }), fc.bigInt({ min: 1n, max: 10n ** 16n }), fc.bigInt({ min: 0n, max: 10n ** 15n })), { maxLength: 80 }),
        (rows) => {
          const gmv: HourlyRow[] = [];
          const com: HourlyRow[] = [];
          for (const [hr, g, c] of rows) {
            const at = buckets[0]!.startMs + hr * H;
            gmv.push({ hourUtcMs: at, value: g + c, held: 0n });
            com.push({ hourUtcMs: at, value: c, held: 0n });
          }
          const rowsOf = (m: string) => (m === "gmv" ? gmv : com);
          const now = utc("2026-11-10T00:00:00Z");
          const net = computePoints(diffDef, buckets, rowsOf, now);
          const g = computePoints(sumDef("gmv"), buckets, rowsOf, now);
          const c = computePoints(sumDef("commission"), buckets, rowsOf, now);
          net.forEach((p, i) => expect(p.v).toBe(g[i]!.v! - c[i]!.v!));
          expect(totalOf(diffDef, net)).toBe(totalOf(sumDef("gmv"), g)! - totalOf(sumDef("commission"), c)!);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("AOV total is bankersDiv over window components, not a mean of bucket AOVs (values above 2^53 stay exact)", () => {
    const aov = ADMIN_METRICS.find((m) => m.def.id === "platform.aov")!.def;
    const buckets = snapWindow("day", utc("2026-10-10T00:00:00Z"), utc("2026-10-12T00:00:00Z"), utc("2026-11-10T00:00:00Z"));
    const t0 = buckets[0]!.startMs + 5 * H;
    const t1 = buckets[1]!.startMs + 5 * H;
    const gmv = 9_007_199_254_740_993n * 3n; // > 2^53, odd
    const rows: Record<string, HourlyRow[]> = {
      gmv_purchased_minor: [{ hourUtcMs: t0, value: gmv, held: 0n }, { hourUtcMs: t1, value: 1n, held: 0n }],
      orders_purchased: [{ hourUtcMs: t0, value: 3n, held: 0n }, { hourUtcMs: t1, value: 4n, held: 0n }],
    };
    const pts = computePoints(aov, buckets, (m) => rows[m] ?? [], utc("2026-11-10T00:00:00Z"));
    expect(pts[0]!.v).toBe(9_007_199_254_740_993n);
    expect(pts[1]!.v).toBe(bankersDiv(1n, 4n));
    expect(totalOf(aov, pts)).toBe(bankersDiv(gmv + 1n, 7n));
  });

  it("HTTP: piastres above 2^53 are decimal strings that round-trip exactly; counts are JSON integers", async () => {
    h = await createHarness();
    const fin = h.add(subject(61, [adminRole("finance")]));
    const exact = 9_007_199_254_740_993n; // 2^53 + 1
    h.rollups.set("gmv_purchased_minor", utc("2026-10-19T09:00:00Z"), exact);
    h.rollups.set("orders_purchased", utc("2026-10-19T09:00:00Z"), 7n);
    const q = `from=${iso("2026-10-19T00:00:00Z")}&to=${iso("2026-10-20T00:00:00Z")}&grain=day&compare=none`;
    const g = await h.http().get(`/v1/admin/metrics/platform.gmv.purchased?${q}`).set(bearer(fin));
    expect(typeof g.body.totals.current).toBe("string");
    expect(BigInt(g.body.totals.current)).toBe(exact);
    const o = await h.http().get(`/v1/admin/metrics/platform.orders.purchased?${q}`).set(bearer(fin));
    expect(Number.isInteger(o.body.totals.current)).toBe(true);
    for (const p of g.body.series[0].points) expect(p.v === null || /^-?\d+$/.test(p.v)).toBe(true);
  });
});

describe("held bucket exclusion", () => {
  it("a held bucket is excluded from the total (never counted as zero or as its value) and the total equals the sum of released points", async () => {
    h = await createHarness();
    const ops = h.add(subject(62, [adminRole("ops")]));
    h.rollups.set("orders_purchased", utc("2026-10-17T09:00:00Z"), 10n);
    h.rollups.set("orders_purchased", utc("2026-10-18T09:00:00Z"), 1000n, 400n);
    h.rollups.set("orders_purchased", utc("2026-10-19T09:00:00Z"), 5n);
    const r = await h.http().get(`/v1/admin/metrics/platform.orders.purchased?from=${iso("2026-10-16T21:00:00Z")}&to=${iso("2026-10-19T21:00:00Z")}&grain=day&compare=none`).set(bearer(ops));
    const pts = r.body.series[0].points as { v: number | null; state: string }[];
    expect(pts.map((p) => p.state)).toEqual(["ok", "held", "ok"]);
    expect(pts[1]!.v).toBeNull();
    expect(r.body.totals.current).toBe(15);
    expect(JSON.stringify(r.body)).not.toContain("1000");
    expect(JSON.stringify(r.body)).not.toContain("400");
  });

  it("every point is held -> total is null, not 0", async () => {
    h = await createHarness();
    const ops = h.add(subject(63, [adminRole("ops")]));
    h.rollups.set("orders_purchased", utc("2026-10-19T09:00:00Z"), 9n, 9n);
    const r = await h.http().get(`/v1/admin/metrics/platform.orders.purchased?from=${iso("2026-10-18T21:00:00Z")}&to=${iso("2026-10-19T21:00:00Z")}&grain=day&compare=none`).set(bearer(ops));
    expect(r.body.totals.current).toBeNull();
  });

  it("held in ONE component of a ratio holds the AOV bucket and removes both components from the window AOV", async () => {
    h = await createHarness();
    const fin = h.add(subject(64, [adminRole("finance")]));
    h.rollups.set("gmv_purchased_minor", utc("2026-10-17T09:00:00Z"), 100n);
    h.rollups.set("orders_purchased", utc("2026-10-17T09:00:00Z"), 2n);
    h.rollups.set("gmv_purchased_minor", utc("2026-10-18T09:00:00Z"), 99_999n, 1n); // held comp
    h.rollups.set("orders_purchased", utc("2026-10-18T09:00:00Z"), 1n);
    const r = await h.http().get(`/v1/admin/metrics/platform.aov?from=${iso("2026-10-16T21:00:00Z")}&to=${iso("2026-10-18T21:00:00Z")}&grain=day&compare=none`).set(bearer(fin));
    expect(r.body.series[0].points.map((p: { state: string }) => p.state)).toEqual(["ok", "held"]);
    expect(r.body.totals.current).toBe("50");
  });

  it("held previous-period bucket is excluded from the previous total and from the delta", async () => {
    h = await createHarness();
    const ops = h.add(subject(65, [adminRole("ops")]));
    h.rollups.set("orders_purchased", utc("2026-10-16T09:00:00Z"), 50n, 50n); // previous day 1: held
    h.rollups.set("orders_purchased", utc("2026-10-17T09:00:00Z"), 20n); // previous day 2
    h.rollups.set("orders_purchased", utc("2026-10-18T09:00:00Z"), 30n);
    h.rollups.set("orders_purchased", utc("2026-10-19T09:00:00Z"), 30n);
    const r = await h.http().get(`/v1/admin/metrics/platform.orders.purchased?from=${iso("2026-10-17T21:00:00Z")}&to=${iso("2026-10-19T21:00:00Z")}&grain=day`).set(bearer(ops));
    expect(r.body.series[1].points.map((p: { state: string }) => p.state)).toEqual(["held", "ok"]);
    expect(r.body.totals.previous).toBe(20);
    expect(r.body.totals.current).toBe(60);
    expect(r.body.totals.delta).toBe(40);
  });
});

describe("ETag / 304 only after authorization", () => {
  const Q = `from=${iso("2026-10-18T00:00:00Z")}&to=${iso("2026-10-20T12:00:00Z")}&grain=day`;
  const ORDERS = `/v1/admin/metrics/platform.orders.purchased?${Q}`;
  const GMV = `/v1/admin/metrics/platform.gmv.purchased?${Q}`;

  it("a forbidden caller presenting a valid ETag gets the identical 403 as without it: no 304, no ETag header, no freshness read", async () => {
    h = await createHarness();
    const fin = h.add(subject(70, [adminRole("finance")]));
    const mk = h.add(subject(71, [adminRole("marketing")]));
    const etag = (await h.http().get(ORDERS).set(bearer(fin))).headers.etag as string;
    let freshness = 0;
    const orig = h.rollups.freshness.bind(h.rollups);
    h.rollups.freshness = async () => (freshness++, orig());
    const reads0 = h.rollups.reads;
    const plain = await h.http().get(ORDERS).set(bearer(mk));
    const withTag = await h.http().get(ORDERS).set(bearer(mk)).set("If-None-Match", etag);
    const wildcard = await h.http().get(ORDERS).set(bearer(mk)).set("If-None-Match", "*");
    for (const r of [plain, withTag, wildcard]) {
      expect(r.status).toBe(403);
      expect(r.headers.etag).toBeUndefined();
      expect(r.headers["cache-control"]).not.toMatch(/max-age=[1-9]/);
    }
    const strip = (b: Record<string, unknown>) => ({ ...b, request_id: undefined, instance: undefined });
    expect(strip(withTag.body)).toEqual(strip(plain.body));
    expect(strip(wildcard.body)).toEqual(strip(plain.body));
    expect(freshness).toBe(0);
    expect(h.rollups.reads).toBe(reads0);
  });

  it("an ops caller replaying a finance-only (money) ETag still gets 403, never 304", async () => {
    h = await createHarness();
    const fin = h.add(subject(72, [adminRole("finance")]));
    const ops = h.add(subject(73, [adminRole("ops")]));
    const etag = (await h.http().get(GMV).set(bearer(fin))).headers.etag as string;
    const r = await h.http().get(GMV).set(bearer(ops)).set("If-None-Match", etag);
    expect(r.status).toBe(403);
    expect(r.headers.etag).toBeUndefined();
  });

  it("unauthenticated and wrong-audience callers with a valid ETag get 401, not 304", async () => {
    h = await createHarness();
    const fin = h.add(subject(74, [adminRole("finance")]));
    const buyer = h.add(subject(75, [adminRole("finance")], { aud: "buyer_api" }));
    const etag = (await h.http().get(ORDERS).set(bearer(fin))).headers.etag as string;
    expect((await h.http().get(ORDERS).set("If-None-Match", etag)).status).toBe(401);
    expect((await h.http().get(ORDERS).set(bearer(buyer)).set("If-None-Match", etag)).status).toBe(401);
  });

  it("an authorized caller gets 304 with a matching tag, 200 with a stale tag; the tag depends on metric, window, grain, compare and epoch", async () => {
    h = await createHarness();
    const fin = h.add(subject(76, [adminRole("finance")]));
    const get = async (url: string, inm?: string) => {
      const rq = h.http().get(url).set(bearer(fin));
      return inm === undefined ? rq : rq.set("If-None-Match", inm);
    };
    const a = await get(ORDERS);
    const etag = a.headers.etag as string;
    expect((await get(ORDERS, etag)).status).toBe(304);
    expect((await get(ORDERS, `"deadbeef"`)).status).toBe(200);
    const variants = [
      `/v1/admin/metrics/platform.orders.placed?${Q}`,
      `${ORDERS}&compare=none`,
      ORDERS.replace("grain=day", "grain=week"),
      ORDERS.replace("2026-10-18", "2026-10-17"),
    ];
    for (const v of variants) expect((await get(v)).headers.etag).not.toBe(etag);
    h.rollups.epoch += 1;
    expect((await get(ORDERS, etag)).status).toBe(200);
  });

  it("the ETag is the same for two different finance users (no per-user timing/identity channel) and 304 has no body", async () => {
    h = await createHarness();
    const f1 = h.add(subject(77, [adminRole("finance")]));
    const f2 = h.add(subject(78, [adminRole("finance")]));
    const t1 = (await h.http().get(ORDERS).set(bearer(f1))).headers.etag as string;
    const r2 = await h.http().get(ORDERS).set(bearer(f2)).set("If-None-Match", t1);
    expect(r2.status).toBe(304);
    expect(r2.text).toBe("");
  });

  it("a deny is decided before the data source: a failing rollup store still yields 403 (not 503) for a forbidden caller", async () => {
    h = await createHarness();
    const mk = h.add(subject(79, [adminRole("marketing")]));
    h.rollups.failWith = new Error("db down");
    expect((await h.http().get(ORDERS).set(bearer(mk))).status).toBe(403);
  });
});

describe("query cost caps", () => {
  const base = (id = "platform.orders.placed") => `/v1/admin/metrics/${id}`;
  const win = (from: string, to: string, grain: string, extra = "") => `from=${iso(from)}&to=${iso(to)}&grain=${grain}${extra}`;

  it("max window per grain: at the cap is allowed, one bucket over is 400 window_too_large (day 366, hour 169, week 104, month 36)", async () => {
    h = await createHarness();
    const fin = h.add(subject(80, [adminRole("finance")]));
    const get = (qs: string) => h.http().get(`${base()}?${qs}`).set(bearer(fin));
    // NOW = 2026-10-20T12:00Z. Day grain: 366 buckets ending today.
    const today = bucketContaining("day", NOW);
    let first = today;
    for (let i = 1; i < GRAIN_MAX_POINTS.day; i++) first = bucketContaining("day", first.startMs - 1);
    const okFrom = new Date(first.startMs).toISOString();
    const ok = await get(win(okFrom, new Date(NOW).toISOString(), "day", "&compare=none"));
    expect(ok.status).toBe(200);
    expect(ok.body.series[0].points).toHaveLength(366);
    const over = bucketContaining("day", first.startMs - 1);
    const bad = await get(win(new Date(over.startMs).toISOString(), new Date(NOW).toISOString(), "day", "&compare=none"));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("window_too_large");
  });

  it("12-month window: a 13-month day-grain request is 400; a 12-month one is 200 (response is bounded)", async () => {
    h = await createHarness();
    const fin = h.add(subject(81, [adminRole("finance")]));
    const get = (qs: string) => h.http().get(`${base()}?${qs}`).set(bearer(fin));
    expect((await get(win("2025-10-21T00:00:00Z", "2026-10-20T12:00:00Z", "day"))).status).toBe(200);
    expect((await get(win("2025-09-01T00:00:00Z", "2026-10-20T12:00:00Z", "day"))).status).toBe(400);
    expect((await get(win("2020-01-01T00:00:00Z", "2026-10-20T12:00:00Z", "day"))).status).toBe(400);
    expect((await get(win("2020-01-01T00:00:00Z", "2026-10-20T12:00:00Z", "hour"))).status).toBe(400);
  });

  it("hour grain beyond 7 days is 400 and 7 days is allowed; week grain beyond 104 weeks is 400; month beyond 36 is 400", async () => {
    h = await createHarness();
    const fin = h.add(subject(82, [adminRole("finance")]));
    const get = (qs: string) => h.http().get(`${base()}?${qs}`).set(bearer(fin));
    expect((await get(win("2026-10-14T00:00:00Z", "2026-10-20T12:00:00Z", "hour", "&compare=none"))).status).toBe(200);
    expect((await get(win("2026-10-01T00:00:00Z", "2026-10-20T12:00:00Z", "hour"))).status).toBe(400);
    expect((await get(win("2024-06-01T00:00:00Z", "2026-10-20T12:00:00Z", "week"))).status).toBe(400);
    expect((await get(win("2022-01-01T00:00:00Z", "2026-10-20T12:00:00Z", "month"))).status).toBe(400);
    expect((await get(win("2024-01-01T00:00:00Z", "2026-10-20T12:00:00Z", "month"))).status).toBe(200);
  });

  it("the cap is on the SNAPPED window, not the requested one: a short request straddling bucket edges cannot be inflated and a capped request cannot slip under by one ms", () => {
    const now = utc("2026-10-20T12:00:00Z");
    let first = bucketContaining("day", now);
    for (let i = 1; i < GRAIN_MAX_POINTS.day; i++) first = bucketContaining("day", first.startMs - 1);
    // 1 ms inside the first allowed bucket still snaps to exactly 366 buckets
    expect(snapWindow("day", first.startMs + 1, now, now)).toHaveLength(366);
    // 1 ms inside the bucket before it snaps to 367 -> rejected
    const over = bucketContaining("day", first.startMs - 1);
    expect(() => snapWindow("day", over.startMs + 1, now, now)).toThrow(InvalidWindowError);
  });

  it("garbage query shapes are 400, not 500: repeated params, arrays, huge strings, NaN-ish instants, extra page/limit/cursor params", async () => {
    h = await createHarness();
    const fin = h.add(subject(83, [adminRole("finance")]));
    const get = async (qs: string) => (await h.http().get(`${base()}?${qs}`).set(bearer(fin))).status;
    const ok = win("2026-10-18T00:00:00Z", "2026-10-20T00:00:00Z", "day");
    expect(await get(`${ok}&page=2`)).toBe(400);
    expect(await get(`${ok}&limit=100000`)).toBe(400);
    expect(await get(`${ok}&cursor=abc`)).toBe(400);
    expect(await get(`${ok}&compare=previous_year`)).toBe(400);
    expect(await get(`${ok}&grain=hour`)).toBe(400);
    expect(await get(`${ok}&grain=day`)).toBe(400);
    expect(await get(`${ok}&compare=none&compare=none`)).toBe(400);
    expect(await get(`from=NaN&to=Infinity&grain=day`)).toBe(400);
    expect(await get(`from=${"9".repeat(5000)}&to=1&grain=day`)).toBe(400);
    expect(await get(`from=${iso("+275760-09-13T00:00:00Z")}&to=${iso("+275760-09-14T00:00:00Z")}&grain=day`)).toBe(400);
    expect(await get(`from=${iso("0000-01-01T00:00:00Z")}&to=${iso("2026-10-20T00:00:00Z")}&grain=month`)).toBe(400);
  });

  it("a window wholly in the future is 400 and does not read the store", async () => {
    h = await createHarness();
    const fin = h.add(subject(84, [adminRole("finance")]));
    const reads0 = h.rollups.reads;
    const r = await h.http().get(`${base()}?${win("2027-01-01T00:00:00Z", "2027-02-01T00:00:00Z", "day")}`).set(bearer(fin));
    expect(r.status).toBe(400);
    expect(h.rollups.reads).toBe(reads0);
  });

  it("an over-long metricId (path) is 400 or 404/403, never 500", async () => {
    h = await createHarness();
    const fin = h.add(subject(85, [adminRole("finance")]));
    const r = await h.http().get(`${base("x".repeat(500))}?${win("2026-10-18T00:00:00Z", "2026-10-20T00:00:00Z", "day")}`).set(bearer(fin));
    expect([400, 404]).toContain(r.status);
  });
});

describe("role matrix at HTTP: money vs counts, standing vs elevation", () => {
  const Q = `from=${iso("2026-10-18T00:00:00Z")}&to=${iso("2026-10-20T12:00:00Z")}&grain=day`;
  const url = (id: string) => `/v1/admin/metrics/${id}?${Q}`;
  const MONEY = ADMIN_METRICS.filter((m) => m.access === "money" && !m.needsFacts).map((m) => m.def.id);
  const COUNTS = ADMIN_METRICS.filter((m) => m.access === "counts" && !m.needsFacts).map((m) => m.def.id);
  const ROLES = ["ops", "finance", "marketing", "support", "trust_safety", "dpo", "security", "super_admin"] as const;
  const expectCounts = (role: string) => (role === "ops" || role === "finance" ? 200 : 403);
  const expectMoney = (role: string) => (role === "finance" ? 200 : 403);

  it("registry sanity: every money-unit metric is access=money, and the closed set is what the matrix covers", () => {
    for (const m of ADMIN_METRICS) if (m.def.unit === "piastres") expect(m.access).toBe("money");
    expect(MONEY.length).toBeGreaterThan(0);
    expect(COUNTS.length).toBeGreaterThan(0);
  });

  it("every standing role x every registered metric", async () => {
    h = await createHarness();
    let n = 100;
    for (const role of ROLES) {
      const s = h.add(subject(n++, [adminRole(role)]));
      for (const id of COUNTS) expect([role, id, (await h.http().get(url(id)).set(bearer(s))).status]).toEqual([role, id, expectCounts(role)]);
      for (const id of MONEY) expect([role, id, (await h.http().get(url(id)).set(bearer(s))).status]).toEqual([role, id, expectMoney(role)]);
    }
  });

  it("derived money metric AOV is not reachable with counts roles (money inferred from ratios is still money)", async () => {
    h = await createHarness();
    const ops = h.add(subject(120, [adminRole("ops")]));
    expect((await h.http().get(url("platform.aov")).set(bearer(ops))).status).toBe(403);
  });

  it("no passkey (basic assurance) is refused even for finance, on counts and money alike", async () => {
    h = await createHarness();
    const fin = h.add(subject(121, [adminRole("finance")], { assurance: "basic" }));
    for (const id of [...COUNTS, ...MONEY]) expect((await h.http().get(url(id)).set(bearer(fin))).status).toBe(403);
  });

  it("user with no admin grant at all (shopper, brand) is 403 and audited", async () => {
    h = await createHarness();
    const s = h.add(subject(122, [{ kind: "shopper" }]));
    const b = h.add(subject(123, [{ kind: "brand", storeId: "0192f3a4-5b6c-7d8e-9f01-0000000000aa", role: "owner" }]));
    expect((await h.http().get(url(COUNTS[0]!)).set(bearer(s))).status).toBe(403);
    expect((await h.http().get(url(MONEY[0]!)).set(bearer(b))).status).toBe(403);
    expect(h.sink.entries.filter((e) => e.effect === "deny")).toHaveLength(2);
  });

  const live = (userId: string, role: string, ttl = 30 * 60_000) =>
    [{ id: "e1", userId, role, reasonCode: "t", approvalId: "a1", requestedTtlMs: ttl, state: "ACTIVE", requestedAtMs: NOW - 1000, activatedAtMs: NOW - 1000, expiresAtMs: NOW + ttl, revokedAtMs: null, revokedBy: null }] as never[];

  it("elevation: a standing ops user with a LIVE finance elevation can read money; expired, revoked, other-user and lapsed elevations cannot", async () => {
    h = await createHarness();
    const ops = h.add(subject(130, [adminRole("ops")]));
    expect((await h.http().get(url(MONEY[0]!)).set(bearer(ops))).status).toBe(403);
    h.elevations.set(ops.actor.id, live(ops.actor.id, "finance"));
    expect((await h.http().get(url(MONEY[0]!)).set(bearer(ops))).status).toBe(200);
    const expired = live(ops.actor.id, "finance").map((e) => ({ ...(e as object), expiresAtMs: NOW - 1 })) as never[];
    h.elevations.set(ops.actor.id, expired);
    expect((await h.http().get(url(MONEY[0]!)).set(bearer(ops))).status).toBe(403);
    const revoked = live(ops.actor.id, "finance").map((e) => ({ ...(e as object), state: "REVOKED" })) as never[];
    h.elevations.set(ops.actor.id, revoked);
    expect((await h.http().get(url(MONEY[0]!)).set(bearer(ops))).status).toBe(403);
    const other = live("0192f3a4-5b6c-7d8e-9f01-0000000009ff", "finance");
    h.elevations.set(ops.actor.id, other);
    expect((await h.http().get(url(MONEY[0]!)).set(bearer(ops))).status).toBe(403);
  });

  it("elevation to finance does not help a caller with NO standing admin grant, nor without a passkey", async () => {
    h = await createHarness();
    const shopper = h.add(subject(131, [{ kind: "shopper" }]));
    h.elevations.set(shopper.actor.id, live(shopper.actor.id, "finance"));
    expect((await h.http().get(url(MONEY[0]!)).set(bearer(shopper))).status).toBe(403);
    const nopk = h.add(subject(132, [adminRole("ops")], { assurance: "basic" }));
    h.elevations.set(nopk.actor.id, live(nopk.actor.id, "finance"));
    expect((await h.http().get(url(MONEY[0]!)).set(bearer(nopk))).status).toBe(403);
  });

  it("standing super_admin gets nothing; super_admin break-glass is not a finance/ops role either (metrics stay closed)", async () => {
    h = await createHarness();
    const sa = h.add(subject(133, [adminRole("super_admin")]));
    expect((await h.http().get(url(COUNTS[0]!)).set(bearer(sa))).status).toBe(403);
    h.elevations.set(sa.actor.id, live(sa.actor.id, "super_admin"));
    expect((await h.http().get(url(MONEY[0]!)).set(bearer(sa))).status).toBe(403);
    expect((await h.http().get(url(COUNTS[0]!)).set(bearer(sa))).status).toBe(403);
  });

  it("an elevation lookup failure fails closed with 503 (not an allow)", async () => {
    h = await createHarness();
    const fin = h.add(subject(134, [adminRole("finance")]));
    h.elevations.get = () => {
      throw new Error("boom");
    };
    const r = await h.http().get(url(COUNTS[0]!)).set(bearer(fin));
    expect(r.status).toBe(503);
  });

  it("elevated-only role is not remembered: dropping the elevation on the next request removes access", async () => {
    h = await createHarness();
    const mk = h.add(subject(135, [adminRole("marketing")]));
    h.elevations.set(mk.actor.id, live(mk.actor.id, "ops"));
    expect((await h.http().get(url(COUNTS[0]!)).set(bearer(mk))).status).toBe(200);
    h.elevations.delete(mk.actor.id);
    expect((await h.http().get(url(COUNTS[0]!)).set(bearer(mk))).status).toBe(403);
  });
});

describe("unknown metric id: no 404/403 oracle", () => {
  const Q = `from=${iso("2026-10-18T00:00:00Z")}&to=${iso("2026-10-20T12:00:00Z")}&grain=day`;
  const strip = (b: Record<string, unknown>) => ({ ...b, request_id: undefined, instance: undefined });

  it("a caller with no metrics role gets the same 403 body for unknown ids as for real money and counts ids", async () => {
    h = await createHarness();
    const mk = h.add(subject(140, [adminRole("marketing")]));
    const get = (id: string) => h.http().get(`/v1/admin/metrics/${id}?${Q}`).set(bearer(mk));
    const unknown = await get("platform.nope");
    const money = await get("platform.gmv.purchased");
    const counts = await get("platform.orders.placed");
    expect([unknown.status, money.status, counts.status]).toEqual([403, 403, 403]);
    expect(strip(unknown.body)).toEqual(strip(money.body));
    expect(strip(unknown.body)).toEqual(strip(counts.body));
  });

  it("ORACLE: an ops caller (counts only) must see the same status for an unknown id as for a money id it may not read", async () => {
    h = await createHarness();
    const ops = h.add(subject(141, [adminRole("ops")]));
    const get = async (id: string) => (await h.http().get(`/v1/admin/metrics/${id}?${Q}`).set(bearer(ops))).status;
    // Otherwise ops can enumerate which money metric ids exist (403 = exists, 404 = does not).
    expect(await get("platform.nope")).toBe(await get("platform.gmv.purchased"));
  });

  it("an authorized finance caller gets 404 unknown_metric with a stable body for any unknown id", async () => {
    h = await createHarness();
    const fin = h.add(subject(142, [adminRole("finance")]));
    const a = await h.http().get(`/v1/admin/metrics/platform.nope?${Q}`).set(bearer(fin));
    const b = await h.http().get(`/v1/admin/metrics/seller.sales.gmv?${Q}`).set(bearer(fin));
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(strip(a.body)).toEqual(strip(b.body));
    expect(JSON.stringify(a.body)).not.toContain("platform.nope");
  });

  it("unknown ids do not trigger a store read and are not counted as reads; ids are case/whitespace exact", async () => {
    h = await createHarness();
    const fin = h.add(subject(143, [adminRole("finance")]));
    const reads0 = h.rollups.reads;
    for (const id of ["Platform.Orders.Placed", "platform.orders.placed%20", "..%2Fadmin"]) {
      const r = await h.http().get(`/v1/admin/metrics/${id}?${Q}`).set(bearer(fin));
      expect([400, 404]).toContain(r.status);
    }
    expect(h.rollups.reads).toBe(reads0);
    expect(h.reads).toEqual([]);
  });

  it("unknown metric with an invalid window by an unauthorized caller is still 403 (authz precedes validation of semantics)", async () => {
    h = await createHarness();
    const mk = h.add(subject(144, [adminRole("marketing")]));
    const r = await h.http().get(`/v1/admin/metrics/platform.nope?${Q.replace("day", "hour")}`).set(bearer(mk));
    expect(r.status).toBe(403);
  });
});
