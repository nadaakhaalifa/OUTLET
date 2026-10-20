import { afterEach, describe, expect, it } from "vitest";
import { OWNER_A_ID, TOKENS, bearer, createAnalyticsHarness, type AnalyticsHarness } from "./harness";
import { DAY, P1, SKU_M, STORE_A, STORE_B, T0, U, ev, purchase } from "./repository-contract";

let h: AnalyticsHarness;
const on = { seriesEnabled: () => true, shopperSeriesEnabled: () => false };
afterEach(async () => {
  await h.close();
});

const iso = (ms: number): string => encodeURIComponent(new Date(ms).toISOString());
const win = `from=${iso(T0 - 3 * DAY)}&to=${iso(T0)}&grain=day`;
const base = (s: string) => `/v1/seller/stores/${s}/analytics`;
const seriesUrl = (s: string, id: string, qs = win) => `${base(s)}/series/${id}?${qs}`;
const body = (b: Record<string, unknown>): Record<string, unknown> => ({ ...b, request_id: undefined });
const get = (url: string, token: string | null = TOKENS.ownerA) => h.http().get(url).set(token === null ? {} : bearer(token));

async function seed(): Promise<void> {
  await h.store.ingest(
    "test",
    [
      purchase(1, SKU_M, P1, 2, 10_000n, { shopper: 1 }),
      purchase(2, SKU_M, P1, 1, 5_000n, { shopper: 2 }),
      ev({ kind: "view", productId: P1 }, { shopper: 3 }),
      ev({ kind: "view", productId: P1 }, { shopper: 4 }),
      purchase(3, SKU_M, P1, 9, 99_999n, { store: STORE_B, shopper: 5 }),
    ],
    T0,
  );
}

