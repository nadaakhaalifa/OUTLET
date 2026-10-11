import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHZ_META, type AuthzMeta } from "../../../platform/decorators";
import { SellerAnalyticsController } from "../adapters/analytics.controller";
import type { SourceEvent } from "../domain/ports";
import { OWNER_A_ID, TOKENS, bearer, createAnalyticsHarness, type AnalyticsHarness } from "./harness";
import { DAY, P1, SKU_L, SKU_M, STORE_A, STORE_B, T0, U, ev, purchase, shopper } from "./repository-contract";

let h: AnalyticsHarness;
const base = (store: string) => `/v1/seller/stores/${store}/analytics`;
const auth = (t: string | null): Record<string, string> => (t === null ? {} : bearer(t));

interface Route {
  readonly key: string;
  readonly audience: "seller_api";
  readonly send: (token: string | null, store: string) => Test;
}
const get = (path: string): Route["send"] => (t, s) => h.http().get(`${base(s)}/${path}`).set(auth(t));
const READ_ROUTES: readonly Route[] = [
  ["GET /v1/seller/stores/:storeId/analytics/traffic", "traffic"],
  ["GET /v1/seller/stores/:storeId/analytics/funnel", "funnel"],
  ["GET /v1/seller/stores/:storeId/analytics/sales", "sales"],
  ["GET /v1/seller/stores/:storeId/analytics/sell-through", "sell-through"],
  ["GET /v1/seller/stores/:storeId/analytics/size-curve", "size-curve"],
  ["GET /v1/seller/stores/:storeId/analytics/aging", "aging"],
  ["GET /v1/seller/stores/:storeId/analytics/returns", "returns"],
  ["GET /v1/seller/stores/:storeId/analytics/search-terms", "search-terms"],
  ["GET /v1/seller/stores/:storeId/analytics/geography", "geography"],
].map(([key, path]) => ({ key: key as string, audience: "seller_api" as const, send: get(path as string) }));
const ROUTES: readonly Route[] = [
  ...READ_ROUTES,
  {
    key: "POST /v1/seller/stores/:storeId/analytics/exports",
    audience: "seller_api",
    send: (t, s) => h.http().post(`${base(s)}/exports`).set(auth(t)).send({ report: "sales" }),
  },
];

const strip = (b: Record<string, unknown>) => {
  const { request_id: _r, ...rest } = b;
  return rest;
};

const events = (): SourceEvent[] => {
  const out: SourceEvent[] = [];
  // 60 distinct Cairo shoppers, 3 Giza shoppers: Cairo is released, Giza must be suppressed.
  for (let i = 1; i <= 60; i += 1) {
    out.push(purchase(1000 + i, SKU_M, P1, 1, 10_000n, { shopper: i, gov: "Cairo" }));
    out.push(ev({ kind: "search_click", term: "linen dress" }, { shopper: i }));
    out.push(ev({ kind: "view", productId: P1, source: "feed" }, { shopper: i }));
  }
  for (let i = 100; i < 103; i += 1) {
    out.push(purchase(2000 + i, SKU_M, P1, 1, 10_000n, { shopper: i, gov: "Giza" }));
    out.push(ev({ kind: "search_click", term: "secret rare term" }, { shopper: i }));
  }
  out.push(ev({ kind: "return", productId: P1, skuId: SKU_M, qty: 2, reason: "too_small" }, { shopper: 1 }));
  out.push(
    ev({ kind: "stock_snapshot", productId: P1, skuId: SKU_M, sizeLabel: "M", onHand: 5, priceMinor: 100_000n, listedAtMs: T0 - 100 * DAY }, { shopper: null }),
    ev({ kind: "stock_snapshot", productId: P1, skuId: SKU_L, sizeLabel: "L", onHand: 20, priceMinor: 100_000n, listedAtMs: T0 - 10 * DAY }, { shopper: null }),
  );
  // Store B data that A must never see.
  out.push(purchase(9000, SKU_M, P1, 1, 777_777n, { store: STORE_B, shopper: 500, gov: "Alexandria" }));
  return out;
};

