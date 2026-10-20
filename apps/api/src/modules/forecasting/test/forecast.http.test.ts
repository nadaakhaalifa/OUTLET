import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHZ_META, type AuthzMeta } from "../../../platform/decorators";
import { SellerForecastController } from "../adapters/forecast.controller";
import { AS_OF, SKU_L, SKU_M, STORE_A, STORE_B, U, seriesRows } from "./fixtures";
import { TOKENS, bearer, createForecastHarness, type ForecastHarness } from "./harness";

let h: ForecastHarness;
const url = (store: string, qs = ""): string => `/v1/seller/stores/${store}/forecasts${qs}`;

const strip = (b: Record<string, unknown>) => {
  const { request_id: _r, ...rest } = b;
  return rest;
};

beforeAll(async () => {
  h = await createForecastHarness();
  const ing = await h.ingest.execute([
    ...seriesRows({ sku: SKU_M, size: "M", base: 5, seed: 11 }),
    ...seriesRows({ sku: SKU_L, size: "L", base: 3, seed: 12 }),
    // A SKU with almost no history: must come back without numbers.
    ...seriesRows({ sku: U(30), size: "S", base: 0.04, seed: 77, category: "scarves" }),
    // Store B data that A must never see.
    ...seriesRows({ store: STORE_B, sku: U(99), base: 9, seed: 5, category: "secret-line" }),
  ]);
  expect(ing.rejected).toBe(0);
  const res = await h.batch.execute(AS_OF, 10);
  expect(res).toMatchObject({ completed: 2, failed: 0 });
}, 30_000);
afterAll(async () => {
  await h.close();
});

describe("route coverage", () => {
  it("every controller route declares seller-audience resource authorization", () => {
    const proto = SellerForecastController.prototype as unknown as Record<string, unknown>;
    const found: string[] = [];
    for (const name of Object.getOwnPropertyNames(SellerForecastController.prototype)) {
      const fn = proto[name];
      if (typeof fn !== "function") continue;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      if (method === undefined) continue;
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
      const meta = Reflect.getMetadata(AUTHZ_META, fn) as AuthzMeta | undefined;
      expect(meta?.kind).toBe("resource");
      if (meta?.kind === "resource") expect(meta.audience).toBe("seller_api");
      found.push(`${method === RequestMethod.GET ? "GET" : "OTHER"} ${path}`);
    }
    expect(found).toEqual(["GET /"]);
  });
});

