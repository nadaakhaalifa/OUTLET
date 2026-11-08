import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KillSwitchPort } from "../src/platform/deps.js";
import { DB_MARKET, DEVICE, T0, createTestApp } from "./harness.js";
import type { TestApp } from "./harness.js";

const DAY_MS = 86_400_000;
const headers = { "x-device-id": DEVICE };
const json = (r: { body: string }): Record<string, unknown> => JSON.parse(r.body) as Record<string, unknown>;
const items = (r: { body: string }): Record<string, unknown>[] => json(r).items as Record<string, unknown>[];

const state = { killed: false };
const killSwitches: KillSwitchPort = { isKilled: () => Promise.resolve(state.killed) };

let t: TestApp;
let skuA: string;
beforeAll(async () => {
  t = await createTestApp({ killSwitches });
  skuA = ((await t.raw.query<{ id: string }>("SELECT id FROM skus WHERE product_id = $1", [t.seed.productA])).rows[0] as { id: string }).id;
});
afterAll(async () => {
  await t.close();
});

const get = (url: string) => t.inject({ method: "GET", url, headers });

const putHistory = async (sku: string, steps: readonly { price: number; daysAgo: number }[]): Promise<void> => {
  // Oldest first; every row but the last is closed by the next row's start (price_events is append-only).
  for (const [i, s] of steps.entries()) {
    const next = steps[i + 1];
    await t.raw.query(
      `INSERT INTO price_events (id, sku_id, market_id, currency, price_minor, valid_from, valid_to, source, actor_type) VALUES ($1,$2,$3,'EGP',$4,$5,$6,'internal','system')`,
      [randomUUID(), sku, DB_MARKET, s.price, new Date(T0 - s.daysAgo * DAY_MS), next === undefined ? null : new Date(T0 - next.daysAgo * DAY_MS)],
    );
  }
};

