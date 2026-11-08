import { uuidv7 } from "@outlet/ids";
import type { SqlClient } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidCursorError, SPONSORED_CAP, SearchIndexSync, SearchService, SearchUnavailableError, STALENESS_SLO_MS, measureStaleness, placeSponsored, seqOf } from "../src/index.js";
import type { PriceDisplayLookup } from "../src/index.js";
import { CAT_1, CAT_2, MARKET, NEVER_KILLED, STORE_A, STORE_B, ev, makeDb, seedListing } from "./helpers.js";
import type { PGlite } from "@electric-sql/pglite";

let pg: PGlite;
let client: SqlClient;
const flags = { verified: new Set<string>(), lowest: new Set<string>() };
const display: PriceDisplayLookup = { forSku: (sku) => Promise.resolve({ verifiedDiscount: flags.verified.has(sku), lowest30d: flags.lowest.has(sku) }) };
let sync: SearchIndexSync;
let svc: SearchService;
const T = (s: number): string => new Date(Date.UTC(2026, 10, 8, 12, 0, s)).toISOString();
const ids = (p: { items: readonly { productId: string }[] }): string[] => p.items.map((i) => i.productId);

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const index = async (listingId: string, s = 1): Promise<void> => {
  await sync.handle(ev("listing.activated", { listing_id: listingId, store_id: STORE_A, version: 1, status: "PUBLISHED" }, T(s)));
};

beforeAll(async () => {
  const m = await makeDb();
  pg = m.db;
  client = m.client;
  sync = new SearchIndexSync(client, display);
  svc = new SearchService({ client, marketId: MARKET, killSwitch: NEVER_KILLED });
  await seedListing(client, { id: id(1), titleAr: "فستان لينين أبيض", titleEn: "White linen dress", price: 120000, sizes: ["m", "l"], grade: "new_with_tags" });
  await seedListing(client, { id: id(2), titleAr: "فستان لينين أبيض", titleEn: "White linen dress", price: 200000, store: STORE_B, category: CAT_2, grade: "sample" });
  await seedListing(client, { id: id(3), titleAr: "قميص قطن اسود", titleEn: "Black cotton shirt", price: 50000, sizes: ["s"] });
  await seedListing(client, { id: id(4), titleAr: "حذاء رياضي", titleEn: "Sneakers", price: 90000, status: "SOLD_OUT" });
  await seedListing(client, { id: id(5), titleAr: "فستان لينين أبيض", titleEn: "White linen dress", price: 100000, status: "PAUSED" });
  for (const n of [1, 2, 3, 4, 5]) await index(id(n), n);
});
afterAll(async () => {
  await pg.close();
});

describe("acceptance: AR and EN queries are equivalent", () => {
  it("returns the same ids, with the budget applied (Eastern digits parsed)", async () => {
    const ar = await svc.search("فستان ابيض لينين تحت ١٥٠٠", {});
    const en = await svc.search("white linen dress under 1500", {});
    expect(ids(ar)).toEqual([id(1)]);
    expect(ids(en)).toEqual(ids(ar));
    expect(ar.appliedFilter.priceMax).toBe(150000n);
    expect(ar.relaxed).toEqual([]);
  });
  it("Franco spelling resolves to the same concepts", async () => {
    expect(ids(await svc.search("fostan abyad linen", {}))).toEqual(expect.arrayContaining([id(1)]));
  });
  it("paused listings are not searchable", async () => {
    expect(ids(await svc.search("white linen dress", {}))).not.toContain(id(5));
  });
});

