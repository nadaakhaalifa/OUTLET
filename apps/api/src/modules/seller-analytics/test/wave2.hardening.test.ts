import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { GRAIN_MAX_POINTS, bucketContaining, type HourlyRow } from "../../platform-metrics";
import type { SellerRollupReader } from "../domain/series-ports";
import { TOKENS, bearer, createAnalyticsHarness, type AnalyticsHarness } from "./harness";
import { DAY, STORE_A, STORE_B, T0, U } from "./repository-contract";

const H = 3_600_000;
const utc = (s: string): number => Date.parse(s);
const iso = (ms: number): string => encodeURIComponent(new Date(ms).toISOString());

/** Counting in-memory reader keyed by store: lets the tests see exactly which store ids were ever read. */
class SpyReader implements SellerRollupReader {
  readonly rows = new Map<string, HourlyRow[]>();
  readonly freshCalls: string[] = [];
  readonly readCalls: string[] = [];
  asOfMs: number | null = null;
  epoch = 0;
  set(store: string, metric: string, hourUtcMs: number, value: bigint, held = 0n): void {
    const k = `${store}|${metric}`;
    const l = this.rows.get(k) ?? [];
    l.push({ hourUtcMs, value, held });
    this.rows.set(k, l);
  }
  async freshness(storeId: string) {
    this.freshCalls.push(storeId);
    return { asOfMs: this.asOfMs, epoch: this.epoch };
  }
  async read(storeId: string, metric: string, fromMs: number, toMs: number) {
    this.readCalls.push(storeId);
    return (this.rows.get(`${storeId}|${metric}`) ?? []).filter((r) => r.hourUtcMs >= fromMs && r.hourUtcMs < toMs);
  }
}

let h: AnalyticsHarness;
let spy: SpyReader;
afterEach(async () => {
  await h?.close();
});
const boot = async (extra: { shopperSeriesEnabled?: () => boolean } = {}) => {
  spy = new SpyReader();
  h = await createAnalyticsHarness({ seriesEnabled: () => true, shopperSeriesEnabled: () => false, reader: spy, ...extra });
};

const base = (s: string) => `/v1/seller/stores/${s}/analytics`;
const win = `from=${iso(T0 - 3 * DAY)}&to=${iso(T0)}&grain=day`;
const surl = (s: string, id: string, qs = win) => `${base(s)}/series/${id}?${qs}`;
const get = (url: string, token: string | null = TOKENS.ownerA, inm?: string) => {
  const r = h.http().get(url).set(token === null ? {} : bearer(token));
  return inm === undefined ? r : r.set("If-None-Match", inm);
};
const strip = (b: Record<string, unknown>) => ({ ...b, request_id: undefined, instance: undefined });

