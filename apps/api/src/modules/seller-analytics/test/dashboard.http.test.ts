import { afterEach, describe, expect, it } from "vitest";
import { cairoDayStart, growth, periodWindows } from "../application/dashboard";
import { TOKENS, bearer, createAnalyticsHarness, type AnalyticsHarness } from "./harness";
import { DAY, P1, P2, SKU_M, STORE_A, STORE_B, T0, U, ev, purchase } from "./repository-contract";

let h: AnalyticsHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const hh = (): AnalyticsHarness => {
  if (h === undefined) throw new Error("harness not created");
  return h;
};
const url = (s: string, q = "period=7d") => `/v1/seller/stores/${s}/dashboard/summary?${q}`;
const get = (u: string, token: string | null = TOKENS.ownerA) => hh().http().get(u).set(token === null ? {} : bearer(token));
const on = { enabled: () => true };

async function seed(): Promise<void> {
  // Current 7d window: T0-3d (inside); previous: T0-10d (inside previous window of equal length).
  await hh().store.ingest(
    "test",
    [
      purchase(1, SKU_M, P1, 2, 10_000n, { shopper: 1, at: T0 - 3 * DAY }),
      purchase(2, SKU_M, P2, 1, 5_000n, { shopper: 2, at: T0 - 2 * DAY }),
      ev({ kind: "view", productId: P1 }, { shopper: 3, at: T0 - 2 * DAY }),
      ev({ kind: "bag", productId: P1 }, { shopper: 3, at: T0 - 2 * DAY }),
      ev({ kind: "return", productId: P1, skuId: SKU_M, qty: 1, reason: "too_small" }, { shopper: 1, at: T0 - 1 * DAY }),
      purchase(3, SKU_M, P1, 1, 4_000n, { shopper: 4, at: T0 - 10 * DAY }),
      purchase(4, SKU_M, P1, 9, 99_999n, { store: STORE_B, shopper: 5, at: T0 - 2 * DAY }),
    ],
    T0 - 1000,
  );
}

describe("period windows and growth (pure)", () => {
  it("windows are equal length and adjacent for 7d/30d, and aligned to Cairo midnight", () => {
    for (const p of ["7d", "30d"] as const) {
      const w = periodWindows(p, T0);
      expect(w.current.toMs - w.current.fromMs).toBe(w.previous.toMs - w.previous.fromMs);
      expect(w.previous.toMs).toBe(w.current.fromMs);
      expect(cairoDayStart(w.current.fromMs)).toBe(w.current.fromMs);
    }
  });
  it("today compares with the same elapsed span of yesterday", () => {
    const w = periodWindows("today", T0);
    expect(w.current.toMs - w.current.fromMs).toBe(w.previous.toMs - w.previous.fromMs);
    expect(w.current.fromMs - w.previous.fromMs).toBeGreaterThanOrEqual(23 * 3_600_000);
  });
  it("growth is null iff previous is 0, half-even in bps", () => {
    expect(growth(5n, 0n).growthBps).toBeNull();
    expect(growth(150n, 100n)).toEqual({ delta: 50n, growthBps: 5000 });
    expect(growth(50n, 100n).growthBps).toBe(-5000);
    expect(growth(0n, 100n).growthBps).toBe(-10_000);
    expect(growth(1n, 8n).growthBps).toBe(-8750);
  });
});

describe("GET /seller/stores/:storeId/dashboard/summary", () => {
  it("is 404 while the flag is blocked (default), before any data is read", async () => {
    h = await createAnalyticsHarness();
    await seed();
    const r = await get(url(STORE_A));
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain("gross_sales");
  });

  it("returns period and previous period, money as bigint strings, growth in bps, no fake KPIs", async () => {
    h = await createAnalyticsHarness({}, on);
    await seed();
    const r = await get(url(STORE_A));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.headers["etag"]).toMatch(/^"[0-9a-f]{32}"$/);
    const b = r.body;
    expect(b.current.gross_sales).toEqual({ amount_minor: "15000", currency: "EGP" });
    expect(b.current.orders).toBe(2);
    expect(b.current.units).toBe(3);
    expect(b.current.average_order_value.amount_minor).toBe("7500");
    expect(b.current.returned_units).toBe(1);
    expect(b.current.return_rate_bps).toBe(3333);
    expect(b.current.repeat_customer_rate_bps).toBeNull();
    expect(b.current.funnel).toEqual({ views: 1, bag_adds: 1, checkouts: 0, purchases: 2 });
    expect(b.current.top_products.map((p: { product_id: string }) => p.product_id)).toEqual([P1, P2]);
    expect(b.previous.gross_sales.amount_minor).toBe("4000");
    expect(b.growth.gross_sales).toEqual({ delta: { amount_minor: "11000", currency: "EGP" }, growth_bps: 27_500 });
    expect(b.daily_sales).toHaveLength(7);
    expect(b.daily_sales.reduce((n: number, d: { orders: number }) => n + d.orders, 0)).toBe(2);
    expect(b.unavailable_metrics).toEqual(expect.arrayContaining(["cancellation_rate", "cod_refusal_by_governorate", "in_transit_payouts"]));
    expect(b).not.toHaveProperty("cod_refusal");
    expect(b).not.toHaveProperty("payouts");
    expect(typeof b.data_as_of).toBe("string");
    expect(JSON.stringify(b)).not.toContain("99999");
  });

  it("growth is null when the previous period has no sales", async () => {
    h = await createAnalyticsHarness({}, on);
    await hh().store.ingest("test", [purchase(1, SKU_M, P1, 1, 1_000n, { shopper: 1, at: T0 - DAY })], T0);
    const r = await get(url(STORE_A));
    expect(r.body.previous.gross_sales.amount_minor).toBe("0");
    expect(r.body.growth.gross_sales.growth_bps).toBeNull();
    expect(r.body.growth.average_order_value).toBeNull();
  });

  it("answers 304 on a matching If-None-Match and rejects bad periods", async () => {
    h = await createAnalyticsHarness({}, on);
    await seed();
    const first = await get(url(STORE_A, "period=30d"));
    const again = await hh().http().get(url(STORE_A, "period=30d")).set({ ...bearer(TOKENS.ownerA), "If-None-Match": first.headers["etag"] as string });
    expect(again.status).toBe(304);
    expect((await get(url(STORE_A, "period=1y"))).status).toBe(400);
  });

  it("negative authorization", async () => {
    h = await createAnalyticsHarness({}, on);
    await seed();
    expect((await get(url(STORE_A), null)).status).toBe(401);
    expect((await get(url(STORE_A), TOKENS.buyerAudSeller)).status).toBe(401);
    expect([401, 403, 404]).toContain((await get(url(STORE_A), TOKENS.shopper)).status);
    expect((await get(url(STORE_A), TOKENS.noScopeA)).status).toBe(403);
    const foreign = await get(url(STORE_B));
    const missing = await get(url(U(999)));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect({ ...foreign.body, request_id: undefined }).toEqual({ ...missing.body, request_id: undefined });
    expect((await get(url(STORE_B), TOKENS.ownerA)).status).toBe(404);
    expect((await get(url(STORE_A), TOKENS.ownerB)).status).toBe(404);
    // Role without store_order read is refused (catalog staff).
    expect([403, 404]).toContain((await get(url(STORE_A), TOKENS.catalogA)).status);
    expect((await get(url(STORE_A), TOKENS.financeA)).status).toBe(200);
  });
});
