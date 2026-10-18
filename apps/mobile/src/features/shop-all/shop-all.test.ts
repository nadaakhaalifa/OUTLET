import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMPTY_LISTING_FILTERS, appliedChips, removeChip, toSearchFilter } from "../filters/model";
import {
  EMPTY_LISTING, LISTING_ROUTE_KEYS, emptyActions, hasListingParams, listingBadge, listingToParams, paramsPatch, parseListing, requestKey, resetFilters, sameListing,
  type ListingState,
} from "./listing-model";
import {
  EMPTY_SELECTION, MAX_STORE_FILTER, buildShopAllFilter, chipsOverflow, decodeSelection, encodeSelection, favouriteIds, filterStoresByQuery,
  homeStoreRows, isOnlyMyStores, mergePages, pruneSelection, resultsCount, selectionReducer, sortItems,
} from "./model";
import { FIXTURE_STORES, type StoreSummary } from "../worlds/model";
import { InMemorySearchPort, type SearchItem } from "../search/model";

const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}`);
const item = (id: string, price: bigint, pct: number | null): SearchItem => ({ id, title: id, storeName: "x", price, verifiedDiscountPct: pct, sponsored: false });

describe("selection reducer", () => {
  it("toggles one or many and removes", () => {
    let s = selectionReducer(EMPTY_SELECTION, { type: "toggle", id: "a" });
    s = selectionReducer(s, { type: "toggle", id: "b" });
    expect(s.ids).toEqual(["a", "b"]);
    s = selectionReducer(s, { type: "toggle", id: "a" });
    expect(s.ids).toEqual(["b"]);
    expect(selectionReducer(s, { type: "remove", id: "b" }).ids).toEqual([]);
  });
  it("refuses the 31st store and flags the limit", () => {
    const full = selectionReducer(EMPTY_SELECTION, { type: "set", ids: many(MAX_STORE_FILTER) });
    expect(full.limitHit).toBe(false);
    const over = selectionReducer(full, { type: "toggle", id: "extra" });
    expect(over.ids).toHaveLength(MAX_STORE_FILTER);
    expect(over.limitHit).toBe(true);
    expect(selectionReducer(over, { type: "toggle", id: "s0" }).limitHit).toBe(false);
  });
  it("select all truncates at the limit and clear empties", () => {
    const s = selectionReducer(EMPTY_SELECTION, { type: "selectAll", ids: many(45) });
    expect(s.ids).toHaveLength(30);
    expect(s.limitHit).toBe(true);
    expect(selectionReducer(s, { type: "clear" })).toEqual(EMPTY_SELECTION);
  });
  it("de-duplicates", () => {
    expect(selectionReducer(EMPTY_SELECTION, { type: "set", ids: ["a", "a", "b"] }).ids).toEqual(["a", "b"]);
  });
});

describe("chips overflow", () => {
  it("shows three then +N", () => {
    expect(chipsOverflow(many(2))).toEqual({ visible: ["s0", "s1"], overflow: 0 });
    expect(chipsOverflow(many(7))).toEqual({ visible: ["s0", "s1", "s2"], overflow: 4 });
    expect(chipsOverflow([])).toEqual({ visible: [], overflow: 0 });
  });
});

describe("persistence", () => {
  it("round-trips and rejects junk", () => {
    expect(decodeSelection(encodeSelection(["a", "b-1", "c_2"]))).toEqual(["a", "b-1", "c_2"]);
    expect(decodeSelection(null)).toEqual([]);
    expect(decodeSelection("garbage")).toEqual([]);
    expect(decodeSelection("v1|a,<script>,b")).toEqual(["a", "b"]);
    expect(decodeSelection(encodeSelection(many(40)))).toHaveLength(30);
    expect(decodeSelection(encodeSelection([]))).toEqual([]);
  });
});

describe("store helpers", () => {
  it("searches active stores by name", () => {
    expect(filterStoresByQuery(FIXTURE_STORES, "denim").map((s) => s.id)).toEqual(["s1"]);
    expect(filterStoresByQuery(FIXTURE_STORES, "").map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(filterStoresByQuery(FIXTURE_STORES, "delta")).toEqual([]);
  });
  it("prunes unknown or suspended ids only once stores are loaded", () => {
    expect(pruneSelection(["s1", "s4", "zz"], FIXTURE_STORES)).toEqual(["s1"]);
    expect(pruneSelection(["s1"], [])).toEqual(["s1"]);
  });
  it("favourites shortcut", () => {
    const fav = favouriteIds(FIXTURE_STORES);
    expect(fav.ids).toEqual(["s1", "s3"]);
    expect(isOnlyMyStores(["s3", "s1"], FIXTURE_STORES)).toBe(true);
    expect(isOnlyMyStores(["s1"], FIXTURE_STORES)).toBe(false);
  });
  it("home rows: max 5, live first, one per store", () => {
    const stores: StoreSummary[] = many(8).map((id, i) => ({ ...FIXTURE_STORES[1]!, id, name: id, trendingRank: 8 - i, liveDrop: id === "s7" }));
    const rows = homeStoreRows(stores);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.id).toBe("s7");
    expect(homeStoreRows([])).toEqual([]);
  });
});

describe("request and ordering", () => {
  it("builds a world=everything filter with store ids", () => {
    expect(buildShopAllFilter([]).storeIds).toBeUndefined();
    expect(buildShopAllFilter(["s1"])).toMatchObject({ world: "everything", storeIds: ["s1"] });
  });
  it("sorts without mutating and keeps ties stable", () => {
    const items = [item("a", 200n, null), item("b", 100n, 30), item("c", 100n, 10)];
    expect(sortItems(items, "priceLow").map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(sortItems(items, "priceHigh").map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(sortItems(items, "discount").map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(sortItems(items, "relevance")).toBe(items);
  });
  it("merges pages without duplicates", () => {
    expect(mergePages([item("a", 1n, null)], [item("a", 1n, null), item("b", 1n, null)]).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("fake search honours store_ids", async () => {
    const port = new InMemorySearchPort();
    const r = await port.search("", buildShopAllFilter(["s1"]));
    expect(r.items.map((x) => x.id).sort()).toEqual(["p2", "p3"]);
    expect((await port.search("", buildShopAllFilter([]))).items).toHaveLength(4);
    expect((await port.search("", buildShopAllFilter(["nope"]))).items).toHaveLength(0);
  });
});

describe("listing route model (round-2 item 6)", () => {
  const route = { store: "s1,s2", category: "tops", min: "100", max: "500", discount: "20", lowest: "1", department: "women", free: "1", new: "1", sort: "priceLow", q: "linen" };

  it("round-trips every filter through the route", () => {
    const s = parseListing(route, []);
    expect(s.q).toBe("linen");
    expect(s.filters.storeIds).toEqual(["s1", "s2"]);
    expect(s.filters.sort).toBe("priceLow");
    expect(sameListing(parseListing(listingToParams(s), []), s)).toBe(true);
    expect(listingToParams(s)).toMatchObject({ store: "s1,s2", min: "100", max: "500", discount: "20", sort: "priceLow", q: "linen" });
  });
  it("accepts the legacy stores alias and ignores junk without throwing", () => {
    expect(parseListing({ stores: "a,b" }, []).filters.storeIds).toEqual(["a", "b"]);
    expect(parseListing({ store: "a", stores: "b" }, []).filters.storeIds).toEqual(["a", "b"]);
    const bad = parseListing({ store: "<x>", min: "abc", discount: "7", sort: "trending", department: "unisex", q: "x".repeat(300) }, []);
    expect(bad.filters).toEqual(EMPTY_LISTING_FILTERS);
    expect(bad.q).toHaveLength(100);
    expect(hasListingParams({ foo: "1", q: "  " })).toBe(false);
    expect(hasListingParams({ q: "a" })).toBe(true);
  });
  it("never puts budget data in the route or the request key without the switch", () => {
    const s: ListingState = { filters: { ...EMPTY_LISTING_FILTERS, fitsBudget: true }, q: "" };
    expect(JSON.stringify(listingToParams(s))).toBe("{}");
    expect(Object.values(paramsPatch(s)).every((v) => v === undefined)).toBe(true);
    expect(requestKey(EMPTY_LISTING, 5000n)).toBe(requestKey(EMPTY_LISTING, null));
    expect(requestKey(s, 5000n)).not.toBe(requestKey(s, 6000n));
    expect(toSearchFilter(s.filters, [], { remainingBudget: 5000n }).budgetMax).toBe(5000n);
  });
  it("patches every known key so stale params are cleared", () => {
    const patch = paramsPatch({ filters: { ...EMPTY_LISTING_FILTERS, freeDelivery: true }, q: "" });
    expect(Object.keys(patch).sort()).toEqual([...LISTING_ROUTE_KEYS].sort());
    expect(patch["free"]).toBe("1");
    expect(patch["store"]).toBeUndefined();
  });
  it("badge counts filters, not the search text; reset keeps the text", () => {
    const s = parseListing(route, []);
    expect(listingBadge(s)).toBeGreaterThan(0);
    expect(listingBadge({ filters: EMPTY_LISTING_FILTERS, q: "dress" })).toBe(0);
    expect(resetFilters(s)).toEqual({ filters: EMPTY_LISTING_FILTERS, q: "linen" });
  });
  it("empty-state actions: reset filters and/or clear the text, nothing otherwise", () => {
    expect(emptyActions(EMPTY_LISTING)).toEqual([]);
    expect(emptyActions({ filters: { ...EMPTY_LISTING_FILTERS, newArrivals: true }, q: "a" })).toEqual(["resetFilters", "clearQuery"]);
    expect(emptyActions({ filters: EMPTY_LISTING_FILTERS, q: "a" })).toEqual(["clearQuery"]);
  });
  it("chip removal and reset land back on the empty state, 1:1 with the chips", () => {
    let f = parseListing(route, []).filters;
    for (const c of appliedChips(f)) f = removeChip(f, c);
    expect(f).toEqual(EMPTY_LISTING_FILTERS);
  });
  it("only counts the API: no total means no count", () => {
    expect(resultsCount(undefined)).toBeNull();
    expect(resultsCount(12)).toBe(12);
  });
});

describe("screen source has no filter controls outside the sheet", () => {
  const src = readFileSync(fileURLToPath(new URL("./ShopAllScreen.tsx", import.meta.url)), "utf8");
  it("drops the quick chips, category chip row, department filter avatars and the old sheet", () => {
    for (const gone of ["shop-all-chip-", "BoardChip", "FiltersSheet", "quickBar", "shop-all-departments", "setOnSale", "shopAll.onSale", "shopAll.categoryChips"]) {
      expect(src).not.toContain(gone);
    }
  });
  it("renders the one filter icon, the applied chips and the shared sheet", () => {
    expect(src.match(/<FilterButton/g)).toHaveLength(1);
    expect(src).toContain("<AppliedChips");
    expect(src).toContain("<FilterSheet");
  });
  it("shows no fake social proof or uppercase store names", () => {
    expect(src.toLowerCase()).not.toMatch(/trending|viral|bestseller/);
    expect(readFileSync(fileURLToPath(new URL("./BoardParts.tsx", import.meta.url)), "utf8")).not.toContain("toUpperCase");
    expect(readFileSync(fileURLToPath(new URL("../search/BoardResults.tsx", import.meta.url)), "utf8")).not.toContain("toUpperCase");
  });
});
