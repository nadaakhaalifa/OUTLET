import type { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidCursorError, SearchIndexSync, SearchService } from "../src/index.js";
import type { PriceDisplayLookup } from "../src/index.js";
import { CAT_1, CAT_2, MARKET, NEVER_KILLED, STORE_A, STORE_B, ev, makeDb, seedListing } from "./helpers.js";

let pg: PGlite;
let client: SqlClient;
let svc: SearchService;
const display: PriceDisplayLookup = { forSku: () => Promise.resolve({ verifiedDiscount: false, lowest30d: false }) };
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (p: { items: readonly { productId: string }[] }): string[] => p.items.map((i) => i.productId).sort();
const T = (s: number): string => new Date(Date.UTC(2026, 10, 8, 12, 0, s)).toISOString();

beforeAll(async () => {
  const m = await makeDb();
  pg = m.db;
  client = m.client;
  svc = new SearchService({ client, marketId: MARKET, killSwitch: NEVER_KILLED });
  const sync = new SearchIndexSync(client, display);
  await seedListing(client, { id: id(1), titleAr: "فستان لينين أبيض", titleEn: "White linen dress", price: 120000, sizes: ["m"], grade: "new_with_tags" });
  await seedListing(client, { id: id(2), titleAr: "فستان لينين أبيض", titleEn: "White linen dress", price: 200000, store: STORE_B, category: CAT_2, grade: "sample" });
  await seedListing(client, { id: id(3), titleAr: "قميص قطن اسود", titleEn: "Black cotton shirt", price: 50000, sizes: ["s"] });
  for (const n of [1, 2, 3]) await sync.handle(ev("listing.activated", { listing_id: id(n), store_id: n === 2 ? STORE_B : STORE_A, version: 1, status: "PUBLISHED" }, T(n)));
});
afterAll(async () => { await pg.close(); });

describe("each relaxation step fires only when its filter is present, and only as far as needed", () => {
  it("condition: a grade nothing has in that category is dropped first", async () => {
    const p = await svc.search("white linen dress", { conditionGrades: ["sample"], categoryIds: [CAT_1] });
    expect(p.relaxed).toEqual(["condition"]);
    expect(ids(p)).toEqual([id(1)]);
  });

  it("category: a category with no match is dropped before the store", async () => {
    const p = await svc.search("white linen dress", { categoryIds: [CAT_1], storeIds: [STORE_B] });
    expect(p.relaxed).toEqual(["category"]);
    expect(ids(p)).toEqual([id(2)]);
  });

  it("store: with no category filter the store scope is what gets relaxed", async () => {
    const p = await svc.search("cotton shirt", { storeIds: [STORE_B] });
    expect(p.relaxed).toEqual(["store"]);
    expect(ids(p)).toEqual([id(3)]);
  });

  it("price_min then price_max: an impossible floor goes first, and then an impossible ceiling", async () => {
    const floor = await svc.search("white linen dress", { priceMin: 99_999_999n });
    expect(floor.relaxed).toEqual(["price_min"]);
    expect(ids(floor)).toEqual([id(1), id(2)]);
    const ceiling = await svc.search("white linen dress", { priceMax: 1n });
    expect(ceiling.relaxed).toEqual(["price_max"]);
    expect(ids(ceiling)).toEqual([id(1), id(2)]);
    const both = await svc.search("white linen dress", { priceMin: 99_999_999n, priceMax: 1n });
    expect(both.relaxed).toEqual(["price_min", "price_max"]);
  });

  it("when no step applies the page is honestly empty (nothing is invented)", async () => {
    const p = await svc.search("white linen dress", {}, undefined, { limit: 5 });
    expect(p.items.length).toBeGreaterThan(0);
    const none = await svc.search("cotton shirt", { priceMin: 99_999_999n, priceMax: 99_999_999n, storeIds: [STORE_B], categoryIds: [CAT_2] });
    expect(none.relaxed.length).toBeGreaterThan(0); // relaxed until something matched
    const empty = await new SearchService({ client, marketId: "xx", killSwitch: NEVER_KILLED }).search("white linen dress", {});
    expect(empty.items).toEqual([]);
    expect(empty.relaxed).toEqual([]);
  });
});

describe("the tighter of the budget in the text and the explicit ceiling wins", () => {
  it("under 1500 EGP in the text with a lower explicit ceiling, and the reverse", async () => {
    const lowerCeiling = await svc.search("white linen dress under 1500", { priceMax: 100_000n });
    // 100,000 is below every dress, so the explicit ceiling (the tighter one) matched nothing and was relaxed; the text budget (150,000) then applies
    expect(lowerCeiling.relaxed).toEqual(["price_max"]);
    expect(ids(lowerCeiling)).toEqual([id(1)]);
    expect(lowerCeiling.appliedFilter.priceMax).toBe(150_000n);
    const lowerBudget = await svc.search("white linen dress under 1300", { priceMax: 500_000n });
    expect(ids(lowerBudget)).toEqual([id(1)]);
    expect(lowerBudget.relaxed).toEqual([]);
  });
});

describe("input and cursor guards", () => {
  it("a page size below one is a RangeError, a huge one is capped", async () => {
    await expect(svc.search("dress", {}, undefined, { limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(svc.search("dress", {}, undefined, { limit: 1.5 })).rejects.toBeInstanceOf(RangeError);
    expect((await svc.search("dress", {}, undefined, { limit: 100_000 })).items.length).toBeLessThanOrEqual(3);
  });

  it("a cursor claiming a relaxation step the query cannot have applied is invalid, as is an unknown step name", async () => {
    const paged = await svc.search("white linen dress", {}, undefined, { limit: 1 });
    expect(paged.nextCursor).not.toBeNull();
    const forge = (cursor: string, relaxed: string[]): string => {
      const o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
      return Buffer.from(JSON.stringify({ ...o, x: relaxed })).toString("base64url");
    };
    for (const steps of [["store"], ["bogus"], ["lowest_30d"]]) {
      await expect(svc.search("white linen dress", {}, forge(paged.nextCursor ?? "", steps), { limit: 1 })).rejects.toBeInstanceOf(InvalidCursorError);
    }
  });
});