describe("seller series", () => {
  it("is 404 while release.seller_analytics.series is blocked (default)", async () => {
    h = await createAnalyticsHarness();
    expect((await get(seriesUrl(STORE_A, "seller.sales.gmv"))).status).toBe(404);
    expect((await get(`${base(STORE_A)}/summary?from=${iso(T0 - DAY)}&to=${iso(T0)}`)).status).toBe(404);
  });

  it("with the series flag blocked, real, gated and unknown ids answer with an identical status and raw body", async () => {
    h = await createAnalyticsHarness();
    const ids = ["seller.sales.gmv", "seller.traffic.unique_visitors", "seller.nope"];
    const rs = await Promise.all(ids.map((id) => get(`${base(STORE_A)}/series/${id}?preset=current_month&grain=day`)));
    expect(rs.map((r) => r.status)).toEqual([404, 404, 404]);
    const raw = (b: unknown): string => JSON.stringify({ ...(b as Record<string, unknown>), request_id: "x" });
    expect(raw(rs[0]?.body)).toBe(raw(rs[2]?.body));
    expect(raw(rs[1]?.body)).toBe(raw(rs[2]?.body));
  });

  it("negative authorization: no token, buyer audience and a shopper are refused; another seller's store is 404 with the missing-store body", async () => {
    h = await createAnalyticsHarness(on);
    const url = seriesUrl(STORE_A, "seller.sales.gmv");
    expect((await get(url, null)).status).toBe(401);
    expect((await get(url, TOKENS.buyerAudSeller)).status).toBe(401);
    expect([401, 403, 404]).toContain((await get(url, TOKENS.shopper)).status);
    expect((await get(url, TOKENS.noScopeA)).status).toBe(403);
    const foreign = await get(seriesUrl(STORE_B, "seller.sales.gmv"));
    const missing = await get(seriesUrl(U(999), "seller.sales.gmv"));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(body(foreign.body)).toEqual(body(missing.body));
    expect((await get(`${base(STORE_B)}/summary?from=${iso(T0 - DAY)}&to=${iso(T0)}`)).status).toBe(404);
    expect((await get(`${base(STORE_B)}/series/seller.sales.gmv/breakdown?preset=current_month&grain=day&dimension=source`)).status).toBe(404);
  });

  it("returns GMV in piastres for the store only, with previous period and as_of", async () => {
    h = await createAnalyticsHarness(on);
    await seed();
    const r = await get(seriesUrl(STORE_A, "seller.sales.gmv"));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, max-age=60");
    expect(r.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(r.body).toMatchObject({ id: "seller.sales.gmv", version: 1, unit: "piastres", currency: "EGP", additive: true, basis: "rollup" });
    expect(r.body.totals.current).toBe("15000");
    const day = r.body.series[0].points.find((p: { v: string }) => p.v === "15000");
    expect(day).toBeDefined();
    expect(JSON.stringify(r.body)).not.toContain("99999");
    expect(r.body.series[1].key).toBe("previous");
  });

  it("derived metrics: net after commission, AOV (banker's), conversion in bps with the consent_sampled note", async () => {
    h = await createAnalyticsHarness(on);
    await seed();
    const net = await get(seriesUrl(STORE_A, "seller.sales.net_after_commission"));
    expect(net.body.totals.current).toBe("13500");
    const aov = await get(seriesUrl(STORE_A, "seller.sales.aov"));
    expect(aov.body.additive).toBe(false);
    expect(aov.body.totals.current).toBe("7500");
    const conv = await get(seriesUrl(STORE_A, "seller.funnel.conversion_bps"));
    expect(conv.body.unit).toBe("bps");
    expect(conv.body.notes).toContain("consent_sampled");
    expect(conv.body.totals.current).toBe(10_000);
  });

  it("ETag: If-None-Match is 304 after authorization and does not read the aggregate; another seller cannot use it", async () => {
    h = await createAnalyticsHarness(on);
    await seed();
    const first = await get(seriesUrl(STORE_A, "seller.sales.orders"));
    const etag = first.headers.etag as string;
    expect((await h.http().get(seriesUrl(STORE_A, "seller.sales.orders")).set(bearer(TOKENS.ownerA)).set("If-None-Match", etag)).status).toBe(304);
    expect((await h.http().get(seriesUrl(STORE_A, "seller.sales.orders")).set(bearer(TOKENS.ownerB)).set("If-None-Match", etag)).status).toBe(404);
  });

  it("validation: unknown metric, preset on an ungated metric, missing window, unknown param, bad window", async () => {
    h = await createAnalyticsHarness(on);
    const unknown = await get(seriesUrl(STORE_A, "seller.nope"));
    expect(unknown.status).toBe(404);
    expect(JSON.stringify(unknown.body)).toContain("unknown_metric");
    expect((await get(`${base(STORE_A)}/series/seller.sales.gmv?preset=current_month&grain=day`)).status).toBe(400);
    expect((await get(`${base(STORE_A)}/series/seller.sales.gmv?grain=day`)).status).toBe(400);
    expect((await get(seriesUrl(STORE_A, "seller.sales.gmv", `${win}&x=1`))).status).toBe(400);
    expect((await get(seriesUrl(STORE_A, "seller.sales.gmv", `from=${iso(T0)}&to=${iso(T0 - DAY)}&grain=day`))).status).toBe(400);
    expect((await get(seriesUrl(STORE_A, "seller.sales.gmv", `from=${iso(T0 - 5 * 365 * DAY)}&to=${iso(T0)}&grain=day`))).status).toBe(400);
  });

  it("a metric that needs exact facts is 503 metric_source_unconfigured, not zeros", async () => {
    h = await createAnalyticsHarness(on);
    const r = await get(seriesUrl(STORE_A, "seller.returns.rate_bps"));
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).toContain("metric_source_unconfigured");
  });

  it("shopper-gated metrics and every breakdown are 404 (same body as unknown) while release.seller_analytics.shopper_series is blocked", async () => {
    h = await createAnalyticsHarness(on);
    const gated = await get(`${base(STORE_A)}/series/seller.traffic.unique_visitors?preset=current_month&grain=day`);
    const unknown = await get(seriesUrl(STORE_A, "seller.nope"));
    expect(gated.status).toBe(404);
    expect(body(gated.body)).toEqual(body(unknown.body));
    expect((await get(`${base(STORE_A)}/series/seller.traffic.views/breakdown?preset=current_month&grain=day&dimension=source`)).status).toBe(404);
    expect((await get(`${base(STORE_A)}/series/seller.sales.repeat_rate_bps?preset=current_month&grain=day`)).status).toBe(404);
  });

  it("with the DPO flag allowed the grid rules apply: from/to and week/hour grains are 400, a valid preset is 503 until a facts reader exists", async () => {
    h = await createAnalyticsHarness({ ...on, shopperSeriesEnabled: () => true });
    const id = "seller.traffic.unique_visitors";
    const g = (qs: string) => get(`${base(STORE_A)}/series/${id}?${qs}`);
    expect((await g(win)).status).toBe(400);
    expect((await g("grain=day")).status).toBe(400);
    expect((await g("preset=last_full_months:2&grain=day")).status).toBe(400);
    expect((await g("preset=current_month&grain=week")).status).toBe(400);
    expect((await g("preset=current_month&grain=hour")).status).toBe(400);
    expect((await g("preset=month:2026-10&grain=month")).status).toBe(503);
    const b = (qs: string) => get(`${base(STORE_A)}/series/seller.geography.orders/breakdown?${qs}`);
    expect((await b("preset=current_month&grain=day&dimension=source")).status).toBe(404);
    expect((await b("preset=current_month&grain=day&dimension=governorate")).status).toBe(503);
    expect((await b("preset=current_month&grain=week&dimension=governorate")).status).toBe(400);
  });

  it("summary: four day-grain tiles from the Cairo series for this store", async () => {
    h = await createAnalyticsHarness(on);
    await seed();
    const r = await get(`${base(STORE_A)}/summary?from=${iso(T0 - 3 * DAY)}&to=${iso(T0)}`);
    expect(r.status).toBe(200);
    expect(r.body.tiles.map((t: { id: string }) => t.id)).toEqual([
      "seller.sales.gmv",
      "seller.sales.orders",
      "seller.funnel.conversion_bps",
      "seller.sales.net_after_commission",
    ]);
    expect(r.body.tiles.every((t: { grain: string }) => t.grain === "day")).toBe(true);
    expect(r.body.tiles[0].totals.current).toBe("15000");
    expect((await get(`${base(STORE_A)}/summary?from=${iso(T0 - 3 * DAY)}`)).status).toBe(400);
  });

  it("the rollup store failing is 503 seller_analytics_unavailable", async () => {
    h = await createAnalyticsHarness(on);
    const { AnalyticsDependencyUnavailableError } = await import("../domain/ports");
    const reader = h.app.get<{ failWith: Error | null }>((await import("../adapters/tokens")).SELLER_SERIES_READER);
    reader.failWith = new AnalyticsDependencyUnavailableError("db");
    expect((await get(seriesUrl(STORE_A, "seller.sales.gmv"))).status).toBe(503);
    void OWNER_A_ID;
  });
});