beforeAll(async () => {
  h = await createAnalyticsHarness();
  for (const e of events()) h.source.push({ messageId: e.messageId, body: e });
  const r = await h.consumer.run(500);
  expect(r.rejected).toBe(0);
  expect(r.applied).toBe(events().length);
}, 30_000);
afterAll(async () => {
  await h.close();
});

describe("route coverage", () => {
  it("every controller route is in the matrix and declares seller-audience authorization", () => {
    const proto = SellerAnalyticsController.prototype as unknown as Record<string, unknown>;
    const METHODS: Record<number, string> = { [RequestMethod.GET]: "GET", [RequestMethod.POST]: "POST" };
    const found: string[] = [];
    for (const name of Object.getOwnPropertyNames(SellerAnalyticsController.prototype)) {
      const fn = proto[name];
      if (typeof fn !== "function") continue;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      if (method === undefined) continue;
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
      const meta = Reflect.getMetadata(AUTHZ_META, fn) as AuthzMeta | undefined;
      expect(meta?.kind, `${name} must declare resource authorization`).toBe("resource");
      if (meta?.kind === "resource") expect(meta.audience).toBe("seller_api");
      found.push(`${METHODS[method]} /v1/seller/stores/:storeId/analytics/${path}`);
    }
    expect(found.sort()).toEqual(ROUTES.map((r) => r.key).sort());
  });
});

