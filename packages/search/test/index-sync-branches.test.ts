import type { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SearchIndexSync } from "../src/index.js";
import type { PriceDisplayLookup } from "../src/index.js";
import { ev, makeDb, seedListing } from "./helpers.js";

let pg: PGlite;
let client: SqlClient;
let sync: SearchIndexSync;
let verified = false;
const display: PriceDisplayLookup = { forSku: () => Promise.resolve({ verifiedDiscount: verified, lowest30d: false }) };
const T = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

const doc = async (id: string) => (await client.query<{ price_minor: string; in_stock: boolean; is_published: boolean; world: string; verified_discount: boolean; title_ar: string; sizes: string[]; seq: string }>(
  "SELECT price_minor::text, in_stock, is_published, world, verified_discount, title_ar, sizes, seq::text FROM search_documents WHERE product_id = $1", [id])).rows[0];

beforeAll(async () => {
  ({ db: pg, client } = await makeDb());
  sync = new SearchIndexSync(client, display);
});
afterAll(async () => {
  await pg.close();
});

describe("stock events", () => {
  it("missing without a document, applied, then stale for an older event", async () => {
    const id = uuidv7();
    await seedListing(client, { id, titleAr: "فستان", price: 1000 });
    expect(await sync.handle(ev("inventory.sold_out", { listing_id: id }, T(5)))).toBe("missing");
    expect(await sync.handle(ev("listing.activated", { listing_id: id }, T(10)))).toBe("applied");
    expect(await sync.handle(ev("inventory.sold_out", { listing_id: id }, T(20)))).toBe("applied");
    expect((await doc(id))?.in_stock).toBe(false);
    expect(await sync.handle(ev("inventory.restocked", { listing_id: id }, T(15)))).toBe("stale");
    expect((await doc(id))?.in_stock).toBe(false);
    expect(await sync.handle(ev("inventory.restocked", { listing_id: id }, T(30)))).toBe("applied");
    expect((await doc(id))?.in_stock).toBe(true);
  });
});

describe("price.changed", () => {
  it("missing for an unknown sku; applied takes the minimum variant price and the display flags; older events are stale", async () => {
    expect(await sync.handle(ev("price.changed", { sku_id: uuidv7(), new_price_minor: "500" }, T(1)))).toBe("missing");
    const id = uuidv7();
    const sku = uuidv7();
    await seedListing(client, { id, titleAr: "قميص", price: 1000, sizes: ["m", "l"], sku });
    expect(await sync.handle(ev("price.changed", { sku_id: sku, new_price_minor: "500" }, T(2)))).toBe("missing"); // listing exists, no document yet
    await sync.handle(ev("listing.activated", { listing_id: id }, T(10)));
    verified = true;
    expect(await sync.handle(ev("price.changed", { sku_id: sku, new_price_minor: "700" }, T(20)))).toBe("applied");
    expect(await doc(id)).toMatchObject({ price_minor: "700", verified_discount: true });
    verified = false;
    expect(await sync.handle(ev("price.changed", { sku_id: sku, new_price_minor: "100" }, T(15)))).toBe("stale");
    expect((await doc(id))?.price_minor).toBe("700");
  });
  it("rejects malformed payloads instead of indexing them", async () => {
    await expect(sync.handle(ev("price.changed", { sku_id: "nope", new_price_minor: "5" }, T(1)))).rejects.toThrow();
    await expect(sync.handle(ev("price.changed", { sku_id: uuidv7(), new_price_minor: "-5" }, T(1)))).rejects.toThrow();
  });
});

describe("listing events", () => {
  it("indexes global stores, tolerates null optional columns, and unpublishes PAUSED listings", async () => {
    const id = uuidv7();
    await seedListing(client, { id, titleAr: "حذاء", price: 300, status: "PAUSED" });
    await client.query(`UPDATE catalog_public_listings SET store = '{"kind":"global"}'::jsonb, variants = '[{"sku_id":"${uuidv7()}","size_label":null,"price_minor":"300"},{"sku_id":"${uuidv7()}","size_label":"  XL ","price_minor":"300"}]'::jsonb WHERE id = $1`, [id]);
    expect(await sync.handle(ev("listing.activated", { listing_id: id }, T(10)))).toBe("applied");
    expect(await doc(id)).toMatchObject({ world: "global", is_published: false, sizes: ["xl"] });
  });
  it("a listing with no variants still indexes (display defaults to false)", async () => {
    const id = uuidv7();
    await seedListing(client, { id, titleAr: "وشاح", price: 90 });
    await client.query("UPDATE catalog_public_listings SET variants = '[]'::jsonb WHERE id = $1", [id]);
    verified = true;
    expect(await sync.handle(ev("listing.updated", { listing_id: id }, T(10)))).toBe("applied");
    verified = false;
    expect((await doc(id))?.verified_discount).toBe(false);
  });
  it("a stale listing event refreshes content only, never price or publish state", async () => {
    const id = uuidv7();
    await seedListing(client, { id, titleAr: "قديم", price: 100 });
    await sync.handle(ev("listing.activated", { listing_id: id }, T(50)));
    await client.query("UPDATE catalog_public_listings SET title_ar = 'جديد', min_price_minor = 1 WHERE id = $1", [id]);
    expect(await sync.handle(ev("listing.updated", { listing_id: id }, T(40)))).toBe("stale");
    expect(await doc(id)).toMatchObject({ title_ar: "جديد", price_minor: "100", is_published: true });
  });
  it("a vanished listing unpublishes its document, or is missing when never indexed", async () => {
    const gone = uuidv7();
    expect(await sync.handle(ev("listing.updated", { listing_id: gone }, T(10)))).toBe("missing");
    const id = uuidv7();
    await seedListing(client, { id, titleAr: "مؤقت", price: 10 });
    await sync.handle(ev("listing.activated", { listing_id: id }, T(10)));
    await client.query("DELETE FROM catalog_public_listings WHERE id = $1", [id]);
    expect(await sync.handle(ev("listing.updated", { listing_id: id }, T(20)))).toBe("applied");
    expect((await doc(id))?.is_published).toBe(false);
  });
});

describe("handle", () => {
  it("ignores unrelated events and dedups a redelivered event id", async () => {
    expect(await sync.handle(ev("order.paid", {}, T(1)))).toBe("ignored");
    const id = uuidv7();
    await seedListing(client, { id, titleAr: "كرر", price: 5 });
    const e = ev("listing.activated", { listing_id: id }, T(10));
    expect(await sync.handle(e)).toBe("applied");
    expect(await sync.handle(e)).toBe("duplicate");
  });
});