describe("cross-tenant seller series: A -> B is 404 identical to an unknown store", () => {
  const UNKNOWN = U(9999);
  const routes = (s: string) => [
    surl(s, "seller.sales.gmv"),
    surl(s, "seller.sales.net_after_commission"),
    surl(s, "seller.sales.aov", `${win}&compare=none`),
    surl(s, "seller.nope"),
    surl(s, "seller.returns.rate_bps"), // needs facts: would be 503 for own store
    `${base(s)}/series/seller.traffic.unique_visitors?preset=current_month&grain=day`,
    `${base(s)}/series/seller.traffic.views/breakdown?preset=current_month&grain=day&dimension=source`,
    `${base(s)}/summary?from=${iso(T0 - DAY)}&to=${iso(T0)}`,
  ];

  it("every seller-A role gets the same status and body for store B as for a non-existent store, on every series route", async () => {
    await boot({ shopperSeriesEnabled: () => true });
    spy.set(STORE_B, "gmv_minor", T0 - DAY, 777_777n);
    const aTokens = [TOKENS.ownerA, TOKENS.managerA, TOKENS.financeA, TOKENS.catalogA];
    for (const tok of aTokens) {
      const foreign = routes(STORE_B);
      const missing = routes(UNKNOWN);
      for (let i = 0; i < foreign.length; i++) {
        const f = await get(foreign[i]!, tok);
        const m = await get(missing[i]!, tok);
        expect([i, f.status]).toEqual([i, m.status]);
        expect(strip(f.body)).toEqual(strip(m.body));
        expect(f.headers.etag).toBeUndefined();
        expect(f.headers["cache-control"] ?? "").not.toMatch(/max-age=[1-9]/);
        expect(JSON.stringify(f.body)).not.toContain("777777");
        expect(JSON.stringify(f.body)).not.toContain(STORE_B);
      }
    }
    // for a role that may read store A, foreign is 404 (not 403) on the ordinary routes
    expect((await get(surl(STORE_B, "seller.sales.gmv"), TOKENS.ownerA)).status).toBe(404);
  });

  it("the reader is never touched for another tenant's store id (no data fetch, no freshness probe, no timing channel)", async () => {
    await boot();
    for (const url of routes(STORE_B)) await get(url, TOKENS.ownerA);
    for (const url of routes(UNKNOWN)) await get(url, TOKENS.ownerA);
    expect(spy.freshCalls).toEqual([]);
    expect(spy.readCalls).toEqual([]);
  });

  it("B owner symmetric: B reads B (200) and gets 404 for A; the A path with upper-case or padded ids does not bypass the guard", async () => {
    await boot();
    spy.set(STORE_A, "gmv_minor", T0 - DAY, 1n);
    expect((await get(surl(STORE_B, "seller.sales.gmv"), TOKENS.ownerB)).status).toBe(200);
    expect((await get(surl(STORE_A, "seller.sales.gmv"), TOKENS.ownerB)).status).toBe(404);
    expect((await get(surl(STORE_A.toUpperCase(), "seller.sales.gmv"), TOKENS.ownerB)).status).toBe(404);
    expect([400, 404]).toContain((await get(surl(`${STORE_A}%20`, "seller.sales.gmv"), TOKENS.ownerB)).status);
    expect([400, 404]).toContain((await get(surl("not-a-uuid", "seller.sales.gmv"), TOKENS.ownerB)).status);
    // upper-case form of the OWN store works and reads the lower-case key
    spy.set(STORE_B, "gmv_minor", T0 - DAY, 5n);
    const own = await get(surl(STORE_B.toUpperCase(), "seller.sales.gmv"), TOKENS.ownerB);
    expect([200, 404]).toContain(own.status);
    if (own.status === 200) expect(spy.freshCalls.every((c) => c === c.toLowerCase())).toBe(true);
  });

  it("the series of store A never contains store B rows even when both have data in the same hour", async () => {
    await boot();
    spy.set(STORE_A, "gmv_minor", T0 - DAY, 100n);
    spy.set(STORE_B, "gmv_minor", T0 - DAY, 900_000n);
    const a = await get(surl(STORE_A, "seller.sales.gmv"));
    expect(a.body.totals.current).toBe("100");
    expect(spy.readCalls.every((c) => c === STORE_A)).toBe(true);
    const sum = await get(`${base(STORE_A)}/summary?from=${iso(T0 - 2 * DAY)}&to=${iso(T0)}`);
    expect(JSON.stringify(sum.body)).not.toContain("900000");
  });

  it("negative authz on every series route: no token 401, buyer audience 401, no-scope token 403, suspended seller refused, shopper refused", async () => {
    await boot();
    for (const url of routes(STORE_A).filter((u) => !u.includes("preset"))) {
      expect((await get(url, null)).status).toBe(401);
      expect((await get(url, TOKENS.buyerAudSeller)).status).toBe(401);
      expect((await get(url, TOKENS.noScopeA)).status).toBe(403);
      expect([401, 403, 404]).toContain((await get(url, TOKENS.suspendedA)).status);
      expect([401, 403, 404]).toContain((await get(url, TOKENS.shopper)).status);
    }
    expect(spy.readCalls).toEqual([]);
  });
});

