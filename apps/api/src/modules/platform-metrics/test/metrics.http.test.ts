import { afterEach, describe, expect, it } from "vitest";
import { MetricsDependencyUnavailableError } from "../domain/ports";
import { adminRole, bearer, createHarness, NOW, subject, type Harness } from "./harness";

let h: Harness;
afterEach(async () => {
  await h.close();
});

const DAY = 86_400_000;
const Q = `from=${encodeURIComponent("2026-10-18T00:00:00Z")}&to=${encodeURIComponent("2026-10-20T12:00:00Z")}&grain=day`;
const GMV = `/v1/admin/metrics/platform.gmv.purchased?${Q}`;
const ORDERS = `/v1/admin/metrics/platform.orders.purchased?${Q}`;

describe("GET /v1/admin/metrics/{metricId}", () => {
  it("is 404 while release.admin.metrics is blocked, before any read or audit", async () => {
    h = await createHarness(false);
    const s = h.add(subject(1, [adminRole("finance")]));
    const r = await h.http().get(GMV).set(bearer(s));
    expect(r.status).toBe(404);
    expect(h.sink.entries).toHaveLength(0);
    expect(h.rollups.reads).toBe(0);
  });

  it("authentication: no token, unknown token, buyer and seller audiences are 401", async () => {
    h = await createHarness();
    const buyer = h.add(subject(2, [adminRole("finance")], { aud: "buyer_api" }));
    const seller = h.add(subject(3, [adminRole("finance")], { aud: "seller_api" }));
    expect((await h.http().get(GMV)).status).toBe(401);
    expect((await h.http().get(GMV).set({ Authorization: "Bearer nope-nope-nope-nope-nope" })).status).toBe(401);
    expect((await h.http().get(GMV).set(bearer(buyer))).status).toBe(401);
    expect((await h.http().get(GMV).set(bearer(seller))).status).toBe(401);
  });

  it("authorization matrix: marketing and ops are 403 on money, marketing 403 on counts, finance without a passkey 403, standing super_admin 403", async () => {
    h = await createHarness();
    const marketing = h.add(subject(10, [adminRole("marketing")]));
    const ops = h.add(subject(11, [adminRole("ops")]));
    const fin = h.add(subject(12, [adminRole("finance")], { assurance: "basic" }));
    const sa = h.add(subject(13, [adminRole("super_admin")]));
    const shopper = h.add(subject(14, [{ kind: "shopper" }]));
    expect((await h.http().get(GMV).set(bearer(marketing))).status).toBe(403);
    expect((await h.http().get(ORDERS).set(bearer(marketing))).status).toBe(403);
    expect((await h.http().get(GMV).set(bearer(ops))).status).toBe(403);
    expect((await h.http().get(ORDERS).set(bearer(ops))).status).toBe(200);
    expect((await h.http().get(GMV).set(bearer(fin))).status).toBe(403);
    expect((await h.http().get(ORDERS).set(bearer(sa))).status).toBe(403);
    expect((await h.http().get(ORDERS).set(bearer(shopper))).status).toBe(403);
    // every deny is audited, with the denying reason
    const denies = h.sink.entries.filter((e) => e.ruleId === "admin.metrics.read");
    expect(denies).toHaveLength(6);
    expect(denies.every((e) => e.effect === "deny")).toBe(true);
    expect(h.reads).toEqual(["platform.orders.purchased"]);
  });

  it("an unknown metric is 404 for an authorised role and 403 for an unauthorised one (no enumeration)", async () => {
    h = await createHarness();
    const fin = h.add(subject(20, [adminRole("finance")]));
    const mk = h.add(subject(21, [adminRole("marketing")]));
    const r = await h.http().get(`/v1/admin/metrics/platform.nope?${Q}`).set(bearer(fin));
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).toContain("unknown_metric");
    expect((await h.http().get(`/v1/admin/metrics/platform.nope?${Q}`).set(bearer(mk))).status).toBe(403);
  });

  it("returns a MetricSeries: piastres as strings, previous aligned, as_of null when nothing was ingested, headers", async () => {
    h = await createHarness();
    const fin = h.add(subject(30, [adminRole("finance")]));
    h.rollups.set("gmv_purchased_minor", Date.parse("2026-10-19T09:00:00Z"), 123_456n);
    h.rollups.set("gmv_purchased_minor", Date.parse("2026-10-17T09:00:00Z"), 100_000n);
    const r = await h.http().get(GMV).set(bearer(fin));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-cache");
    expect(r.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(r.body).toMatchObject({ id: "platform.gmv.purchased", version: 1, grain: "day", unit: "piastres", currency: "EGP", additive: true, as_of: null, basis: "rollup" });
    const cur = r.body.series[0];
    expect(cur.points.map((p: { label: string }) => p.label)).toEqual(["2026-10-18", "2026-10-19", "2026-10-20"]);
    expect(cur.points.map((p: { v: string }) => p.v)).toEqual(["0", "123456", "0"]);
    expect(cur.points[2].state).toBe("partial");
    expect(r.body.series[1].key).toBe("previous");
    expect(r.body.series[1].points[2].v).toBe("100000");
    expect(r.body.totals).toMatchObject({ current: "123456", previous: "100000", delta: "23456", delta_bps: 2345 });
    expect(r.body.window.tz).toBe("Africa/Cairo");
  });

  it("compare=none returns one series; as_of comes from the watermark", async () => {
    h = await createHarness();
    const fin = h.add(subject(31, [adminRole("finance")]));
    h.rollups.asOfMs = NOW - 5 * 60_000;
    const r = await h.http().get(`${GMV}&compare=none`).set(bearer(fin));
    expect(r.body.series).toHaveLength(1);
    expect(r.body.as_of).toBe(new Date(NOW - 5 * 60_000).toISOString());
  });

  it("AOV is a ratio of two rollups with banker's rounding; zero orders is null/ok", async () => {
    h = await createHarness();
    const fin = h.add(subject(32, [adminRole("finance")]));
    const t = Date.parse("2026-10-19T09:00:00Z");
    h.rollups.set("gmv_purchased_minor", t, 10n);
    h.rollups.set("orders_purchased", t, 4n);
    const r = await h.http().get(`/v1/admin/metrics/platform.aov?${Q}`).set(bearer(fin));
    expect(r.body.additive).toBe(false);
    expect(r.body.series[0].points.map((p: { v: string | null }) => p.v)).toEqual([null, "2", null]);
    expect(r.body.totals.current).toBe("2");
  });

  it("a held hour is state held with v null, never zero", async () => {
    h = await createHarness();
    const ops = h.add(subject(33, [adminRole("ops")]));
    h.rollups.set("orders_purchased", Date.parse("2026-10-19T09:00:00Z"), 5n, 3n);
    const r = await h.http().get(ORDERS).set(bearer(ops));
    expect(r.body.series[0].points[1]).toMatchObject({ v: null, state: "held" });
  });

  it("If-None-Match gets 304 after authorization without reading the aggregate; a new watermark changes the ETag", async () => {
    h = await createHarness();
    const fin = h.add(subject(34, [adminRole("finance")]));
    const mk = h.add(subject(35, [adminRole("marketing")]));
    const first = await h.http().get(ORDERS).set(bearer(fin));
    const etag = first.headers.etag as string;
    const reads = h.rollups.reads;
    const again = await h.http().get(ORDERS).set(bearer(fin)).set("If-None-Match", etag);
    expect(again.status).toBe(304);
    expect(h.rollups.reads).toBe(reads);
    // authorization first: an unauthorised caller with the right etag still gets 403
    expect((await h.http().get(ORDERS).set(bearer(mk)).set("If-None-Match", etag)).status).toBe(403);
    h.rollups.asOfMs = NOW;
    const changed = await h.http().get(ORDERS).set(bearer(fin)).set("If-None-Match", etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it("validation: missing or unknown params, from >= to, window too large, wrong grain are 400", async () => {
    h = await createHarness();
    const fin = h.add(subject(36, [adminRole("finance")]));
    const get = async (qs: string) => (await h.http().get(`/v1/admin/metrics/platform.orders.placed?${qs}`).set(bearer(fin))).status;
    expect(await get("grain=day")).toBe(400);
    expect(await get(`${Q}&extra=1`)).toBe(400);
    expect(await get(`from=${encodeURIComponent("2026-10-19T00:00:00Z")}&to=${encodeURIComponent("2026-10-18T00:00:00Z")}&grain=day`)).toBe(400);
    expect(await get(`from=${encodeURIComponent("2026-10-01T00:00:00Z")}&to=${encodeURIComponent("2026-10-19T00:00:00Z")}&grain=hour`)).toBe(400);
    expect(await get(`from=${encodeURIComponent("2024-01-01T00:00:00Z")}&to=${encodeURIComponent("2026-10-19T00:00:00Z")}&grain=day`)).toBe(400);
    expect(await get(`${Q.replace("grain=day", "grain=year")}`)).toBe(400);
    expect(await get(`from=2026-10-18&to=2026-10-19&grain=day`)).toBe(400);
  });

  it("a metric that needs facts is 503 metric_source_unconfigured, never zeros", async () => {
    h = await createHarness();
    const ops = h.add(subject(37, [adminRole("ops")]));
    const r = await h.http().get(`/v1/admin/metrics/platform.stores.with_purchase?${Q}`).set(bearer(ops));
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).toContain("metric_source_unconfigured");
  });

  it("rollup store failure is 503", async () => {
    h = await createHarness();
    const ops = h.add(subject(38, [adminRole("ops")]));
    h.rollups.failWith = new MetricsDependencyUnavailableError("db");
    expect((await h.http().get(ORDERS).set(bearer(ops))).status).toBe(503);
  });

  it("rate limit: the 61st request in a minute is 429", async () => {
    h = await createHarness();
    const ops = h.add(subject(39, [adminRole("ops")]));
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await h.http().get(ORDERS).set(bearer(ops))).status;
    expect(last).toBe(429);
    void DAY;
  });

  it("unknown metric: ops gets the money 403, finance gets 404; non-admin gets 403 while the elevation store is down", async () => {
    h = await createHarness();
    const ops = h.add(subject(60, [adminRole("ops")]));
    const fin = h.add(subject(61, [adminRole("finance")]));
    const shopper = h.add(subject(62, [{ kind: "shopper" }]));
    const U = `/v1/admin/metrics/platform.nope?${Q}`;
    expect((await h.http().get(U).set(bearer(ops))).status).toBe((await h.http().get(GMV).set(bearer(ops))).status);
    expect((await h.http().get(U).set(bearer(fin))).status).toBe(404);
    h.fail.elevations = true;
    expect((await h.http().get(GMV).set(bearer(shopper))).status).toBe(403);
    expect((await h.http().get(GMV).set(bearer(fin))).status).toBe(503);
  });

  it("a 304 is not counted as a read", async () => {
    h = await createHarness();
    const fin = h.add(subject(63, [adminRole("finance")]));
    const first = await h.http().get(ORDERS).set(bearer(fin));
    expect(h.reads).toHaveLength(1);
    const again = await h.http().get(ORDERS).set(bearer(fin)).set("If-None-Match", first.headers.etag as string);
    expect(again.status).toBe(304);
    expect(h.reads).toHaveLength(1);
  });
});