describe("filters", () => {
  it("category, store, price range, size, condition, world", async () => {
    expect(ids(await svc.search("dress", { categoryIds: [CAT_2] }))).toEqual([id(2)]);
    expect(ids(await svc.search("dress", { storeIds: [STORE_B] }))).toEqual([id(2)]);
    expect(ids(await svc.search("", { priceMin: 60000n, priceMax: 100000n }))).toEqual([id(4)]);
    expect(ids(await svc.search("", { sizes: ["S"] }))).toEqual([id(3)]);
    expect(ids(await svc.search("dress", { conditionGrades: ["sample"] }))).toEqual([id(2)]);
    expect((await svc.search("", { world: "global" })).relaxed).toEqual(["world"]);
    expect(ids(await svc.search("", { inStockOnly: true }))).not.toContain(id(4));
  });
  it("verified_only and lowest_30d use the display decision of the pricing port", async () => {
    const row = await client.query<{ variants: { sku_id: string }[] }>("SELECT variants FROM catalog_public_listings WHERE id = $1", [id(3)]);
    const sku = row.rows[0]?.variants[0]?.sku_id ?? "";
    flags.verified.add(sku);
    await index(id(3), 10);
    expect(ids(await svc.search("", { verifiedOnly: true }))).toEqual([id(3)]);
    expect((await svc.search("", { lowest30d: true, world: "both" })).relaxed).toEqual(["lowest_30d"]);
    flags.verified.delete(sku);
    flags.lowest.add(sku);
    await index(id(3), 11);
    expect((await svc.search("", { verifiedOnly: true })).relaxed).toEqual(["verified_only"]);
    expect(ids(await svc.search("", { lowest30d: true }))).toEqual([id(3)]);
  });
  it("rejects unknown keys and more than 30 facet values", async () => {
    await expect(svc.search("x", { bogus: 1 } as never)).rejects.toThrow();
    await expect(svc.search("x", { sizes: Array.from({ length: 31 }, (_, i) => `s${String(i)}`) })).rejects.toThrow();
  });
});

describe("sync: idempotent and monotonic", () => {
  it("out-of-order events never regress a document, redelivery is a no-op", async () => {
    const listing = id(6);
    await seedListing(client, { id: listing, titleAr: "جاكيت جلد", titleEn: "Leather jacket", price: 300000, sku: uuidv7() });
    const skuRow = await client.query<{ variants: { sku_id: string }[] }>("SELECT variants FROM catalog_public_listings WHERE id = $1", [listing]);
    const sku = skuRow.rows[0]?.variants[0]?.sku_id ?? "";
    expect(await sync.handle(ev("listing.activated", { listing_id: listing }, T(20)))).toBe("applied");
    const newer = ev("price.changed", { sku_id: sku, new_price_minor: "250000" }, T(40));
    const older = ev("price.changed", { sku_id: sku, new_price_minor: "280000" }, T(30));
    expect(await sync.handle(newer)).toBe("applied");
    expect(await sync.handle(older)).toBe("stale");
    expect(await sync.handle(newer)).toBe("duplicate");
    const r = await client.query<{ price_minor: string; seq: string }>("SELECT price_minor::text, seq::text FROM search_documents WHERE product_id = $1", [listing]);
    expect(r.rows[0]).toEqual({ price_minor: "250000", seq: seqOf(T(40)).toString() });
    // sold-out then an older restock: stays sold out
    expect(await sync.handle(ev("inventory.sold_out", { listing_id: listing }, T(60)))).toBe("applied");
    expect(await sync.handle(ev("inventory.restocked", { listing_id: listing }, T(50)))).toBe("stale");
    const s = await client.query<{ in_stock: boolean }>("SELECT in_stock FROM search_documents WHERE product_id = $1", [listing]);
    expect(s.rows[0]?.in_stock).toBe(false);
  });
  it("a stale listing event still refreshes content but not price or stock", async () => {
    const listing = id(7);
    await seedListing(client, { id: listing, titleAr: "بنطلون", titleEn: "Trousers", price: 70000 });
    await sync.handle(ev("listing.activated", { listing_id: listing }, T(100)));
    await sync.handle(ev("inventory.sold_out", { listing_id: listing }, T(120)));
    await seedListing(client, { id: listing, titleAr: "بنطلون", titleEn: "Chino trousers renamed", price: 65000 });
    expect(await sync.handle(ev("listing.updated", { listing_id: listing }, T(110)))).toBe("stale");
    const r = await client.query<{ title_en: string; price_minor: string; in_stock: boolean }>("SELECT title_en, price_minor::text, in_stock FROM search_documents WHERE product_id = $1", [listing]);
    expect(r.rows[0]).toEqual({ title_en: "chino trousers renamed", price_minor: "70000", in_stock: false });
  });
  it("ignores unrelated events and a paused listing unpublishes", async () => {
    expect(await sync.handle(ev("order.placed", {}, T(1)))).toBe("ignored");
    await seedListing(client, { id: id(1), titleAr: "فستان لينين أبيض", titleEn: "White linen dress", price: 120000, status: "PAUSED" });
    await sync.handle(ev("listing.updated", { listing_id: id(1) }, T(500)));
    expect(ids(await svc.search("white linen dress", {}))).not.toContain(id(1));
    await seedListing(client, { id: id(1), titleAr: "فستان لينين أبيض", titleEn: "White linen dress", price: 120000 });
    await sync.handle(ev("listing.updated", { listing_id: id(1) }, T(600)));
    expect(ids(await svc.search("white linen dress", {}))).toContain(id(1));
  });
});