describe("seller ETag / 304 only after authorization", () => {
  it("a caller who is not authorized for the store gets 404 (not 304) even when presenting the exact ETag; reader untouched", async () => {
    await boot();
    spy.asOfMs = T0;
    const etag = (await get(surl(STORE_A, "seller.sales.orders"))).headers.etag as string;
    spy.freshCalls.length = 0;
    spy.readCalls.length = 0;
    for (const inm of [etag, "*", `W/${etag}`]) {
      const r = await get(surl(STORE_A, "seller.sales.orders"), TOKENS.ownerB, inm);
      expect(r.status).toBe(404);
      expect(r.headers.etag).toBeUndefined();
    }
    expect((await get(surl(STORE_A, "seller.sales.orders"), TOKENS.noScopeA, etag)).status).toBe(403);
    expect((await get(surl(STORE_A, "seller.sales.orders"), null, etag)).status).toBe(401);
    expect((await get(surl(STORE_A, "seller.sales.orders"), TOKENS.buyerAudSeller, etag)).status).toBe(401);
    expect(spy.freshCalls).toEqual([]);
    expect(spy.readCalls).toEqual([]);
  });

  it("the body and headers of a 404 for a foreign store are identical with and without If-None-Match", async () => {
    await boot();
    const etag = (await get(surl(STORE_A, "seller.sales.orders"))).headers.etag as string;
    const plain = await get(surl(STORE_A, "seller.sales.orders"), TOKENS.ownerB);
    const tagged = await get(surl(STORE_A, "seller.sales.orders"), TOKENS.ownerB, etag);
    expect(tagged.status).toBe(plain.status);
    expect(strip(tagged.body)).toEqual(strip(plain.body));
  });

  it("ETag is scoped by store (same params, different store -> different tag) and an authorized 304 skips the aggregate read", async () => {
    await boot();
    const a = (await get(surl(STORE_A, "seller.sales.orders"))).headers.etag as string;
    const b = (await get(surl(STORE_B, "seller.sales.orders"), TOKENS.ownerB)).headers.etag as string;
    expect(a).not.toBe(b);
    // B's owner replaying A's tag on B's own store: tag mismatch -> 200
    expect((await get(surl(STORE_B, "seller.sales.orders"), TOKENS.ownerB, a)).status).toBe(200);
    const reads = spy.readCalls.length;
    expect((await get(surl(STORE_A, "seller.sales.orders"), TOKENS.ownerA, a)).status).toBe(304);
    expect(spy.readCalls.length).toBe(reads);
  });

  it("tag changes with watermark and epoch, and summary honours the same rule", async () => {
    await boot();
    const sum = `${base(STORE_A)}/summary?from=${iso(T0 - 2 * DAY)}&to=${iso(T0)}`;
    const t1 = (await get(sum)).headers.etag as string;
    expect((await get(sum, TOKENS.ownerA, t1)).status).toBe(304);
    expect((await get(sum, TOKENS.ownerB, t1)).status).toBe(404);
    spy.asOfMs = T0;
    expect((await get(sum, TOKENS.ownerA, t1)).status).toBe(200);
    const t2 = (await get(sum)).headers.etag as string;
    spy.epoch += 1;
    expect((await get(sum, TOKENS.ownerA, t2)).status).toBe(200);
  });
});

