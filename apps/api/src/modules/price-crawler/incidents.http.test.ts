import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOKENS, bearer, createCrawlHarness, type CrawlHarness } from "./test/harness";
import { STORE_A, STORE_B, U } from "./test/fixtures";

let h: CrawlHarness;
beforeEach(async () => {
  h = await createCrawlHarness();
  const base = h.clock.nowMs();
  for (let n = 1; n <= 5; n += 1) {
    await h.store.addIncident(
      { id: U(8000 + n), targetId: null, storeId: n === 5 ? STORE_B : STORE_A, kind: n % 2 === 0 ? "ssrf_refused" : "robots_disallowed", host: "shop.example", urlHash: "c".repeat(64), detail: null, createdAtMs: base - n * 1_000 },
      [],
    );
  }
});
afterEach(async () => {
  await h.close();
});
const get = (path: string, token: string | null) => {
  const r = h.http().get(path);
  return token === null ? r : r.set(bearer(token));
};

describe("GET /v1/admin/price-crawler/incidents", () => {
  const path = "/v1/admin/price-crawler/incidents";
  it("pages with a keyset cursor and filters by kind", async () => {
    const p1 = await get(`${path}?limit=2`, TOKENS.opsAdmin);
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((i: { id: string }) => i.id)).toEqual([U(8001), U(8002)]);
    expect(JSON.stringify(p1.body)).not.toContain("url_hash");
    const p2 = await get(`${path}?limit=2&cursor=${p1.body.next_cursor as string}`, TOKENS.opsAdmin);
    expect(p2.body.items.map((i: { id: string }) => i.id)).toEqual([U(8003), U(8004)]);
    const p3 = await get(`${path}?limit=2&cursor=${p2.body.next_cursor as string}`, TOKENS.opsAdmin);
    expect(p3.body.items).toHaveLength(1);
    expect(p3.body.next_cursor).toBeNull();
    const k = await get(`${path}?kind=ssrf_refused`, TOKENS.opsAdmin);
    expect(k.body.items).toHaveLength(2);
  });
  it("rejects a malformed cursor and unknown params with 400", async () => {
    expect((await get(`${path}?cursor=!!!`, TOKENS.opsAdmin)).status).toBe(400);
    expect((await get(`${path}?cursor=AAAAAAAAAAAA`, TOKENS.opsAdmin)).status).toBe(400);
    expect((await get(`${path}?bogus=1`, TOKENS.opsAdmin)).status).toBe(400);
  });
  it("401 unauthenticated or wrong audience, 403 for a non-ops admin", async () => {
    expect((await get(path, null)).status).toBe(401);
    expect((await get(path, TOKENS.ownerA)).status).toBe(401);
    expect((await get(path, TOKENS.supportAdmin)).status).toBe(403);
  });
});

describe("GET /v1/seller/crawl-incidents", () => {
  const path = (s: string) => `/v1/seller/crawl-incidents?store_id=${s}`;
  it("returns only the caller's store rows", async () => {
    const r = await get(path(STORE_A), TOKENS.ownerA);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(4);
    expect(r.body.items.every((i: { store_id: string }) => i.store_id === STORE_A)).toBe(true);
  });
  it("another store is 404, catalog staff 403, wrong audience 401, missing store_id 400", async () => {
    expect((await get(path(STORE_A), TOKENS.ownerB)).status).toBe(404);
    expect((await get(path(STORE_A), TOKENS.catalogA)).status).toBe(403);
    expect((await get(path(STORE_A), TOKENS.ownerOnBuyerAud)).status).toBe(401);
    expect((await get(path(STORE_A), TOKENS.shopperOnSellerAud)).status).toBe(403);
    expect((await get(path(STORE_A), null)).status).toBe(401);
    expect((await get("/v1/seller/crawl-incidents", TOKENS.ownerA)).status).toBe(400);
  });
});

describe("GET /v1/seller/parity-warnings", () => {
  const path = (s: string, extra = "") => `/v1/seller/parity-warnings?store_id=${s}${extra}`;
  it("computes the 48h countdown from the open finding", async () => {
    h.parity.items.push({ skuId: U(9001), openedAtMs: h.clock.nowMs() - 47 * 3_600_000 }, { skuId: U(9002), openedAtMs: h.clock.nowMs() - 49 * 3_600_000 });
    const r = await get(path(STORE_A), TOKENS.managerA);
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ sku_id: U(9001), overdue: false, remaining_seconds: 3600 });
    expect(r.body.items[1]).toMatchObject({ sku_id: U(9002), overdue: true, remaining_seconds: 0 });
    const p1 = await get(path(STORE_A, "&limit=1"), TOKENS.ownerA);
    const p2 = await get(path(STORE_A, `&limit=1&cursor=${p1.body.next_cursor as string}`), TOKENS.ownerA);
    expect(p2.body.items[0].sku_id).toBe(U(9002));
    expect(p2.body.next_cursor).toBeNull();
    expect((await get(path(STORE_A, "&cursor=zz"), TOKENS.ownerA)).status).toBe(400);
  });
  it("authz: foreign 404, role 403, audience 401", async () => {
    expect((await get(path(STORE_A), TOKENS.ownerB)).status).toBe(404);
    expect((await get(path(STORE_A), TOKENS.catalogA)).status).toBe(403);
    expect((await get(path(STORE_A), TOKENS.ownerOnBuyerAud)).status).toBe(401);
    expect((await get(path(STORE_A), null)).status).toBe(401);
  });
});
