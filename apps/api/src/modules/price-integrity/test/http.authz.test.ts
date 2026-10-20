import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MISSING,
  PRINCIPALS,
  PRODUCT_A,
  PRODUCT_HIDDEN,
  SKU_1,
  SKU_2,
  STORE_A,
  STORE_B,
  bearer,
  createPriceIntegrityHarness,
  type PriceIntegrityHarness,
} from "./harness";

const DAY = 86_400_000;
const PROBLEM_KEYS = ["type", "title", "status", "detail", "code", "request_id", "errors"];

let h: PriceIntegrityHarness;
beforeAll(async () => {
  h = await createPriceIntegrityHarness();
  const t0 = h.clock.nowMs();
  const rec = async (sku: string, store: string, amount: bigint, at: number, key: string) => {
    // The harness clock is the service clock; record history in order by moving it.
    const delta = at - h.clock.nowMs();
    if (delta > 0) h.clock.advance(delta);
    await h.service.recordPriceChange({ skuId: sku, storeId: store, priceAmount: amount, source: "seller", actorId: null, idempotencyKey: key });
  };
  await rec(SKU_1, STORE_A, 100_000n, t0, "a1");
  await rec(SKU_1, STORE_A, 80_000n, t0 + 100 * DAY, "a2");
  await rec(SKU_2, STORE_B, 50_000n, t0 + 100 * DAY, "b1");
  // an inflated-then-cut price for store B's second sku produces a violation for B only
  await rec(SKU_2, STORE_B, 90_000n, t0 + 101 * DAY, "b2");
  await rec(SKU_2, STORE_B, 60_000n, t0 + 102 * DAY, "b3");
  h.fixtures.directory.set(PRODUCT_A, { storeId: STORE_A, skuIds: [SKU_1], active: true });
  h.fixtures.directory.set(PRODUCT_HIDDEN, { storeId: STORE_A, skuIds: [SKU_1], active: false });
});
afterAll(async () => {
  await h.close();
});

function expectProblem(body: Record<string, unknown>): void {
  for (const k of Object.keys(body)) expect(PROBLEM_KEYS).toContain(k);
}

describe("GET /v1/products/{id}/price-evidence", () => {
  const url = (id: string) => `/v1/products/${id}/price-evidence`;

  it("401 without a token, 401 with an unknown token", async () => {
    const r = await h.http().get(url(PRODUCT_A));
    expect(r.status).toBe(401);
    expectProblem(r.body as Record<string, unknown>);
    expect((await h.http().get(url(PRODUCT_A)).set(bearer("nope-nope-nope-nope-nope"))).status).toBe(401);
  });

  it("a seller-audience token is refused on the buyer route", async () => {
    const r = await h.http().get(url(PRODUCT_A)).set(bearer(PRINCIPALS.ownerA));
    expect([401, 403]).toContain(r.status);
  });

  it("suspended shopper is 403", async () => {
    expect((await h.http().get(url(PRODUCT_A)).set(bearer(PRINCIPALS.buyerSuspended))).status).toBe(403);
  });

  it("shopper sees a verified discount with evidence and no seller-private fields", async () => {
    const r = await h.http().get(url(PRODUCT_A)).set(bearer(PRINCIPALS.buyer));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-cache");
    const sku = (r.body as { skus: Record<string, unknown>[] }).skus[0];
    expect(sku).toMatchObject({
      sku_id: SKU_1,
      badge: "verified_discount",
      discount_pct: 20,
      reference_price: { amount: "100000", currency: "EGP" },
      price: { amount: "80000", currency: "EGP" },
      window_days: 30,
    });
    expect(JSON.stringify(r.body)).not.toMatch(/actor|store_id|violations/);
  });

  it("unknown and inactive products are indistinguishable 404s", async () => {
    const a = await h.http().get(url(MISSING)).set(bearer(PRINCIPALS.buyer));
    const b = await h.http().get(url(PRODUCT_HIDDEN)).set(bearer(PRINCIPALS.buyer));
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(b.body).toEqual({ ...a.body, request_id: (b.body as { request_id?: string }).request_id });
  });

  it("malformed id is a 422/400, never a lookup", async () => {
    const r = await h.http().get(url("not-a-uuid")).set(bearer(PRINCIPALS.buyer));
    expect([400, 422]).toContain(r.status);
  });
});

describe("GET /v1/seller/price-trust", () => {
  const url = "/v1/seller/price-trust";

  it("401 unauthenticated; buyer token 401/403", async () => {
    expect((await h.http().get(url)).status).toBe(401);
    expect([401, 403]).toContain((await h.http().get(url).set(bearer(PRINCIPALS.buyer))).status);
  });

  it("suspended seller, seller without grants, and token without the read scope are 403", async () => {
    expect((await h.http().get(url).set(bearer(PRINCIPALS.sellerSuspended))).status).toBe(403);
    expect((await h.http().get(url).set(bearer(PRINCIPALS.noGrants))).status).toBe(403);
    expect((await h.http().get(url).set(bearer(PRINCIPALS.noScopeA))).status).toBe(403);
  });

  it("owner A sees only store A figures", async () => {
    const r = await h.http().get(url).set(bearer(PRINCIPALS.ownerA));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ store_id: STORE_A, score: 100, band: "excellent", violations: 0, recent_actions: [] });
  });

  it("owner B sees store B's violation, not A's", async () => {
    const r = await h.http().get(url).set(bearer(PRINCIPALS.ownerB));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ store_id: STORE_B, violations: 1, score: 90 });
    expect((r.body as { recent_actions: { kind: string }[] }).recent_actions.map((a) => a.kind)).toEqual(["pre_drop_inflation"]);
  });

  it("naming another store with X-Store-Id is 403 and leaks nothing", async () => {
    const r = await h.http().get(url).set(bearer(PRINCIPALS.ownerA)).set("X-Store-Id", STORE_B);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain(STORE_B);
    expectProblem(r.body as Record<string, unknown>);
  });

  it("a multi-store seller must choose, and may choose either of their own", async () => {
    expect((await h.http().get(url).set(bearer(PRINCIPALS.multi))).status).toBe(422);
    const a = await h.http().get(url).set(bearer(PRINCIPALS.multi)).set("X-Store-Id", STORE_A);
    expect(a.body).toMatchObject({ store_id: STORE_A });
    const b = await h.http().get(url).set(bearer(PRINCIPALS.multi)).set("X-Store-Id", STORE_B);
    expect(b.body).toMatchObject({ store_id: STORE_B, violations: 1 });
  });

  it("support staff may read (read-only role), as for the catalog", async () => {
    expect((await h.http().get(url).set(bearer(PRINCIPALS.supportA))).status).toBe(200);
  });
});