describe("seller query cost caps", () => {
  const ok = (qs: string) => get(surl(STORE_A, "seller.sales.gmv", qs));
  const now = () => T0; // harness clock starts at T0 (exactly on an hour boundary)
  const upTo = () => iso(T0 + 1);

  it("day grain: 366 buckets allowed, 367 is 400 window_too_large; hour 169 / week 104 / month 36 likewise", async () => {
    await boot();
    const back = (grain: "hour" | "day" | "week" | "month", n: number) => {
      let b = bucketContaining(grain, now());
      for (let i = 1; i < n; i++) b = bucketContaining(grain, b.startMs - 1);
      return b.startMs;
    };
    for (const grain of ["hour", "day", "week", "month"] as const) {
      const cap = GRAIN_MAX_POINTS[grain];
      const fine = await ok(`from=${iso(back(grain, cap))}&to=${upTo()}&grain=${grain}&compare=none`);
      expect([grain, fine.status]).toEqual([grain, 200]);
      const tooBig = await ok(`from=${iso(back(grain, cap + 1))}&to=${upTo()}&grain=${grain}&compare=none`);
      expect([grain, tooBig.status]).toEqual([grain, 400]);
      expect(JSON.stringify(tooBig.body)).toContain("window_too_large");
    }
  });

  it("12-month window: 12 months at day grain is fine, 13+ months and multi-year windows are 400", async () => {
    await boot();
    expect((await ok(`from=${iso(T0 - 360 * DAY)}&to=${iso(T0)}&grain=day`)).status).toBe(200);
    expect((await ok(`from=${iso(T0 - 400 * DAY)}&to=${iso(T0)}&grain=day`)).status).toBe(400);
    expect((await ok(`from=${iso(T0 - 5 * 365 * DAY)}&to=${iso(T0)}&grain=day`)).status).toBe(400);
    expect((await ok(`from=${iso(T0 - 400 * DAY)}&to=${iso(T0)}&grain=hour`)).status).toBe(400);
  });

  it("summary has the same cap (day grain, 366) and the same validation", async () => {
    await boot();
    const s = (qs: string) => get(`${base(STORE_A)}/summary?${qs}`);
    expect((await s(`from=${iso(T0 - 360 * DAY)}&to=${iso(T0)}`)).status).toBe(200);
    expect((await s(`from=${iso(T0 - 400 * DAY)}&to=${iso(T0)}`)).status).toBe(400);
    expect((await s(`from=${iso(T0)}&to=${iso(T0 - DAY)}`)).status).toBe(400);
    expect((await s(`from=${iso(T0 - DAY)}`)).status).toBe(400);
    expect((await s(`from=${iso(T0 - DAY)}&to=${iso(T0)}&grain=hour`)).status).toBe(400);
    expect((await s(`from=${iso(T0 - DAY)}&to=${iso(T0)}&limit=10`)).status).toBe(400);
  });

  it("page/limit/cursor/offset/sort params are rejected (400), never ignored, on series, breakdown and summary", async () => {
    await boot({ shopperSeriesEnabled: () => true });
    for (const extra of ["page=2", "limit=1000000", "limit=-1", "cursor=abc", "offset=5", "sort=desc", "top=1000"]) {
      expect([extra, (await ok(`${win}&${extra}`)).status]).toEqual([extra, 400]);
      expect([extra, (await get(`${base(STORE_A)}/summary?from=${iso(T0 - DAY)}&to=${iso(T0)}&${extra}`)).status]).toEqual([extra, 400]);
      expect(
        [extra, (await get(`${base(STORE_A)}/series/seller.traffic.views/breakdown?preset=current_month&grain=day&dimension=source&${extra}`)).status],
      ).toEqual([extra, 400]);
    }
    expect(spy.readCalls).toEqual([]);
  });

  it("malformed instants, repeated params, huge strings and out-of-range dates are 400 (never 500) and read nothing", async () => {
    await boot();
    const bad = [
      `from=NaN&to=Infinity&grain=day`,
      `from=${"9".repeat(4000)}&to=1&grain=day`,
      `${win}&grain=week&grain=day`,
      `from=${iso(T0 - DAY)}&from=${iso(T0 - 2 * DAY)}&to=${iso(T0)}&grain=day`,
      `from=${encodeURIComponent("0000-01-01T00:00:00Z")}&to=${iso(T0)}&grain=month`,
      `from=${encodeURIComponent("+275760-09-13T00:00:00Z")}&to=${encodeURIComponent("+275760-09-14T00:00:00Z")}&grain=day`,
      `from=${iso(T0 + 400 * DAY)}&to=${iso(T0 + 500 * DAY)}&grain=day`,
      `from=${iso(T0)}&to=${iso(T0)}&grain=day`,
      `${win}&compare=previous_year`,
      `${win}&preset=current_month`,
    ];
    for (const qs of bad) expect([qs.slice(0, 40), (await ok(qs)).status]).toEqual([qs.slice(0, 40), 400]);
    expect(spy.readCalls).toEqual([]);
  });

  it("a very long metric id is 400 or 404, never 500", async () => {
    await boot();
    const r = await get(surl(STORE_A, "x".repeat(500)));
    expect([400, 404]).toContain(r.status);
  });
});

