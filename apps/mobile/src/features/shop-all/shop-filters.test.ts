import { describe, expect, it } from "vitest";
import {
  BUDGET_PRESETS, DISCOUNT_STEPS, EMPTY_SHOP_FILTERS, appliedCountKey, appliedFilters, FIXTURE_CATEGORIES, InMemoryCategoryPort, MAX_CATEGORY_FILTER, NO_BUDGET, activeFacetCount, depthOf, descendantIds,
  emptyActions, expandCategoryIds, foldDigits, hasRouteFilters, parseBudgetFields, parseEgpToPiastres, parseShopRouteParams, piastresToField,
  resolveCategoryParam, resultsCount, sameBudget, searchCategories, shopFiltersReducer, stepBound, summarizeBudget, toSearchFilter, withMinMax,
  type CategoryNode,
} from "./model";
import { filterToWire } from "../search/api";
import { InMemorySearchPort } from "../search/model";


/** Seeded property loop (fast-check is not a dependency of apps/mobile; no installs allowed here). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function forAll(runs: number, body: (r: () => number) => boolean): void {
  const r = rng(20261012);
  for (let i = 0; i < runs; i++) expect(body(r)).toBe(true);
}
const rint = (r: () => number, max: number): number => Math.floor(r() * (max + 1));
const rbig = (r: () => number, max: bigint): bigint => BigInt(rint(r, Number(max > 9_000_000_000n ? 9_000_000_000n : max)));

const TREE = FIXTURE_CATEGORIES;
const id = (slug: string): string => TREE.find((n) => n.slug === slug)?.id ?? "missing";

describe("digit and piastre parsing", () => {
  it("folds Eastern Arabic, Persian digits and separators", () => {
    expect(foldDigits("١٢٣٤")).toBe("1234");
    expect(foldDigits("۱۲۳")).toBe("123");
    expect(foldDigits("١٬٢٥٠٫٥٠")).toBe("1250.50");
  });
  it("parses EGP to piastres without floats", () => {
    expect(parseEgpToPiastres("500")).toBe(50_000n);
    expect(parseEgpToPiastres("٥٠٠")).toBe(50_000n);
    expect(parseEgpToPiastres("1,250.5")).toBe(125_050n);
    expect(parseEgpToPiastres("0.07")).toBe(7n);
    expect(parseEgpToPiastres("19.99")).toBe(1_999n);
  });
  it("rejects negative, malformed, too large and empty", () => {
    for (const bad of ["-5", "abc", "1.234", "", "  ", "12345678", "1e3", "5٫", "."]) expect(parseEgpToPiastres(bad)).toBeNull();
  });
  it("round-trips any whole-piastre value through the field string", () => {
    forAll(500, (r) => { const p = rbig(r, 999_999_999n); return parseEgpToPiastres(piastresToField(p)) === p; });
  });
  it("Arabic-digit rendering parses to the same piastres as ASCII", () => {
    const toAr = (s: string): string => s.replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)] ?? d);
    forAll(500, (r) => { const p = rbig(r, 999_999_999n); return parseEgpToPiastres(toAr(piastresToField(p))) === p; });
  });
  it("piastres are always whole EGP times 100 plus 0..99", () => {
    forAll(500, (r) => {
      const w = rint(r, 9_999_999);
      const f = rint(r, 99);
      const raw = `${w}.${String(f).padStart(2, "0")}`;
      return parseEgpToPiastres(raw) === BigInt(w) * 100n + BigInt(f);
    });
  });
});

describe("budget fields", () => {
  it("accepts open bounds and ranges", () => {
    expect(parseBudgetFields("", "").budget).toEqual(NO_BUDGET);
    expect(parseBudgetFields("", "500")).toMatchObject({ ok: true, budget: { min: null, max: 50_000n } });
    expect(parseBudgetFields("١٠٠", "٥٠٠")).toMatchObject({ ok: true, budget: { min: 10_000n, max: 50_000n } });
  });
  it("flags min > max, negatives and garbage", () => {
    expect(parseBudgetFields("600", "300").errors.range).toBe("minAboveMax");
    expect(parseBudgetFields("-1", "300").errors.min).toBe("invalid");
    expect(parseBudgetFields("", "x").errors.max).toBe("invalid");
    expect(parseBudgetFields("600", "600").ok).toBe(true);
  });
  it("property: ok implies min <= max and both non-negative", () => {
    const alphabet = "0123456789-.,٠١٢٣٤٥٦٧٨٩ x";
    const rs = (r: () => number): string => Array.from({ length: rint(r, 8) }, () => alphabet[rint(r, alphabet.length - 1)] ?? "").join("");
    forAll(1000, (r) => {
      const a = rs(r);
      const b = rs(r);
      const res = parseBudgetFields(a, b);
      if (!res.ok) return true;
      const { min, max } = res.budget;
      return (min === null || min >= 0n) && (max === null || max >= 0n) && (min === null || max === null || min <= max);
    });
  });
  it("presets are ordered and valid", () => {
    for (const p of BUDGET_PRESETS) {
      const { min, max } = p.budget;
      expect(min === null || max === null || min <= max).toBe(true);
    }
    expect(BUDGET_PRESETS.find((p) => p.id === "300to600")?.budget).toEqual({ min: 30_000n, max: 60_000n });
  });
  it("steppers clamp at zero and keep min <= max", () => {
    expect(stepBound(null, -3)).toBe(0n);
    expect(stepBound(10_000n, 2)).toBe(20_000n);
    expect(withMinMax({ min: 1_000n, max: 5_000n }, "min", 9_000n)).toEqual({ min: 9_000n, max: 9_000n });
    expect(withMinMax({ min: 4_000n, max: 5_000n }, "max", 2_000n)).toEqual({ min: 2_000n, max: 2_000n });
    expect(sameBudget({ min: null, max: 1n }, { min: null, max: 1n })).toBe(true);
  });
  it("summarises the applied range", () => {
    const fmt = (p: bigint): string => `${p / 100n}`;
    expect(summarizeBudget({ min: 10_000n, max: 50_000n }, fmt)).toEqual({ kind: "range", min: "100", max: "500" });
    expect(summarizeBudget({ min: null, max: 50_000n }, fmt)).toEqual({ kind: "upTo", max: "500" });
    expect(summarizeBudget({ min: 10_000n, max: null }, fmt)).toEqual({ kind: "from", min: "100" });
    expect(summarizeBudget(NO_BUDGET, fmt).kind).toBe("none");
  });
});

describe("category tree", () => {
  it("expands a parent to its subtree and caps at the facet limit", () => {
    expect(descendantIds(TREE, id("tops"))).toEqual([id("tops"), id("tshirts"), id("shirts")]);
    const big: CategoryNode[] = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, slug: `c${i}`, nameEn: `C${i}`, nameAr: `ف${i}`, parentId: null }));
    expect(expandCategoryIds(big, big.map((n) => n.id))).toHaveLength(MAX_CATEGORY_FILTER);
  });
  it("is cycle safe", () => {
    const cyc: CategoryNode[] = [
      { id: "a", slug: "a", nameEn: "A", nameAr: "أ", parentId: "b" },
      { id: "b", slug: "b", nameEn: "B", nameAr: "ب", parentId: "a" },
    ];
    expect(descendantIds(cyc, "a")).toEqual(["a", "b"]);
    expect(depthOf(cyc, "a")).toBeLessThan(3);
  });
  it("searches both languages with Arabic folding", () => {
    expect(searchCategories(TREE, "shirt").map((n) => n.slug)).toEqual(expect.arrayContaining(["tshirts", "shirts"]));
    expect(searchCategories(TREE, "تيشيرت").map((n) => n.slug)).toContain("tshirts");
    expect(searchCategories(TREE, "فسـاتين").length + searchCategories(TREE, "فساتين").length).toBeGreaterThan(0);
    expect(searchCategories(TREE, "").length).toBe(TREE.length);
    expect(depthOf(TREE, id("tshirts"))).toBe(1);
  });
  it("resolves slug or id params", () => {
    expect(resolveCategoryParam(TREE, "Tops")).toBe(id("tops"));
    expect(resolveCategoryParam(TREE, id("denim"))).toBe(id("denim"));
    expect(resolveCategoryParam(TREE, "nope")).toBeNull();
    expect(resolveCategoryParam(TREE, undefined)).toBeNull();
  });
  it("in-memory port returns the tree", async () => {
    expect((await new InMemoryCategoryPort().tree()).length).toBe(TREE.length);
  });
});

describe("filter state and serialization", () => {
  it("reduces", () => {
    let s = shopFiltersReducer(EMPTY_SHOP_FILTERS, { type: "setQuery", q: "tshirt" });
    s = shopFiltersReducer(s, { type: "toggleCategory", id: id("tops") });
    s = shopFiltersReducer(s, { type: "setBudget", budget: { min: null, max: 50_000n } });
    expect(s).toMatchObject({ q: "tshirt", categoryIds: [id("tops")], budget: { max: 50_000n } });
    expect(shopFiltersReducer(s, { type: "toggleCategory", id: id("tops") }).categoryIds).toEqual([]);
    expect(shopFiltersReducer(s, { type: "clearBudget" }).budget).toEqual(NO_BUDGET);
    expect(shopFiltersReducer(s, { type: "clearAll" })).toEqual(EMPTY_SHOP_FILTERS);
  });
  it("serialises AND of stores + category + budget to wire JSON in piastres", () => {
    const f = { ...EMPTY_SHOP_FILTERS, q: "tshirt", categoryIds: [id("tops")], budget: { min: 10_000n, max: 50_000n }, department: null };
    const sf = toSearchFilter(["s1", "s2"], f, TREE);
    const wire = filterToWire(sf);
    expect(wire.store_ids).toEqual(["s1", "s2"]);
    expect(wire.category_ids).toEqual([id("tops"), id("tshirts"), id("shirts")]);
    expect(wire.price_min).toEqual({ amount: "10000", currency: "EGP" });
    expect(wire.price_max).toEqual({ amount: "50000", currency: "EGP" });
    expect(wire.world).toBe("everything");
  });
  it("omits absent facets", () => {
    const wire = filterToWire(toSearchFilter([], EMPTY_SHOP_FILTERS, TREE));
    expect(Object.keys(wire)).toEqual(["world"]);
  });
  it("caps wire stores and categories at 30", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
    expect(toSearchFilter(ids, EMPTY_SHOP_FILTERS, TREE).storeIds).toHaveLength(30);
  });
  it("property: wire price range never inverts and is integer strings", () => {
    forAll(500, (r) => {
      const a = rbig(r, 100_000_000n);
      const b = rbig(r, 100_000_000n);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const w = filterToWire(toSearchFilter([], { ...EMPTY_SHOP_FILTERS, budget: { min: lo, max: hi } }, TREE));
      return BigInt(w.price_min?.amount ?? "0") <= BigInt(w.price_max?.amount ?? "0") && /^\d+$/.test(w.price_max?.amount ?? "");
    });
  });
  it("department: parsed from the route, serialised as departments, combined with category and budget, removable", async () => {
    const f = parseShopRouteParams({ department: "women", category: "tops", max: "500" }, TREE);
    expect(f).toMatchObject({ department: "women", categoryIds: [id("tops")], budget: { max: 50_000n } });
    expect(parseShopRouteParams({ department: "accessories" }, TREE)).toEqual(EMPTY_SHOP_FILTERS);
    expect(hasRouteFilters({ department: "kids" })).toBe(true);
    expect(hasRouteFilters({ department: "nope" })).toBe(false);
    // "unisex" is an invisible, uncleanable filter: a route may not set it, count it or show it.
    expect(parseShopRouteParams({ department: "unisex" }, TREE)).toEqual(EMPTY_SHOP_FILTERS);
    expect(parseShopRouteParams({ department: "unisex", category: "tops" }, TREE).department).toBeNull();
    expect(hasRouteFilters({ department: "unisex" })).toBe(false);
    expect(shopFiltersReducer(EMPTY_SHOP_FILTERS, { type: "setDepartment", department: "unisex" }).department).toBeNull();
    expect(toSearchFilter([], parseShopRouteParams({ department: "unisex" }, TREE), TREE).department).toBeUndefined();
    const wire = filterToWire(toSearchFilter([], f, TREE));
    expect(wire.departments).toEqual(["women"]);
    expect(wire.category_ids).toEqual([id("tops"), id("tshirts"), id("shirts")]);
    expect(wire.price_max).toBeDefined();
    expect(activeFacetCount([], f)).toBe(3);
    const cleared = shopFiltersReducer(f, { type: "clearDepartment" });
    expect(cleared.department).toBeNull();
    expect(filterToWire(toSearchFilter([], cleared, TREE)).departments).toBeUndefined();
    expect(emptyActions([], f)).toContain("clearDepartment");
    // Fake dev search: women also sees unisex, never men or kids.
    const port = new InMemorySearchPort();
    const women = await port.search("", toSearchFilter([], { ...EMPTY_SHOP_FILTERS, department: "women" }, TREE));
    expect(women.items.map((i) => i.department)).toEqual(["women", "unisex"]);
    const kids = await port.search("", toSearchFilter([], { ...EMPTY_SHOP_FILTERS, department: "kids" }, TREE));
    expect(kids.items.map((i) => i.department)).toEqual(["kids"]);
  });
  it("counts facets, count header and empty actions", () => {
    const f = { ...EMPTY_SHOP_FILTERS, q: "x", categoryIds: [id("tops")], budget: { min: null, max: 1n }, department: null };
    expect(activeFacetCount(["s1"], f)).toBe(4);
    expect(activeFacetCount([], EMPTY_SHOP_FILTERS)).toBe(0);
    expect(resultsCount(undefined)).toBeNull();
    expect(resultsCount(12)).toBe(12);
    expect(emptyActions(["s1"], f)).toEqual(["raiseBudget", "clearCategory", "clearStores", "clearQuery"]);
    expect(emptyActions([], EMPTY_SHOP_FILTERS)).toEqual([]);
  });
});

describe("route params", () => {
  it("pre-applies category, query and EGP bounds", () => {
    const f = parseShopRouteParams({ category: "tops", q: "tshirt", max: "500" }, TREE);
    expect(f).toEqual({ ...EMPTY_SHOP_FILTERS, q: "tshirt", categoryIds: [id("tops")], budget: { min: null, max: 50_000n }, department: null });
  });
  it("accepts Arabic digits and query, ignores bad parts, repairs inverted ranges", () => {
    expect(parseShopRouteParams({ q: "تيشيرت", max: "٥٠٠" }, TREE)).toMatchObject({ q: "تيشيرت", budget: { max: 50_000n } });
    expect(parseShopRouteParams({ category: "zzz", min: "-5", max: "abc" }, TREE)).toEqual(EMPTY_SHOP_FILTERS);
    expect(parseShopRouteParams({ min: "900", max: "100" }, TREE).budget).toEqual({ min: null, max: 10_000n });
  });
  it("detects presence", () => {
    expect(hasRouteFilters({})).toBe(false);
    expect(hasRouteFilters({ q: " " })).toBe(false);
    expect(hasRouteFilters({ max: "5" })).toBe(true);
  });
});

describe("fake search applies price and category", () => {
  it("returns only items inside the budget", async () => {
    const port = new InMemorySearchPort();
    const page = await port.search("", { ...toSearchFilter([], { ...EMPTY_SHOP_FILTERS, budget: { min: null, max: 80_000n } }, TREE) });
    expect(page.items.every((i) => i.price <= 80_000n)).toBe(true);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.totalEstimate).toBe(page.items.length);
  });
});

import { AVATAR_DEPARTMENTS, cellPadding, filterBadgeCount, gridGap, heroChipCategories, isCategoryLayout, listKey, toSearchFilter as toSF, FIXTURE_CATEGORIES as FC, EMPTY_SHOP_FILTERS as EF, NO_BUDGET as NB } from "./model";
import { anchorIndexAfterChange, cardDetailLevel } from "../grid-density/model";

describe("grid layout helpers", () => {
  it("cell paddings give equal widths and the full gap between columns", () => {
    for (const cols of [1, 2, 3, 4]) {
      const gap = gridGap(cols);
      const pads = Array.from({ length: cols }, (_, i) => cellPadding(i, cols, gap));
      const widths = pads.map((p) => 100 - p.left - p.right);
      expect(new Set(widths.map((w) => w.toFixed(6))).size).toBe(1);
      for (let i = 0; i < cols - 1; i += 1) expect((pads[i]?.right ?? 0) + (pads[i + 1]?.left ?? 0)).toBeCloseTo(gap);
    }
  });
  it("keys remount per density", () => {
    expect(listKey(2)).not.toBe(listKey(3));
  });
  it("badge counts sheet filters only", () => {
    expect(filterBadgeCount([], { ...EF, q: "dress" }, false)).toBe(0);
    expect(filterBadgeCount(["a", "b"], { ...EF, categoryIds: ["c"], budget: { min: null, max: 100n }, department: "women" }, true)).toBe(6);
    expect(filterBadgeCount([], { ...EF, department: "unisex", budget: NB }, false)).toBe(0);
  });
  it("on sale sets verifiedDiscountOnly only when asked", () => {
    expect(toSF([], EF, FC).verifiedDiscountOnly).toBe(false);
    expect(toSF([], EF, FC, true).verifiedDiscountOnly).toBe(true);
  });
  it("category layout only for department or category routes without a collection", () => {
    expect(isCategoryLayout({ department: "women" }, false)).toBe(true);
    expect(isCategoryLayout({ category: "tops" }, false)).toBe(true);
    expect(isCategoryLayout({ department: "women" }, true)).toBe(false);
    expect(isCategoryLayout({ q: "x", department: "bogus" }, false)).toBe(false);
    expect(isCategoryLayout(undefined, false)).toBe(false);
  });
  it("hero chips are real top-level categories, capped", () => {
    const chips = heroChipCategories(FC);
    expect(chips.length).toBeLessThanOrEqual(5);
    expect(chips.every((c) => c.parentId === null)).toBe(true);
  });
  it("departments avatars exclude unisex; anchor survives a density change", () => {
    expect(AVATAR_DEPARTMENTS).not.toContain("unisex");
    expect(anchorIndexAfterChange([{ id: "a" }, { id: "b" }, { id: "c" }], "c")).toBe(2);
    expect(cardDetailLevel(4).showName).toBe(false);
  });

  describe("Phase A facets", () => {
    const R = (a: Parameters<typeof shopFiltersReducer>[1], from = EMPTY_SHOP_FILTERS) => shopFiltersReducer(from, a);
    it("sets and clears the verified discount floor, rejecting non-step values", () => {
      expect(R({ type: "setMinDiscount", pct: 30 }).minDiscountPct).toBe(30);
      expect(R({ type: "setMinDiscount", pct: null }, R({ type: "setMinDiscount", pct: 30 })).minDiscountPct).toBeNull();
      expect(R({ type: "setMinDiscount", pct: 7 as never }).minDiscountPct).toBeNull();
      expect(DISCOUNT_STEPS).toEqual([10, 20, 30, 50]);
    });
    it("toggles flags and conditions independently, keeping condition order stable", () => {
      const a = R({ type: "toggleFlag", flag: "freeDelivery" });
      expect(a.freeDelivery).toBe(true);
      expect(R({ type: "toggleFlag", flag: "freeDelivery" }, a).freeDelivery).toBe(false);
      const c = R({ type: "toggleCondition", condition: "minorDefect" }, R({ type: "toggleCondition", condition: "newWithTags" }));
      expect(c.conditions).toEqual(["newWithTags", "minorDefect"]);
      expect(R({ type: "toggleCondition", condition: "minorDefect" }, c).conditions).toEqual(["newWithTags"]);
    });
    it("maps every facet to the wire, and omits them when off", () => {
      const f = { ...EMPTY_SHOP_FILTERS, minDiscountPct: 20 as const, lowest30d: true, freeDelivery: true, newArrivals: true, conditions: ["sample" as const] };
      const wire = filterToWire(toSearchFilter([], f, TREE));
      expect(wire).toMatchObject({ min_verified_discount_pct: 20, lowest_30d_only: true, free_delivery_eligible: true, new_arrivals: true, conditions: ["sample"] });
      expect(wire.verified_discount_only).toBeUndefined();
      const plain = filterToWire(toSearchFilter([], EMPTY_SHOP_FILTERS, TREE));
      for (const k of ["min_verified_discount_pct", "lowest_30d_only", "free_delivery_eligible", "new_arrivals", "conditions"]) expect(plain).not.toHaveProperty(k);
    });
    it("never sends an unverified or out-of-range discount percent", () => {
      expect(filterToWire({ ...toSearchFilter([], EMPTY_SHOP_FILTERS, TREE), minVerifiedDiscountPct: 3 })).not.toHaveProperty("min_verified_discount_pct");
      expect(filterToWire({ ...toSearchFilter([], EMPTY_SHOP_FILTERS, TREE), minVerifiedDiscountPct: 12.5 })).not.toHaveProperty("min_verified_discount_pct");
      expect(filterToWire(toSearchFilter([], EMPTY_SHOP_FILTERS, TREE, true)).verified_discount_only).toBe(true);
    });
    it("counts the badge and applied chips, and clearAll resets every facet", () => {
      const f = { ...EMPTY_SHOP_FILTERS, minDiscountPct: 10 as const, lowest30d: true, conditions: ["sample" as const, "newWithTags" as const] };
      expect(filterBadgeCount([], f, false)).toBe(4);
      expect(filterBadgeCount([], f, true)).toBe(5);
      expect(activeFacetCount([], f)).toBe(4);
      expect(appliedFilters([], EMPTY_SHOP_FILTERS, false)).toEqual([]);
      expect(appliedFilters(["s1"], f, true)).toHaveLength(6);
      expect(R({ type: "clearAll" }, f)).toEqual(EMPTY_SHOP_FILTERS);
    });
    it("badge equals applied chips (minus search and unisex) for random states", () => {
      forAll(200, (r) => {
        const f = {
          ...EMPTY_SHOP_FILTERS,
          minDiscountPct: r() < 0.5 ? DISCOUNT_STEPS[rint(r, 3)] ?? null : null,
          lowest30d: r() < 0.5, freeDelivery: r() < 0.5, newArrivals: r() < 0.5,
          conditions: (["newWithTags", "newWithoutTags", "sample", "minorDefect"] as const).filter(() => r() < 0.5),
        };
        const onSale = r() < 0.5;
        return filterBadgeCount([], f, onSale) === appliedFilters([], f, onSale).length;
      });
    });
    it("picks the Arabic plural key", () => {
      expect([0, 1, 2, 3, 10, 11, 99, 100, 101, 102, 103, 110, 111].map(appliedCountKey)).toEqual(
        ["appliedOther", "appliedOne", "appliedTwo", "appliedFew", "appliedFew", "appliedMany", "appliedMany", "appliedOther", "appliedOther", "appliedOther", "appliedFew", "appliedFew", "appliedMany"]);
    });
  });
});