describe.each(ROUTES.map((r) => [r.key, r] as const))("%s", (_k, route) => {
  it("is 401 without a token, with a junk token and with the buyer audience", async () => {
    expect((await route.send(null, STORE_A)).status).toBe(401);
    expect((await route.send("not-a-real-token-0000000000", STORE_A)).status).toBe(401);
    expect((await route.send(TOKENS.buyerAudSeller, STORE_A)).status).toBe(401);
  });
  it("is 403 for a suspended seller, a shopper grant and a token without scope", async () => {
    expect((await route.send(TOKENS.suspendedA, STORE_A)).status).toBe(403);
    expect((await route.send(TOKENS.shopper, STORE_A)).status).toBe(403);
    expect((await route.send(TOKENS.noScopeA, STORE_A)).status).toBe(403);
  });
  it("CROSS-TENANT: another seller's store is 404, byte-identical to a missing store, and leaks no data", async () => {
    const foreign = await route.send(TOKENS.ownerB, STORE_A);
    const missing = await route.send(TOKENS.ownerB, U(424_242));
    const malformed = await route.send(TOKENS.ownerB, "not-a-uuid");
    expect([foreign.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
    expect(strip(foreign.body)).toEqual(strip(missing.body));
    expect(JSON.stringify(foreign.body)).not.toContain("Cairo");
  });
  it("CROSS-TENANT: store A's owner cannot read store B", async () => {
    expect((await route.send(TOKENS.ownerA, STORE_B)).status).toBe(404);
  });
  it("a catalog role is 403 (no analytics function)", async () => {
    expect((await route.send(TOKENS.catalogA, STORE_A)).status).toBe(403);
  });
});

describe("export authorization is narrower than reads", () => {
  it("finance can read dashboards but cannot export; owner and manager can", async () => {
    expect((await h.http().get(`${base(STORE_A)}/sales`).set(bearer(TOKENS.financeA))).status).toBe(200);
    expect((await h.http().post(`${base(STORE_A)}/exports`).set(bearer(TOKENS.financeA)).send({ report: "sales" })).status).toBe(403);
    expect((await h.http().post(`${base(STORE_A)}/exports`).set(bearer(TOKENS.managerA)).send({ report: "sales" })).status).toBe(200);
  });
});

describe("read models", () => {
  it("sales: GMV, commission, net, AOV and gated repeat rate", async () => {
    const r = await h.http().get(`${base(STORE_A)}/sales`).set(bearer(TOKENS.ownerA));
    expect(r.status).toBe(200);
    expect(r.body.gmv).toEqual({ amount_minor: "630000", currency: "EGP" });
    expect(r.body.commission.amount_minor).toBe("63000");
    expect(r.body.net.amount_minor).toBe("567000");
    expect(r.body.orders).toBe(63);
    expect(r.body.repeat_rate_bps).toBe(0);
    expect(r.body.repeat_rate_suppressed).toBe(false); // 63 distinct shoppers >= 50
    expect(r.body.meta.freshness).toMatchObject({ slo_ms: 900_000 });
    expect(r.body.meta.store_id).toBe(STORE_A);
  });
  it("freshness metadata is present and honest", async () => {
    const r = await h.http().get(`${base(STORE_A)}/traffic`).set(bearer(TOKENS.ownerA));
    expect(r.body.meta.freshness.as_of).toBe(new Date(T0 - DAY).toISOString());
    expect(r.body.meta.freshness.within_slo).toBe(true);
    h.clock.advance(20 * 60_000);
    const stale = await h.http().get(`${base(STORE_A)}/traffic`).set(bearer(TOKENS.ownerA));
    expect(stale.body.meta.freshness.within_slo).toBe(false);
    h.clock.advance(-20 * 60_000);
  });
  it("traffic and funnel", async () => {
    const t = await h.http().get(`${base(STORE_A)}/traffic`).set(bearer(TOKENS.ownerA));
    expect(t.body.product_views).toBe(60);
    expect(t.body.unique_visitors).toBe(60);
    expect(t.body.by_source.items).toEqual([{ key: "feed", events: 60 }]);
    const f = await h.http().get(`${base(STORE_A)}/funnel?product_id=${P1}`).set(bearer(TOKENS.ownerA));
    expect(f.body.total.steps.map((s: { count: number }) => s.count)).toEqual([0, 60, 0, 0, 0, 63]);
  });
  it("sell-through, size curve and aging with a markdown that never claims % off", async () => {
    const st = await h.http().get(`${base(STORE_A)}/sell-through`).set(bearer(TOKENS.ownerA));
    const m = st.body.skus.find((s: { size: string }) => s.size === "M");
    expect(m).toMatchObject({ sold_units: 63, on_hand: 5, sell_through_bps: 9265 });
    const sc = await h.http().get(`${base(STORE_A)}/size-curve?size_order=S,M,L`).set(bearer(TOKENS.ownerA));
    expect(sc.body.products[0].rows.map((r: { size: string }) => r.size)).toEqual(["M", "L"]);
    const ag = await h.http().get(`${base(STORE_A)}/aging`).set(bearer(TOKENS.ownerA));
    expect(ag.body.alerts).toHaveLength(1); // M is 100 days old; L is 10 days
    const a = ag.body.alerts[0];
    expect(a.severity).toBe("critical");
    expect(a.markdown_recommendation.shows_percent_off).toBe(false);
    expect(a.markdown_recommendation.notice.en).toMatch(/will NOT show a % off/);
  });
  it("returns per SKU with rate and reasons", async () => {
    const r = await h.http().get(`${base(STORE_A)}/returns`).set(bearer(TOKENS.ownerA));
    expect(r.body.skus).toEqual([
      expect.objectContaining({ sku_id: SKU_M, returned_units: 2, sold_units: 63, return_rate_bps: 317, reasons: [{ reason: "too_small", units: 2 }] }),
    ]);
  });
  it("rejects an invalid or oversized range", async () => {
    const q = `from=${new Date(T0).toISOString()}&to=${new Date(T0 - DAY).toISOString()}`;
    expect((await h.http().get(`${base(STORE_A)}/sales?${q}`).set(bearer(TOKENS.ownerA))).status).toBe(400);
    const big = `from=${new Date(T0 - 400 * DAY).toISOString()}&to=${new Date(T0).toISOString()}`;
    expect((await h.http().get(`${base(STORE_A)}/sales?${big}`).set(bearer(TOKENS.ownerA))).status).toBe(400);
    expect((await h.http().get(`${base(STORE_A)}/sales?unknown=1`).set(bearer(TOKENS.ownerA))).status).toBe(400);
  });
});

describe("privacy rules", () => {
  it("geography releases only cells with >= 50 distinct shoppers and hides the rest", async () => {
    const r = await h.http().get(`${base(STORE_A)}/geography`).set(bearer(TOKENS.ownerA));
    expect(r.body.governorates.map((g: { governorate: string }) => g.governorate)).toEqual(["Cairo"]);
    expect(r.body.suppressed_governorates).toBe(1);
    expect(JSON.stringify(r.body)).not.toContain("Giza");
    expect(JSON.stringify(r.body)).not.toContain("distinct");
  });
  it("search terms: a term typed by < 50 shoppers never appears", async () => {
    const r = await h.http().get(`${base(STORE_A)}/search-terms`).set(bearer(TOKENS.ownerA));
    expect(r.body.terms).toEqual([{ term: "linen dress", clicks: 60 }]);
    expect(JSON.stringify(r.body)).not.toContain("secret rare term");
  });
  it("no response from any route contains a shopper key or a forbidden field name", async () => {
    const bodies: string[] = [];
    for (const route of ROUTES) {
      const r = await route.send(TOKENS.ownerA, STORE_A);
      expect(r.status).toBe(200);
      bodies.push(JSON.stringify(r.body));
    }
    const all = bodies.join("\n");
    for (let i = 1; i <= 60; i += 1) expect(all).not.toContain(shopper(i));
    expect(all).not.toMatch(/shopper_key|shopperKey|user_id|measure|budget|waist|bust|hip_cm|device/i);
  });
  it("the sales repeat rate is withheld below 50 shoppers", async () => {
    const r = await h
      .http()
      .get(`${base(STORE_B)}/sales`)
      .set(bearer(TOKENS.ownerB));
    expect(r.status).toBe(200);
    expect(r.body.repeat_rate_bps).toBeNull();
    expect(r.body.repeat_rate_suppressed).toBe(true);
  });
  it("ingest drops events that try to carry measurements, budget or user ids", async () => {
    h.source.push(
      { messageId: U(900_001), body: { ...ev({ kind: "view", productId: P1 }), measurements: { waist: 70 } } },
      { messageId: U(900_002), body: { ...ev({ kind: "view", productId: P1 }), budget_minor: "5000" } },
      { messageId: U(900_003), body: { ...ev({ kind: "view", productId: P1 }), user_id: U(1) } },
    );
    const r = await h.consumer.run(10);
    expect(r).toMatchObject({ applied: 0, rejected: 3 });
  });
});

describe("CSV export", () => {
  it("is watermarked with the seller id and audit-logged with the actor", async () => {
    const before = h.audit.entries.length;
    const r = await h.http().post(`${base(STORE_A)}/exports`).set(bearer(TOKENS.ownerA)).send({ report: "geography" });
    expect(r.status).toBe(200);
    expect(r.body.csv).toContain(`# seller_id: ${STORE_A}`);
    expect(r.body.csv).toContain(`# watermark: ${r.body.watermark}`);
    const lines = (r.body.csv as string).split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(lines.slice(1).every((l) => l.endsWith(`,${STORE_A},${r.body.watermark}`))).toBe(true);
    expect(r.body.csv).not.toContain("Giza");
    expect(r.body.csv).not.toContain("Alexandria");
    expect(h.audit.entries).toHaveLength(before + 1);
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "seller_analytics.export",
      actorId: OWNER_A_ID,
      storeId: STORE_A,
      report: "geography",
      watermark: r.body.watermark,
      rowCount: 1,
    });
  });
  it("fails closed (no content) when the audit trail is unavailable", async () => {
    h.audit.failing = true;
    const r = await h.http().post(`${base(STORE_A)}/exports`).set(bearer(TOKENS.ownerA)).send({ report: "sales" });
    h.audit.failing = false;
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(r.body)).not.toContain("# seller_id");
  });
  it("rejects unknown reports and extra body fields", async () => {
    expect((await h.http().post(`${base(STORE_A)}/exports`).set(bearer(TOKENS.ownerA)).send({ report: "shoppers" })).status).toBe(400);
    expect((await h.http().post(`${base(STORE_A)}/exports`).set(bearer(TOKENS.ownerA)).send({ report: "sales", store_id: STORE_B })).status).toBe(400);
  });
});