describe("seller bucketing, arithmetic and compare alignment over HTTP", () => {
  it("a purchase at 20:59:59Z and one at 21:00:00Z in summer fall in different Cairo days (UTC midnight is not the boundary)", async () => {
    await boot();
    const f = utc("2026-07-01T20:00:00Z");
    spy.set(STORE_A, "gmv_minor", f, 10n);
    spy.set(STORE_A, "gmv_minor", utc("2026-07-01T21:00:00Z"), 20n);
    spy.set(STORE_A, "gmv_minor", utc("2026-07-01T23:00:00Z"), 5n);
    // harness clock is far later (T0) so these are history
    const r = await get(surl(STORE_A, "seller.sales.gmv", `from=${iso(utc("2026-06-30T21:00:00Z"))}&to=${iso(utc("2026-07-02T21:00:00Z"))}&grain=day&compare=none`));
    expect(r.status).toBe(200);
    expect(r.body.series[0].points.map((p: { label: string; v: string }) => [p.label, p.v])).toEqual([
      ["2026-07-01", "10"],
      ["2026-07-02", "25"],
    ]);
  });

  it("DST: the 2026-10-29 day is 25 hours with both 23:00 hours present at hour grain, the 2026-04-24 day is 23 hours", async () => {
    await boot();
    const day = await get(surl(STORE_A, "seller.sales.gmv", `from=${iso(utc("2026-10-28T21:00:00Z"))}&to=${iso(utc("2026-10-30T21:00:00Z"))}&grain=day&compare=none`));
    expect(day.body.series[0].points.map((p: { label: string; hours: number }) => [p.label, p.hours])).toEqual([["2026-10-29", 25], ["2026-10-30", 24]]);
    spy.set(STORE_A, "gmv_minor", utc("2026-10-29T20:00:00Z"), 1n); // first 23:00 (UTC+3)
    spy.set(STORE_A, "gmv_minor", utc("2026-10-29T21:00:00Z"), 2n); // second 23:00 (UTC+2)
    const hr = await get(surl(STORE_A, "seller.sales.gmv", `from=${iso(utc("2026-10-29T19:00:00Z"))}&to=${iso(utc("2026-10-29T23:00:00Z"))}&grain=hour&compare=none`));
    const pts = hr.body.series[0].points as { label: string; fold?: number; v: string; offset_min: number }[];
    expect(pts.map((p) => [p.label, p.fold, p.v, p.offset_min])).toEqual([
      ["2026-10-29T22", 0, "0", 180],
      ["2026-10-29T23", 0, "1", 180],
      ["2026-10-29T23", 1, "2", 120],
      ["2026-10-30T00", 0, "0", 120],
    ]);
    const spring = await get(surl(STORE_A, "seller.sales.gmv", `from=${iso(utc("2026-04-23T22:00:00Z"))}&to=${iso(utc("2026-04-24T21:00:00Z"))}&grain=day&compare=none`));
    expect(spring.body.series[0].points[0].hours).toBe(23);
  });

  it("Saturday-start weeks and month boundaries on the seller route, Cairo calendar", async () => {
    await boot();
    const w = await get(surl(STORE_A, "seller.sales.gmv", `from=${iso(utc("2026-10-14T10:00:00Z"))}&to=${iso(utc("2026-10-15T10:00:00Z"))}&grain=week&compare=none`));
    expect(w.status).toBe(200);
    expect(w.body.series[0].points).toHaveLength(1);
    expect(w.body.series[0].from).toBe("2026-10-09T21:00:00.000Z"); // Sat 2026-10-10 00:00 Cairo
    expect(w.body.series[0].to).toBe("2026-10-16T21:00:00.000Z");
    const m = await get(surl(STORE_A, "seller.sales.gmv", `from=${iso(utc("2026-09-30T20:59:59Z"))}&to=${iso(utc("2026-10-31T22:30:00Z"))}&grain=month&compare=none`));
    expect(m.body.series[0].points.map((p: { label: string }) => p.label)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(m.body.series[0].points[1].hours).toBe(31 * 24 + 1);
  });

  it("net_after_commission == gmv - commission per bucket and in total (random hourly rows, bigint end to end, above 2^53)", async () => {
    await boot();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 71 }), fc.bigInt({ min: 0n, max: 10n ** 17n }), fc.bigInt({ min: 0n, max: 10n ** 15n })), { maxLength: 30 }),
        async (rows) => {
          spy.rows.clear();
          const start = utc("2026-09-01T21:00:00Z");
          for (const [hr, c, extra] of rows) {
            spy.set(STORE_A, "commission_minor", start + hr * H, c);
            spy.set(STORE_A, "gmv_minor", start + hr * H, c + extra);
          }
          const q = `from=${iso(start)}&to=${iso(start + 3 * DAY)}&grain=day&compare=none`;
          const [g, c, n] = await Promise.all(
            ["seller.sales.gmv", "seller.sales.commission", "seller.sales.net_after_commission"].map((id) => get(surl(STORE_A, id, q))),
          );
          expect([g!.status, c!.status, n!.status]).toEqual([200, 200, 200]);
          const gp = g!.body.series[0].points as { v: string }[];
          const cp = c!.body.series[0].points as { v: string }[];
          const np = n!.body.series[0].points as { v: string }[];
          np.forEach((p, i) => expect(BigInt(p.v)).toBe(BigInt(gp[i]!.v) - BigInt(cp[i]!.v)));
          expect(BigInt(n!.body.totals.current)).toBe(BigInt(g!.body.totals.current) - BigInt(c!.body.totals.current));
        },
      ),
      { numRuns: 15 },
    );
  });

  it("AOV: banker's rounding on ties (5/2 -> 2, 7/2 -> 4) per bucket, window AOV is over summed components", async () => {
    await boot();
    const d0 = utc("2026-09-01T21:00:00Z");
    spy.set(STORE_A, "gmv_minor", d0 + H, 5n);
    spy.set(STORE_A, "orders", d0 + H, 2n);
    spy.set(STORE_A, "gmv_minor", d0 + DAY + H, 7n);
    spy.set(STORE_A, "orders", d0 + DAY + H, 2n);
    const r = await get(surl(STORE_A, "seller.sales.aov", `from=${iso(d0)}&to=${iso(d0 + 2 * DAY)}&grain=day&compare=none`));
    expect(r.body.series[0].points.map((p: { v: string }) => p.v)).toEqual(["2", "4"]);
    expect(r.body.totals.current).toBe("3"); // 12/4, not mean(2,4)=3 by luck: use a skewed case below
    spy.set(STORE_A, "gmv_minor", d0 + H, 1000n);
    spy.set(STORE_A, "orders", d0 + H, 8n);
    const r2 = await get(surl(STORE_A, "seller.sales.aov", `from=${iso(d0)}&to=${iso(d0 + 2 * DAY)}&grain=day&compare=none`));
    // day0: 1005/10 = 100.5 -> 100 (even), day1: 7/2 = 3.5 -> 4, window: 1012/12 = 84.33 -> 84
    expect(r2.body.series[0].points.map((p: { v: string }) => p.v)).toEqual(["100", "4"]);
    expect(r2.body.totals.current).toBe("84");
  });

  it("held hours: the bucket is held (v null), excluded from totals, and no held amount leaks into the body", async () => {
    await boot();
    const d0 = utc("2026-09-01T21:00:00Z");
    spy.set(STORE_A, "orders", d0 + H, 11n);
    spy.set(STORE_A, "orders", d0 + DAY + H, 123_457n, 111_111n);
    spy.set(STORE_A, "orders", d0 + 2 * DAY + H, 4n);
    const r = await get(surl(STORE_A, "seller.sales.orders", `from=${iso(d0)}&to=${iso(d0 + 3 * DAY)}&grain=day&compare=none`));
    const pts = r.body.series[0].points as { v: number | null; state: string }[];
    expect(pts.map((p) => p.state)).toEqual(["ok", "held", "ok"]);
    expect(pts[1]!.v).toBeNull();
    expect(r.body.totals.current).toBe(15);
    expect(JSON.stringify(r.body)).not.toMatch(/123457|111111/);
    // gmv with one held component of the AOV pair holds the bucket and drops both from the total
    spy.set(STORE_A, "gmv_minor", d0 + H, 100n);
    spy.set(STORE_A, "orders", d0 + H, 0n);
    const aov = await get(surl(STORE_A, "seller.sales.aov", `from=${iso(d0)}&to=${iso(d0 + 3 * DAY)}&grain=day&compare=none`));
    expect(aov.body.series[0].points[1].state).toBe("held");
  });

  it("net_after_commission with a held commission hour is held, not gmv alone", async () => {
    await boot();
    const d0 = utc("2026-09-01T21:00:00Z");
    spy.set(STORE_A, "gmv_minor", d0 + H, 1000n);
    spy.set(STORE_A, "commission_minor", d0 + H, 100n, 1n);
    const r = await get(surl(STORE_A, "seller.sales.net_after_commission", `from=${iso(d0)}&to=${iso(d0 + DAY)}&grain=day&compare=none`));
    expect(r.body.series[0].points[0]).toMatchObject({ v: null, state: "held" });
    expect(r.body.totals.current).toBeNull();
  });

  it("compare=previous_period: previous series has the same point count, ends at current.from, and totals/delta use previous only", async () => {
    await boot();
    const d0 = utc("2026-09-04T21:00:00Z");
    spy.set(STORE_A, "orders", d0 - 3 * DAY + H, 10n);
    spy.set(STORE_A, "orders", d0 - 2 * DAY + H, 10n);
    spy.set(STORE_A, "orders", d0 + H, 15n);
    spy.set(STORE_A, "orders", d0 + DAY + H, 15n);
    spy.set(STORE_A, "orders", d0 - 10 * DAY + H, 9999n); // outside both windows
    const r = await get(surl(STORE_A, "seller.sales.orders", `from=${iso(d0)}&to=${iso(d0 + 3 * DAY)}&grain=day`));
    const [cur, prev] = r.body.series;
    expect(prev.key).toBe("previous");
    expect(prev.points).toHaveLength(cur.points.length);
    expect(prev.to).toBe(cur.from);
    expect(r.body.totals).toMatchObject({ current: 30, previous: 20, delta: 10, delta_bps: 5000 });
    const none = await get(surl(STORE_A, "seller.sales.orders", `from=${iso(d0)}&to=${iso(d0 + 3 * DAY)}&grain=day&compare=none`));
    expect(none.body.series).toHaveLength(1);
    expect(none.body.totals.previous).toBeNull();
  });

  it("summary tiles use day grain, previous period aligned, and net tile == gmv tile - commission-derived", async () => {
    await boot();
    const d0 = utc("2026-09-04T21:00:00Z");
    spy.set(STORE_A, "gmv_minor", d0 + H, 5000n);
    spy.set(STORE_A, "commission_minor", d0 + H, 750n);
    const r = await get(`${base(STORE_A)}/summary?from=${iso(d0)}&to=${iso(d0 + DAY)}`);
    expect(r.status).toBe(200);
    const byId = Object.fromEntries((r.body.tiles as { id: string; totals: { current: string | number | null }; grain: string }[]).map((t) => [t.id, t]));
    expect(byId["seller.sales.gmv"]!.totals.current).toBe("5000");
    expect(byId["seller.sales.net_after_commission"]!.totals.current).toBe("4250");
    expect(Object.values(byId).every((t) => t.grain === "day")).toBe(true);
  });
});