describe("GET /v1/seller/stores/:storeId/forecasts authorization", () => {
  const get = (t: string | null, store: string, qs = "") =>
    h.http().get(url(store, qs)).set(t === null ? {} : bearer(t));

  it("is 401 without a token, with a junk token and with the buyer audience", async () => {
    expect((await get(null, STORE_A)).status).toBe(401);
    expect((await get("not-a-real-token-0000000000", STORE_A)).status).toBe(401);
    expect((await get(TOKENS.buyerAudSeller, STORE_A)).status).toBe(401);
  });
  it("is 403 for a suspended seller, a shopper grant, a token without scope and roles without inventory access", async () => {
    for (const t of [TOKENS.suspendedA, TOKENS.shopper, TOKENS.noScopeA, TOKENS.financeA, TOKENS.supportA]) {
      expect((await get(t, STORE_A)).status).toBe(403);
    }
  });
  it("CROSS-TENANT: another seller's store is 404, byte-identical to a missing store, and leaks nothing", async () => {
    const foreign = await get(TOKENS.ownerB, STORE_A);
    const missing = await get(TOKENS.ownerB, U(424_242));
    const malformed = await get(TOKENS.ownerB, "not-a-uuid");
    expect([foreign.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
    expect(strip(foreign.body)).toEqual(strip(missing.body));
    expect(JSON.stringify(foreign.body)).not.toContain("dresses");
  });
  it("CROSS-TENANT: store A's owner cannot read store B, and cannot see B's categories through A", async () => {
    expect((await get(TOKENS.ownerA, STORE_B)).status).toBe(404);
    const own = await get(TOKENS.ownerA, STORE_A);
    expect(JSON.stringify(own.body)).not.toContain("secret-line");
  });
  it("owner, manager, warehouse and catalog may read", async () => {
    for (const t of [TOKENS.ownerA, TOKENS.managerA, TOKENS.warehouseA, TOKENS.catalogA]) {
      expect((await get(t, STORE_A)).status).toBe(200);
    }
  });
  it("rejects unknown query parameters and bad enum values", async () => {
    expect((await get(TOKENS.ownerA, STORE_A, "?unknown=1")).status).toBe(400);
    expect((await get(TOKENS.ownerA, STORE_A, "?scope=everything")).status).toBe(400);
    expect((await get(TOKENS.ownerA, STORE_A, "?horizon_days=9")).status).toBe(400);
    expect((await get(TOKENS.ownerA, STORE_A, "?limit=0")).status).toBe(400);
    expect((await get(TOKENS.ownerA, STORE_A, "?limit=500")).status).toBe(400);
  });
});

describe("response contract", () => {
  const body = async (qs = "") => (await h.http().get(url(STORE_A, qs)).set(bearer(TOKENS.ownerA))).body;

  it("serves an interval, never a bare point estimate, and says it is advice only", async () => {
    const b = await body("?scope=category&scope_key=dresses");
    expect(b.advice_only).toBe(true);
    expect(b.notice.en).toMatch(/will not show a % off unless it is verified/);
    expect(b.items.map((i: { horizon_days: number }) => i.horizon_days)).toEqual([7, 14, 28]);
    for (const i of b.items) {
      expect(i.status).toBe("ok");
      expect(Object.keys(i.interval).sort()).toEqual(["nominal_coverage_bps", "p10", "p50", "p90"]);
      expect(i.interval.p10 <= i.interval.p50 && i.interval.p50 <= i.interval.p90).toBe(true);
      for (const k of Object.keys(i)) expect(k).not.toMatch(/^(point|forecast|expected|value|units|prediction)/);
    }
    expect(b.stale).toBe(false);
    expect(b.as_of_date).toBe(AS_OF);
  });

  it("an insufficient-history cell has a reason and no numbers anywhere", async () => {
    const b = await body("?scope=sku&scope_key=" + U(30));
    expect(b.items).toHaveLength(3);
    for (const i of b.items) {
      expect(i.status).toBe("insufficient_history");
      expect(i.reason_codes).toEqual(["units_below_minimum"]);
      expect(i).not.toHaveProperty("interval");
      expect(JSON.stringify(i)).not.toMatch(/p10|p50|p90/);
    }
  });

  it("a governorate cell below k=50 is suppressed with no numbers", async () => {
    const b = await body("?scope=category_governorate&horizon_days=7");
    const cairo = b.items.find((i: { scope_key: string }) => i.scope_key === "dresses|Cairo");
    expect(cairo.status).toBe("suppressed");
    expect(cairo).not.toHaveProperty("interval");
  });

  it("size medians sum to the category median", async () => {
    const cat = await body("?scope=category&scope_key=dresses&horizon_days=28");
    const sizes = await body("?scope=category_size&horizon_days=28");
    const total = sizes.items
      .filter((i: { scope_key: string }) => i.scope_key.startsWith("dresses|"))
      .reduce((s: number, i: { interval: { p50: number } }) => s + i.interval.p50, 0);
    expect(total).toBe(cat.items[0].interval.p50);
  });

  it("paginates with has_more and a limit", async () => {
    const b = await body("?limit=2");
    expect(b.items).toHaveLength(2);
    expect(b.has_more).toBe(true);
  });

  it("flags stale after the tolerance and answers 503 when the kill switch is off", async () => {
    h.clock.advance(37 * 3_600_000);
    expect((await body()).stale).toBe(true);
    h.clock.advance(-37 * 3_600_000);
    h.flags.set(false);
    const r = await h.http().get(url(STORE_A)).set(bearer(TOKENS.ownerA));
    expect(r.status).toBe(503);
    h.flags.set(true);
  });
});