describe("GET /v1/{market}/stores", () => {
  it("lists published stores in slug order with a keyset cursor, ETag and the 60 s cache policy", async () => {
    const a = await get("/v1/eg/stores?limit=1");
    expect(a.statusCode).toBe(200);
    expect(a.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=300");
    expect(a.headers.etag).toBeDefined();
    const first = items(a);
    expect(first.map((s) => s.slug)).toEqual(["store-a"]);
    expect(first[0]).toMatchObject({ kind: "local", live_drop: false, art: null, canonical_path: "/eg/stores/store-a" });
    const cursor = json(a).next_cursor as string;
    expect(cursor).toEqual(expect.any(String));
    const b = await get(`/v1/eg/stores?limit=1&cursor=${cursor}`);
    expect(items(b).map((s) => s.slug)).toEqual(["store-b"]);
    expect(json(b).next_cursor).toBeNull();
  });

  it("filters by world, name substring (LIKE metacharacters are literal) and category", async () => {
    expect(items(await get("/v1/eg/stores?world=global"))).toEqual([]);
    expect(items(await get("/v1/eg/stores?world=local")).length).toBe(2);
    expect(items(await get("/v1/eg/stores?q=STORE-B")).map((s) => s.slug)).toEqual(["store-b"]);
    expect(items(await get("/v1/eg/stores?q=%25"))).toEqual([]);
    // Only store A has a published listing in the seeded category.
    expect(items(await get(`/v1/eg/stores?category_id=${t.seed.categoryId}`)).map((s) => s.slug)).toEqual(["store-a"]);
  });

  it("rejects an oversized limit and a forged cursor", async () => {
    expect((await get("/v1/eg/stores?limit=51")).statusCode).toBe(400);
    expect((await get(`/v1/eg/stores?cursor=${Buffer.from("DROP TABLE").toString("base64url")}`)).statusCode).toBe(422);
  });
});

describe("GET /v1/{market}/categories", () => {
  it("returns the market tree in path order with both labels and honours Accept-Language", async () => {
    const ar = await get("/v1/eg/categories?limit=50");
    expect(ar.statusCode).toBe(200);
    expect(ar.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=300");
    const list = items(ar);
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((c) => c.path)).toEqual([...list.map((c) => c.path as string)].sort());
    expect(list[0]).toMatchObject({ name: list[0]?.name_ar });
    const en = await t.inject({ method: "GET", url: "/v1/eg/categories?limit=50", headers: { ...headers, "accept-language": "en-US,en;q=0.9" } });
    const first = items(en)[0];
    expect(first?.name).toBe(first?.name_en ?? first?.name_ar);
  });
});

describe("GET /v1/{market}/products/{product_id}", () => {
  it("serves the published listing with seller legal identity, defect card and never a stale cache", async () => {
    const r = await get(`/v1/eg/products/${t.seed.productA}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const b = json(r);
    expect(b.status).toBe("PUBLISHED");
    expect((b.store as { legal_identity: unknown }).legal_identity).toMatchObject({ commercial_register_no: "CR-A", tax_card_no: "TX-A" });
    expect(b.defect_card).not.toBeNull();
    expect((b.skus as { price: { claim_type: string } }[])[0]?.price.claim_type).toBe("plain");
  });

  it("is 404 once the listing is no longer published (paused or sold out), and for a malformed id it is 400", async () => {
    await t.raw.query("UPDATE catalog_public_listings SET status = 'PAUSED' WHERE id = $1", [t.seed.productA]);
    expect((await get(`/v1/eg/products/${t.seed.productA}`)).statusCode).toBe(404);
    await t.raw.query("UPDATE catalog_public_listings SET status = 'SOLD_OUT' WHERE id = $1", [t.seed.productA]);
    expect((await get(`/v1/eg/products/${t.seed.productA}`)).statusCode).toBe(404);
    await t.raw.query("UPDATE catalog_public_listings SET status = 'PUBLISHED' WHERE id = $1", [t.seed.productA]);
    expect((await get("/v1/eg/products/not-a-uuid")).statusCode).toBe(400);
  });
});

describe("GET /v1/{market}/stores/{slug}/products quick-view fields", () => {
  it("adds the real condition label and colour columns, nothing invented", async () => {
    const r = await get(`/v1/eg/stores/${t.seed.slugA}/products?limit=5`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const card = items(r)[0];
    expect(typeof card?.condition_label_ar).toBe("string");
    expect(card).toMatchObject({ colour_code: "black", price: { claim_type: "plain" } });
    expect(card).not.toHaveProperty("warranty_months");
  });
});

describe("GET /v1/{market}/deals", () => {
  const dealIds = async (q = ""): Promise<string[]> => items(await get(`/v1/eg/deals${q}`)).map((i) => i.product_id as string);

  it("is empty (honestly) without Price Watch history, and sends no-store", async () => {
    const r = await get("/v1/eg/deals");
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(json(r)).toEqual({ items: [], next_cursor: null });
  });

  it("lists only a verified discount, in its band, and never a plain or launch price", async () => {
    // 260,000 for 50 days, then 129,900 for 5 days: a verified 50% reduction with more than 30 days of history.
    await putHistory(skuA, [
      { price: 260000, daysAgo: 50 },
      { price: 129900, daysAgo: 5 },
    ]);
    expect(await dealIds("?band=59_50")).toEqual([t.seed.productA]);
    expect(await dealIds("?band=49_40")).toEqual([]);
    expect(await dealIds("?band=70_60")).toEqual([]);
    expect(await dealIds()).toEqual([t.seed.productA]);
    const card = items(await get("/v1/eg/deals?band=59_50"))[0] as { price: Record<string, unknown> };
    expect(card.price).toMatchObject({ claim_type: "verified_discount", display_discount_bp: 5000, current_price: { amount_minor: "129900" }, reference_price: { amount_minor: "260000" } });
  });

  it("excludes stores that do not show percentages publicly, and everything while the kill switch is off", async () => {
    await t.raw.query("UPDATE catalog_public_stores SET discount_display_mode = 'member_only' WHERE id = $1", [t.seed.storeA]);
    expect(await dealIds("?band=59_50")).toEqual([]);
    await t.raw.query("UPDATE catalog_public_stores SET discount_display_mode = 'public' WHERE id = $1", [t.seed.storeA]);
    expect(await dealIds("?band=59_50")).toEqual([t.seed.productA]);
    state.killed = true;
    expect(await dealIds("?band=59_50")).toEqual([]);
    state.killed = false;
  });

  it("drops the item again once the price is raised after the cut (no reduction left to claim)", async () => {
    await t.raw.query("UPDATE price_events SET valid_to = $1 WHERE sku_id = $2 AND valid_to IS NULL", [new Date(T0 - 1 * DAY_MS), skuA]);
    await t.raw.query(
      `INSERT INTO price_events (id, sku_id, market_id, currency, price_minor, valid_from, valid_to, source, actor_type) VALUES ($1,$2,$3,'EGP',400000,$4,NULL,'internal','system')`,
      [randomUUID(), skuA, DB_MARKET, new Date(T0 - 1 * DAY_MS)],
    );
    // The current price (400,000) is above every earlier reference candidate, so nothing is claimable.
    expect(await dealIds()).toEqual([]);
  });
});