describe("keyset pagination", () => {
  it("is stable, covers every row once, and caps at 50", async () => {
    for (let n = 100; n < 130; n += 1) {
      await seedListing(client, { id: id(n), titleAr: "قميص قطن", titleEn: "Cotton shirt", price: 10000 + n });
      await index(id(n), 700 + n);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const p = await svc.search("cotton shirt", {}, cursor, { limit: 7 });
      seen.push(...ids(p));
      if (p.nextCursor === null) break;
      cursor = p.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(31);
    expect((await svc.search("", {}, undefined, { limit: 500 })).items.length).toBeLessThanOrEqual(50);
  });
  it("rejects a cursor replayed against a different query and garbage", async () => {
    const p = await svc.search("cotton shirt", {}, undefined, { limit: 2 });
    await expect(svc.search("white linen dress", {}, p.nextCursor ?? "", { limit: 2 })).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(svc.search("cotton shirt", {}, "zzz")).rejects.toBeInstanceOf(InvalidCursorError);
  });
});

describe("zero-result relaxation and search_no_result", () => {
  it("drops the least important filter first and reports it", async () => {
    const p = await svc.search("white linen dress", { lowest30d: true, verifiedOnly: true, categoryIds: [CAT_1] });
    expect(p.relaxed).toEqual(["lowest_30d", "verified_only"]);
    expect(ids(p)).toContain(id(1));
  });
  it("relaxes the budget before unresolved terms, and later pages replay the same relaxation", async () => {
    const p = await svc.search("white linen dress under 10", {});
    expect(p.relaxed).toEqual(["budget"]);
    const q = await svc.search("white linen dress under 10", {}, undefined, { limit: 1 });
    expect(q.nextCursor).not.toBeNull();
    const q2 = await svc.search("white linen dress under 10", {}, q.nextCursor ?? "", { limit: 1 });
    expect(q2.relaxed).toEqual(["budget"]);
    expect(ids(q2)).not.toEqual(ids(q));
  });
  it("emits a PII-free search_no_result outbox event", async () => {
    await svc.search("zzzqx dress", {});
    const r = await client.query<{ payload: Record<string, unknown> }>("SELECT payload FROM outbox_events WHERE event_type = 'search.no_result' ORDER BY id DESC LIMIT 1");
    const payload = r.rows[0]?.payload ?? {};
    expect(payload.analytics_event).toBe("search_no_result");
    expect(JSON.stringify(payload)).not.toContain("zzzqx dress");
    expect(payload.unresolved_terms).toEqual(["zzzqx"]);
  });
  it("relaxes all the way to browse as the last resort, in the documented order", async () => {
    const p = await svc.search("qqqq", { sizes: ["xxl"] });
    expect(p.relaxed).toEqual(["size", "unresolved_terms"]);
  });
});

describe("sponsored", () => {
  it("labels at most 2 sponsored items inside the top 10, through the same filters", async () => {
    const p = await svc.search("cotton shirt", {}, undefined, { limit: 12, sponsoredIds: [id(100), id(101), id(102), id(2)] });
    const sp = p.items.filter((i) => i.sponsored);
    expect(sp.length).toBe(SPONSORED_CAP);
    expect(p.items.slice(0, 10).filter((i) => i.sponsored).length).toBe(2);
    expect(p.items.map((i) => i.productId)).not.toContain(id(2)); // id(2) is not a cotton shirt: fails the same query
    expect(new Set(ids(p)).size).toBe(p.items.length);
  });
  it("placeSponsored caps and short pages", () => {
    const org = [1, 2, 3].map((n) => ({ productId: String(n), sponsored: false }));
    const out = placeSponsored(org, [4, 5, 6].map((n) => ({ productId: String(n), sponsored: true })));
    expect(out.filter((o) => o.sponsored).length).toBe(2);
  });
});

describe("kill switches and staleness", () => {
  it("fts kill switch makes search unavailable; a throwing port fails open", async () => {
    const off = new SearchService({ client, marketId: MARKET, killSwitch: { isEngineKilled: () => Promise.resolve(true), isFtsKilled: () => Promise.resolve(true) } });
    await expect(off.search("dress", {})).rejects.toBeInstanceOf(SearchUnavailableError);
    const broken = new SearchService({ client, marketId: MARKET, killSwitch: { isEngineKilled: () => Promise.reject(new Error("x")), isFtsKilled: () => Promise.reject(new Error("x")) } });
    expect((await broken.search("dress", {})).engineFallback).toBe(true);
  });
  it("staleness = now - oldest pending event; breach at the 60 s SLO", async () => {
    const now = new Date(T(1000));
    expect(await measureStaleness({ oldestPendingOccurredAt: () => Promise.resolve(null) }, now)).toEqual({ stalenessMs: 0, breached: false });
    const r = await measureStaleness({ oldestPendingOccurredAt: () => Promise.resolve(new Date(now.getTime() - STALENESS_SLO_MS)) }, now);
    expect(r).toEqual({ stalenessMs: STALENESS_SLO_MS, breached: true });
  });
});

describe("index shape and plan", () => {
  it("holds only published-catalog P0 columns (no PII, no tenant key)", async () => {
    const r = await pg.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'search_documents'");
    const cols = r.rows.map((c) => c.column_name).sort();
    expect(cols).toEqual(["attributes", "category_id", "condition_grade", "currency", "in_stock", "is_published", "lowest_30d", "market_id", "price_minor", "product_id", "search_text", "seq", "sizes", "store_ref", "title_ar", "title_en", "tsv", "updated_at", "verified_discount", "world"]);
    expect(cols.filter((c) => /user|phone|email|address|dob|name$|iban|token/.test(c))).toEqual([]);
    const data = await pg.query<{ n: string }>("SELECT count(*)::text AS n FROM search_documents WHERE is_published AND product_id NOT IN (SELECT id FROM catalog_public_listings WHERE status <> 'PAUSED')");
    expect(data.rows[0]?.n).toBe("0");
  });
  it("uses the GIN index on 5k documents", async () => {
    await pg.exec(`INSERT INTO search_documents (product_id, market_id, store_ref, title_ar, title_en, search_text, tsv, price_minor, currency, condition_grade, is_published, updated_at, seq)
      SELECT gen_random_uuid(), 'eg', gen_random_uuid(), 'x', 'x', 'item' || g || ' filler' , to_tsvector('arabic_simple', 'item' || g || ' filler'), 1000, 'EGP', 'new', true, now(), 1 FROM generate_series(1, 5000) g`);
    await pg.exec("ANALYZE search_documents");
    await pg.exec("SET enable_seqscan = off");
    const plan = await pg.query<{ "QUERY PLAN": string }>("EXPLAIN SELECT product_id FROM search_documents WHERE market_id = 'eg' AND is_published AND tsv @@ plainto_tsquery('arabic_simple', 'item77')");
    expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/search_documents_tsv_idx/);
    const trg = await pg.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_indexes WHERE indexname = 'search_documents_trgm_idx'");
    expect(trg.rows[0]?.n).toBe("1");
    await pg.exec("RESET enable_seqscan");
  });
});