describe("seller unknown-metric / gated oracle", () => {
  it("unknown id is 404 unknown_metric for an authorized caller and never reads the store; gated-and-blocked is byte-identical to unknown", async () => {
    await boot();
    const unknown = await get(surl(STORE_A, "seller.nope"));
    const gated = await get(`${base(STORE_A)}/series/seller.sales.repeat_rate_bps?preset=current_month&grain=day`);
    const gatedBadQuery = await get(`${base(STORE_A)}/series/seller.sales.repeat_rate_bps?${win}`);
    expect(unknown.status).toBe(404);
    expect(strip(gated.body)).toEqual(strip(unknown.body));
    // a blocked gated metric must not reveal itself through grid validation either
    expect(gatedBadQuery.status === 400 || gatedBadQuery.status === 404).toBe(true);
    expect(spy.readCalls).toEqual([]);
  });

  it("a blocked gated id with an invalid query must answer exactly as an unknown id with the same invalid query (no existence oracle)", async () => {
    await boot();
    const badQ = `from=${iso(T0)}&to=${iso(T0 - DAY)}&grain=day`;
    const u = await get(surl(STORE_A, "seller.nope", badQ));
    const g = await get(surl(STORE_A, "seller.traffic.unique_visitors", badQ));
    expect(g.status).toBe(u.status);
  });

  it("with series blocked, an unknown id and a real id both answer without revealing registry membership to a foreign store", async () => {
    spy = new SpyReader();
    h = await createAnalyticsHarness({ seriesEnabled: () => false, shopperSeriesEnabled: () => false, reader: spy });
    const real = await get(surl(STORE_B, "seller.sales.gmv"));
    const fake = await get(surl(STORE_B, "seller.nope"));
    expect(real.status).toBe(fake.status);
    expect(strip(real.body)).toEqual(strip(fake.body));
  });

  it("with series blocked, authorized sellers still cannot tell unknown from real: both 404 (ungated) while an unknown id wins the registry check first", async () => {
    spy = new SpyReader();
    h = await createAnalyticsHarness({ seriesEnabled: () => false, shopperSeriesEnabled: () => false, reader: spy });
    const real = await get(surl(STORE_A, "seller.sales.gmv"));
    const fake = await get(surl(STORE_A, "seller.nope"));
    // Flag-off must be indistinguishable from "route does not exist": same status AND body for known vs unknown ids.
    expect(real.status).toBe(fake.status);
    expect(strip(real.body)).toEqual(strip(fake.body));
  });
});
