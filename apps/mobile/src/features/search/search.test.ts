import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER, InMemorySearchPort, arrangeResults, activeFilterCount, normalizeQuery, parseBudgetEgp, relaxLeastImportant,
  runSearch, toggleCondition, displayDiscountPct, type SearchFilter, type SearchItem,
} from "./model";

const item = (id: string, sponsored = false): SearchItem => ({ id, title: id, storeName: "s", price: 100n, verifiedDiscountPct: null, sponsored });

describe("query and budget parsing", () => {
  it("folds Eastern Arabic digits and trims", () => {
    expect(normalizeQuery("  فستان   ١٥٠٠ ")).toBe("فستان 1500");
    expect(normalizeQuery("x".repeat(500)).length).toBe(100);
  });
  it("parses budget to piastres", () => {
    expect(parseBudgetEgp("١٥٠٠")).toBe(150_000n);
    expect(parseBudgetEgp("1,500")).toBe(150_000n);
    expect(parseBudgetEgp("0")).toBeNull();
    expect(parseBudgetEgp("12.5")).toBeNull();
    expect(parseBudgetEgp("abc")).toBeNull();
  });
});

describe("filters", () => {
  it("counts active filters and toggles conditions", () => {
    const f = toggleCondition(toggleCondition({ ...EMPTY_FILTER, mySizeOnly: true }, "sample"), "minorDefect");
    expect(activeFilterCount(f)).toBe(3);
    expect(toggleCondition(f, "sample").conditions).toEqual(["minorDefect"]);
  });
  it("relaxes least important first and ends with null", () => {
    let f: SearchFilter = { ...EMPTY_FILTER, budgetMax: 1n, mySizeOnly: true, installmentsAvailable: true };
    const order: string[] = [];
    for (let r = relaxLeastImportant(f); r !== null; r = relaxLeastImportant(f)) { order.push(r.dropped); f = r.filter; }
    expect(order).toEqual(["installmentsAvailable", "mySizeOnly", "budgetMax"]);
  });
});

describe("sponsored cap", () => {
  it("keeps at most two sponsored in the top ten and preserves order", () => {
    const items = [item("s1", true), item("s2", true), item("s3", true), ...Array.from({ length: 12 }, (_, i) => item(`n${i}`))];
    const out = arrangeResults(items);
    expect(out.slice(0, 10).filter((i) => i.sponsored)).toHaveLength(2);
    expect(out).toHaveLength(items.length);
    expect(out.slice(0, 10).map((i) => i.id)).toEqual(["s1", "s2", "n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
  });
});

describe("discount display", () => {
  it("needs a verified integer percent of at least 5", () => {
    expect(displayDiscountPct({ verifiedDiscountPct: null })).toBeNull();
    expect(displayDiscountPct({ verifiedDiscountPct: 4 })).toBeNull();
    expect(displayDiscountPct({ verifiedDiscountPct: 30 })).toBe(30);
  });
});

describe("runSearch", () => {
  it("is idle with no query and no filters", async () => {
    expect((await runSearch(new InMemorySearchPort(), "  ", EMPTY_FILTER)).kind).toBe("idle");
  });
  it("returns results", async () => {
    const o = await runSearch(new InMemorySearchPort(), "jeans", EMPTY_FILTER);
    expect(o.kind).toBe("results");
  });
  it("relaxes on zero results and reports what was dropped", async () => {
    const o = await runSearch(new InMemorySearchPort(), "jeans", { ...EMPTY_FILTER, installmentsAvailable: true, conditions: ["sample"] });
    expect(o.kind).toBe("relaxed");
    if (o.kind === "relaxed") expect(o.dropped).toEqual(["installmentsAvailable", "conditions"]);
  });
  it("is empty when nothing matches even unfiltered", async () => {
    expect((await runSearch(new InMemorySearchPort(), "zzz", { ...EMPTY_FILTER, mySizeOnly: true })).kind).toBe("empty");
  });
  it("propagates port failure", async () => {
    const p = new InMemorySearchPort();
    p.setFailure("offline");
    await expect(runSearch(p, "jeans", EMPTY_FILTER)).rejects.toMatchObject({ kind: "offline" });
  });
  it("live count equals result count", async () => {
    const p = new InMemorySearchPort();
    const f = { ...EMPTY_FILTER, mySizeOnly: true };
    expect(await p.count("", f)).toBe((await p.search("", f)).total);
  });
});

import { addRecent, decodeRecents, encodeRecents } from "./model";
describe("recent searches", () => {
  it("dedupes case-insensitively, caps at 8 and folds digits", () => {
    expect(addRecent(["Jeans", "dress"], "  jeans ")).toEqual(["jeans", "dress"]);
    expect(addRecent(["a"], "   ")).toEqual(["a"]);
    let l: readonly string[] = [];
    for (let i = 0; i < 12; i++) l = addRecent(l, `q${i}`);
    expect(l).toHaveLength(8);
    expect(l[0]).toBe("q11");
    expect(addRecent([], "تحت ١٥٠٠")).toEqual(["تحت 1500"]);
  });
  it("round-trips and survives corrupt storage", () => {
    expect(decodeRecents(encodeRecents(["a", "b"]))).toEqual(["a", "b"]);
    expect(decodeRecents("{bad")).toEqual([]);
    expect(decodeRecents(null)).toEqual([]);
    expect(decodeRecents('[1,"x"]')).toEqual(["x"]);
  });
});

import { groupSuggestions } from "./model";
import { SORT_WIRE, filterToWire, readFacetCounts } from "./api";

describe("groupSuggestions (inline search panel)", () => {
  it("orders queries, then stores, then categories, capped at 5", () => {
    const out = groupSuggestions({
      queries: ["a", "b", "c"],
      stores: [{ id: "s1", name: "Store 1" }, { id: "s2", name: "Store 2" }],
      categories: [{ id: "c1", name: "Cat" }],
    });
    expect(out.map((x) => x.kind)).toEqual(["query", "query", "query", "store", "store"]);
    expect(out).toHaveLength(5);
  });
  it("drops blanks and duplicates, trims, and fills from later kinds", () => {
    const out = groupSuggestions({ queries: [" dress ", "dress", "  "], stores: [], categories: [{ id: "c1", name: "Dresses" }] });
    expect(out).toEqual([{ kind: "query", id: null, label: "dress" }, { kind: "category", id: "c1", label: "Dresses" }]);
  });
  it("max 0 returns nothing", () => {
    expect(groupSuggestions({ queries: ["a"], stores: [], categories: [] }, 0)).toEqual([]);
  });
});

describe("wire: facet_counts and sort", () => {
  it("maps typed facet buckets to records and keeps absence as undefined", () => {
    expect(readFacetCounts(undefined)).toBeUndefined();
    expect(readFacetCounts({ category_ids: [{ id: "a", count: 3 }, { id: "b", count: 1 }], store_ids: [] })).toEqual({ categoryIds: { a: 3, b: 1 }, storeIds: {} });
  });
  it("sort is a query parameter, never part of the filters JSON", () => {
    const f: SearchFilter = { ...EMPTY_FILTER, sort: "discount" };
    expect("sort" in filterToWire(f)).toBe(false);
  });
  it("sort ids map to the wire allow-list", () => {
    expect(SORT_WIRE).toEqual({ priceLow: "price_asc", priceHigh: "price_desc", discount: "biggest_verified_discount" });
  });
});
