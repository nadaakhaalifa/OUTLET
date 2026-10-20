import { describe, expect, it } from "vitest";
import { CONDITIONS } from "../search/model";
import { filterToWire } from "../search/api";
import { FIXTURE_CATEGORIES } from "../shop-all/model";
import type { StoreSummary } from "../worlds/model";
import {
  EMPTY_LISTING_FILTERS, INITIAL_COUNT, MAX_FACET_VALUES, MAX_ROUTE_PARAM_LENGTH, appliedChips, atFacetCap, cancelCount, categoriesIncludeSubtree, countWireFacets, facetTotal, sanitizeForSession, badgeCount, beginCount, brandRows, chipFilterKey, countUnavailable, failCount,
  footerCount, isEmptyListing, listingReducer, normalize, parseRouteParams, resolveCount, sectionSelectedCount, toRouteParams, toSearchFilter, visibleSections,
  type ListingAction, type ListingFilters,
} from "./model";

const store = (id: string, name: string, over: Partial<StoreSummary> = {}): StoreSummary => ({
  id, name, kind: "local", status: "active", maxVerifiedDiscountPct: null, rating: null, followerCount: 0, liveDrop: false, trendingRank: 1, newestDropAtMs: null, deliveryDays: null, isFavourite: false, ...over,
});

/** Seeded property loop (fast-check is not a dependency of apps/mobile; no installs allowed here). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pickOf = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const IDS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "A", "B", "C", "D", "E", "F", "G", "H", "1", "2", "3", "4"];
function genAction(r: () => number): ListingAction {
  switch (Math.floor(r() * 9)) {
    case 0: return { type: "toggleStore", id: pickOf(r, IDS) };
    case 1: return { type: "toggleCategory", id: pickOf(r, IDS) };
    case 2: { const x = r() < 0.2 ? null : BigInt(Math.floor(r() * 10_000)); const y = r() < 0.2 ? null : BigInt(Math.floor(r() * 10_000)); return { type: "setPrice", min: x, max: y }; }
    case 3: return { type: "setFitsBudget", value: r() < 0.5 };
    case 4: return { type: "setMinDiscount", pct: pickOf(r, [10, 20, 30, 50, null] as const) };
    case 5: return { type: "toggleFlag", flag: pickOf(r, ["lowest30d", "freeDelivery", "newArrivals"] as const) };
    case 6: return { type: "toggleCondition", condition: pickOf(r, CONDITIONS) };
    case 7: return { type: "setDepartment", department: pickOf(r, ["women", "men", "kids", "unisex", null] as const) };
    default: return { type: "setSort", sort: pickOf(r, ["relevance", "priceLow", "priceHigh", "discount"] as const) };
  }
}
/** Runs `check` on 300 random action sequences (length up to `max`). */
function forSequences(check: (acts: readonly ListingAction[]) => void, max = 40): void {
  const r = rng(20261016);
  for (let i = 0; i < 300; i++) check(Array.from({ length: Math.floor(r() * max) }, () => genAction(r)));
}
const run = (actions: readonly ListingAction[]): ListingFilters => actions.reduce(listingReducer, EMPTY_LISTING_FILTERS);

describe("reducer properties", () => {
  it("apply then reset returns EMPTY_LISTING_FILTERS", () => {
    forSequences((acts) => { expect(listingReducer(run(acts), { type: "reset" })).toEqual(EMPTY_LISTING_FILTERS); });
  });
  it("normalize is idempotent and every reachable state is normalized", () => {
    forSequences((acts) => { const s = run(acts); expect(normalize(s)).toEqual(s); expect(normalize(normalize(s))).toEqual(normalize(s)); });
  });
  it("chips match applied state 1:1: removing every chip empties the filters", () => {
    forSequences((acts) => {
      let s = run(acts);
      for (const c of appliedChips(s)) s = listingReducer(s, { type: "removeChip", chip: c });
      expect(s).toEqual(EMPTY_LISTING_FILTERS);
      expect(isEmptyListing(s)).toBe(true);
    });
  });
  it("30-facet cap: lists never exceed 30 and the 31st pick is refused", () => {
    const r = rng(7);
    for (let i = 0; i < 100; i++) {
      const ids = Array.from({ length: 80 }, () => `${pickOf(r, IDS)}${pickOf(r, IDS)}`);
      const s = ids.reduce<ListingFilters>((a, id) => listingReducer(listingReducer(a, { type: "toggleStore", id }), { type: "toggleCategory", id }), EMPTY_LISTING_FILTERS);
      expect(s.storeIds.length).toBeLessThanOrEqual(MAX_FACET_VALUES);
      expect(s.categoryIds.length).toBeLessThanOrEqual(MAX_FACET_VALUES);
      expect(new Set(s.storeIds).size).toBe(s.storeIds.length);
    }
    // World is always reserved (1), so 29 stores fill the 30-facet total.
    const full = Array.from({ length: 29 }, (_, i) => `s${i}`).reduce<ListingFilters>((a, id) => listingReducer(a, { type: "toggleStore", id }), EMPTY_LISTING_FILTERS);
    expect(full.storeIds).toHaveLength(29);
    expect(facetTotal(full)).toBe(30);
    expect(atFacetCap(full, "store")).toBe(true);
    expect(listingReducer(full, { type: "toggleStore", id: "extra" })).toEqual(full);
    expect(listingReducer(full, { type: "toggleStore", id: "s0" }).storeIds).toHaveLength(28);
  });
  it("the cap is the TOTAL across facets (29 / 30 / 31 boundary), as the server counts it", () => {
    const pick = (stores: number, cats: number): ListingFilters => ({
      ...EMPTY_LISTING_FILTERS, storeIds: Array.from({ length: stores }, (_, i) => `s${i}`), categoryIds: Array.from({ length: cats }, (_, i) => `c${i}`),
    });
    // 14 stores + 14 categories + 1 reserved world = 29: one more of anything fits, then nothing does.
    const at29 = pick(14, 14);
    expect(facetTotal(at29)).toBe(29);
    expect(atFacetCap(at29)).toBe(false);
    const at30 = listingReducer(at29, { type: "toggleCategory", id: "new" });
    expect(facetTotal(at30)).toBe(30);
    expect(atFacetCap(at30)).toBe(true);
    // The 31st facet of ANY kind is refused: another store, a condition, a flag, a price bound.
    for (const a of [{ type: "toggleStore", id: "x" }, { type: "toggleCondition", condition: "sample" }, { type: "toggleFlag", flag: "newArrivals" }, { type: "setMinDiscount", pct: 20 }, { type: "setPrice", min: 1n, max: null }] as const) {
      expect(listingReducer(at30, a)).toEqual(at30);
    }
    // Removing always works, and the real wire filter never exceeds 30 for any reachable state.
    expect(facetTotal(listingReducer(at30, { type: "toggleStore", id: "s0" }))).toBe(29);
    const wire = toSearchFilter(at30, [], { world: "everything" });
    expect(countWireFacets(filterToWire(wire))).toBe(30);
    // A hostile state (31+) is trimmed by normalize.
    expect(facetTotal(normalize(pick(30, 30)))).toBeLessThanOrEqual(30);
  });
  it("subcategory expansion that would exceed the cap falls back to the picked categories, never truncates", () => {
    const parent = FIXTURE_CATEGORIES.find((c) => c.slug === "tops")!;
    const s: ListingFilters = { ...EMPTY_LISTING_FILTERS, categoryIds: [parent.id] };
    expect(toSearchFilter(s, FIXTURE_CATEGORIES, { world: "everything" }).categoryIds).toHaveLength(3);
    expect(categoriesIncludeSubtree(s, FIXTURE_CATEGORIES, { world: "everything" })).toBe(true);
    const crowded: ListingFilters = { ...s, storeIds: Array.from({ length: 27 }, (_, i) => `s${i}`) };
    expect(facetTotal(crowded)).toBe(29);
    const sent = toSearchFilter(crowded, FIXTURE_CATEGORIES, { world: "everything" });
    expect(sent.categoryIds).toEqual([parent.id]);
    expect(countWireFacets(filterToWire(sent))).toBeLessThanOrEqual(30);
    expect(categoriesIncludeSubtree(crowded, FIXTURE_CATEGORIES, { world: "everything" })).toBe(false);
  });
  it("rejects an inverted price range", () => {
    const s = listingReducer(EMPTY_LISTING_FILTERS, { type: "setPrice", min: 500n, max: 100n });
    expect(s).toEqual(EMPTY_LISTING_FILTERS);
  });
  it("unisex department is never selectable", () => {
    expect(listingReducer(EMPTY_LISTING_FILTERS, { type: "setDepartment", department: "unisex" }).department).toBeNull();
  });
});

describe("badge, chips, sections", () => {
  it("sort does not count toward the badge but shows as a chip", () => {
    const s = run([{ type: "setSort", sort: "priceLow" }, { type: "toggleStore", id: "a" }]);
    expect(badgeCount(s)).toBe(1);
    expect(appliedChips(s).map(chipFilterKey)).toEqual(["sort", "store"]);
  });
  it("chip filter keys are analytics codes (no values, snake_case)", () => {
    const s = run([{ type: "setFitsBudget", value: true }, { type: "toggleFlag", flag: "freeDelivery" }, { type: "toggleFlag", flag: "lowest30d" }]);
    for (const c of appliedChips(s)) expect(chipFilterKey(c)).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
  });
  it("Budget section is absent when logged out, a setup row without budget or consent, a switch when ready", () => {
    const base = { storeCount: 3, categoryCount: 5, budgetReady: true };
    expect(visibleSections({ ...base, signedIn: false }).some((x) => x.id === "budget")).toBe(false);
    expect(visibleSections({ ...base, signedIn: true, budgetReady: false }).find((x) => x.id === "budget")?.mode).toBe("setup");
    expect(visibleSections({ ...base, signedIn: true }).find((x) => x.id === "budget")?.mode).toBe("normal");
  });
  it("sort is first; sections the data does not support are omitted", () => {
    const ids = visibleSections({ signedIn: false, budgetReady: false, storeCount: 0, categoryCount: 0 }).map((x) => x.id);
    expect(ids).toEqual(["sort", "price", "discount", "more"]);
    expect(visibleSections({ signedIn: true, budgetReady: true, storeCount: 1, categoryCount: 1 }).map((x) => x.id)).toEqual(["sort", "brand", "price", "budget", "categories", "discount", "more"]);
  });
  it("section selected counts", () => {
    const s = run([{ type: "toggleStore", id: "a" }, { type: "toggleStore", id: "b" }]);
    expect(sectionSelectedCount(s, "brand")).toBe(2);
    expect(sectionSelectedCount(s, "price")).toBeNull();
  });
});

describe("wire mapping", () => {
  it("expands categories to subtrees, maps flags, sort and price", () => {
    const tops = FIXTURE_CATEGORIES.find((c) => c.slug === "tops")!;
    const s = run([
      { type: "toggleCategory", id: tops.id }, { type: "toggleStore", id: "s1" }, { type: "setPrice", min: 100n, max: 900n },
      { type: "setMinDiscount", pct: 20 }, { type: "toggleFlag", flag: "newArrivals" }, { type: "setSort", sort: "discount" },
    ]);
    const w = toSearchFilter(s, FIXTURE_CATEGORIES);
    expect(w.categoryIds).toHaveLength(3);
    expect(w).toMatchObject({ storeIds: ["s1"], priceMin: 100n, priceMax: 900n, minVerifiedDiscountPct: 20, newArrivals: true, sort: "discount" });
    expect("sort" in toSearchFilter(EMPTY_LISTING_FILTERS, [])).toBe(false);
  });
  it("fits-my-budget becomes a request-time ceiling only when a remaining budget is passed", () => {
    const s = listingReducer(EMPTY_LISTING_FILTERS, { type: "setFitsBudget", value: true });
    expect(toSearchFilter(s, []).budgetMax).toBeNull();
    expect(toSearchFilter(s, [], { remainingBudget: 70_000n }).budgetMax).toBe(70_000n);
    expect(toSearchFilter(EMPTY_LISTING_FILTERS, [], { remainingBudget: 70_000n }).budgetMax).toBeNull();
  });
});

describe("route round-trip", () => {
  it("parse(toRoute(f)) equals f for any reachable state except fitsBudget", () => {
    forSequences((acts) => {
      const s = { ...run(acts), fitsBudget: false };
      expect(parseRouteParams(toRouteParams(s))).toEqual(s);
    });
  });
  it("never serialises fits-my-budget", () => {
    const p = toRouteParams(listingReducer(EMPTY_LISTING_FILTERS, { type: "setFitsBudget", value: true }));
    expect(p).toEqual({});
  });
  it("ignores invalid parts, resolves category slugs and caps lists", () => {
    const f = parseRouteParams({ category: "tops,nope", department: "unisex", discount: "7", min: "abc", sort: "x", condition: "sample,bad", store: "a b,ok1" }, FIXTURE_CATEGORIES);
    expect(f.categoryIds).toHaveLength(1);
    expect(f.department).toBeNull();
    expect(f.minDiscountPct).toBeNull();
    expect(f.priceMin).toBeNull();
    expect(f.sort).toBe("relevance");
    expect(f.conditions).toEqual(["sample"]);
    expect(f.storeIds).toEqual(["ok1"]);
    const many = parseRouteParams({ store: Array.from({ length: 50 }, (_, i) => `s${i}`).join(",") });
    expect(many.storeIds).toHaveLength(29);
  });
});

describe("Brand rows (stores)", () => {
  const stores = [store("a", "Alpha"), store("b", "Beta"), store("c", "Gamma"), store("d", "Delta", { status: "suspended" })];
  it("pins selected on top in pick order, filters the rest by query, hides suspended", () => {
    const rows = brandRows(stores, ["c", "a"], "", undefined);
    expect(rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(rows.slice(0, 2).every((r) => r.selected)).toBe(true);
    expect(brandRows(stores, ["c"], "bet").map((r) => r.id)).toEqual(["c", "b"]);
  });
  it("counts appear only when the server sent them; no digits otherwise", () => {
    expect(brandRows(stores, [], "").every((r) => r.count === undefined)).toBe(true);
    const rows = brandRows(stores, [], "", { storeIds: { a: 4, b: 0 } });
    expect(rows.find((r) => r.id === "a")?.count).toBe(4);
    expect(rows.find((r) => r.id === "b")?.count).toBe(0);
    expect(rows.find((r) => r.id === "c")?.count).toBeUndefined();
  });
  it("caps at 30 rows", () => {
    const many = Array.from({ length: 80 }, (_, i) => store(`s${i}`, `Store ${i}`));
    expect(brandRows(many, ["s79"], "")).toHaveLength(30);
    expect(brandRows(many, ["s79"], "")[0]?.id).toBe("s79");
  });
});

describe("live count sequencing", () => {
  it("a stale answer never overwrites a newer one (any arrival order)", () => {
    const r = rng(3);
    for (let n = 0; n < 200; n++) {
      const order = [1, 2, 3, 4, 5].map((v) => ({ v, k: r() })).sort((a, b) => a.k - b.k).map((x) => x.v);
      let s = INITIAL_COUNT;
      for (let i = 0; i < 5; i++) s = beginCount(s).state;
      for (const id of order) s = resolveCount(s, id, id * 10);
      expect(s.value).toBe(Math.max(...order) * 10);
      expect(s.accepted).toBe(5);
    }
  });
  it("keeps the last confirmed N after a failure and flags it", () => {
    let s = beginCount(INITIAL_COUNT).state;
    s = resolveCount(s, 1, 42);
    const b = beginCount(s);
    s = failCount(b.state, b.id);
    expect(footerCount(s)).toBe(42);
    expect(countUnavailable(s)).toBe(true);
    const c = beginCount(s);
    s = resolveCount(c.state, c.id, 7);
    expect(footerCount(s)).toBe(7);
    expect(countUnavailable(s)).toBe(false);
  });
  it("no count yet means Show items (null); bad numbers are failures", () => {
    expect(footerCount(INITIAL_COUNT)).toBeNull();
    const b = beginCount(INITIAL_COUNT);
    expect(countUnavailable(resolveCount(b.state, b.id, Number.NaN))).toBe(true);
  });
  it("an old failure does not flag a newer in-flight request", () => {
    let s = beginCount(INITIAL_COUNT).state;
    s = beginCount(s).state;
    expect(countUnavailable(failCount(s, 1))).toBe(false);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resources } from "@outlet/i18n";

describe("every literal i18n key used by the shared components exists in AR and EN", () => {
  const dirs = [__dirname, join(__dirname, "../category-window")];
  const files = dirs.flatMap((d) => readdirSync(d).filter((x) => x.endsWith(".tsx")).map((x) => join(d, x)));
  const lookup = (tree: unknown, key: string): boolean => {
    let cur: unknown = tree;
    for (const part of key.split(".")) {
      if (typeof cur !== "object" || cur === null || !(part in cur)) return false;
      cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === "string";
  };
  it("finds the keys (scan is not vacuous)", () => { expect(files.length).toBeGreaterThanOrEqual(5); });
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const keys = [...src.matchAll(/\bt\("([A-Za-z0-9_.]+)"/g)].map((m) => m[1] as string);
    const plurals = [...src.matchAll(/pluralKey\("([A-Za-z0-9_.]+)"/g)].map((m) => `${m[1]}Other`);
    for (const key of [...new Set([...keys, ...plurals])]) {
      it(`${file.split("/").slice(-2).join("/")}: ${key}`, () => {
        expect(lookup(resources.en, key), "en").toBe(true);
        expect(lookup(resources.ar, key), "ar").toBe(true);
      });
    }
  }
});

describe("count sequencing across close/reopen and pending requests", () => {
  it("an old answer is ignored while a newer request is pending", () => {
    let s = beginCount(INITIAL_COUNT).state;
    const second = beginCount(s);
    s = resolveCount(second.state, 1, 99);
    expect(footerCount(s)).toBeNull();
    s = resolveCount(s, second.id, 5);
    expect(footerCount(s)).toBe(5);
  });
  it("a late response after close and reopen is ignored; ids never reset", () => {
    const first = beginCount(INITIAL_COUNT);
    const closed = cancelCount(first.state);
    expect(resolveCount(closed, first.id, 77)).toEqual(closed);
    const reopened = cancelCount(closed);
    expect(reopened.latest).toBeGreaterThan(closed.latest);
    expect(resolveCount(reopened, first.id, 77).value).toBeNull();
    const next = beginCount(reopened);
    expect(next.id).toBeGreaterThan(first.id);
    expect(footerCount(resolveCount(next.state, next.id, 3))).toBe(3);
    // a late failure from the first open cannot flag the new one
    expect(countUnavailable(failCount(next.state, first.id))).toBe(false);
  });
});

describe("session handling of the budget switch", () => {
  const on = listingReducer(EMPTY_LISTING_FILTERS, { type: "setFitsBudget", value: true });
  it("logged out or without a ready budget, fitsBudget is stripped before counting or applying", () => {
    expect(sanitizeForSession(on, { signedIn: false, budgetReady: true }).fitsBudget).toBe(false);
    expect(sanitizeForSession(on, { signedIn: true, budgetReady: false }).fitsBudget).toBe(false);
    expect(sanitizeForSession(on, { signedIn: true, budgetReady: true }).fitsBudget).toBe(true);
    expect(toSearchFilter(sanitizeForSession(on, { signedIn: false, budgetReady: true }), [], { remainingBudget: 5_000n }).budgetMax).toBeNull();
  });
  it("the chip is not shown when no positive remaining budget is applied", () => {
    expect(appliedChips(on).some((c) => c.key === "fitsBudget")).toBe(true);
    expect(appliedChips(on, { fitsBudgetActive: false }).some((c) => c.key === "fitsBudget")).toBe(false);
    expect(badgeCount(on, { fitsBudgetActive: false })).toBe(0);
    expect(toSearchFilter(on, [], { remainingBudget: 0n }).budgetMax).toBeNull();
  });
});

describe("hostile route params", () => {
  it("ignores arrays, unknown keys, exponent numbers and oversize strings", () => {
    const f = parseRouteParams({ store: ["a", "b"] as unknown as string, evil: "x", min: "1e1", max: "0x10", category: "a".repeat(100_000), discount: "20.5", department: "women,men" });
    expect(f.storeIds).toEqual([]);
    expect(f.priceMin).toBeNull();
    expect(f.priceMax).toBeNull();
    expect(f.minDiscountPct).toBeNull();
    expect(f.department).toBeNull();
    expect(f.categoryIds.length).toBeLessThanOrEqual(1);
    const many = parseRouteParams({ store: Array.from({ length: 5000 }, (_, i) => `s${i}`).join(",") });
    expect(many.storeIds.length).toBeLessThanOrEqual(MAX_FACET_VALUES);
    expect(MAX_ROUTE_PARAM_LENGTH).toBe(4096);
    expect(facetTotal(many)).toBeLessThanOrEqual(30);
  });
});

describe("Brand rows keep a selected unavailable store clearable", () => {
  it("pins a suspended or unloaded selected store as unavailable", () => {
    const stores = [store("a", "Alpha"), store("d", "Delta", { status: "suspended" })];
    const rows = brandRows(stores, ["d", "ghost"], "");
    expect(rows.slice(0, 2).map((r) => [r.id, r.selected, r.unavailable])).toEqual([["d", true, true], ["ghost", true, true]]);
    expect(rows[0]?.name).toBe("Delta");
    expect(rows[1]?.name).toBe("");
    expect(rows.map((r) => r.id)).toContain("a");
    expect(brandRows(stores, ["d"], "zzz").map((r) => r.id)).toEqual(["d"]);
  });
});

describe("FilterSheet source guards (no RN renderer in apps/mobile)", () => {
  const src = readFileSync(join(__dirname, "FilterSheet.tsx"), "utf8");
  it("seeds the price draft from the applied filters, not the draft", () => {
    expect(src).toMatch(/useBudgetDraft\(\{ min: props\.filters\.priceMin, max: props\.filters\.priceMax \}/);
    expect(src).not.toMatch(/useBudgetDraft\(\{ min: draft\./);
  });
  it("cancels counts on open and close, never resets ids to the initial state, and restores focus", () => {
    expect(src).toMatch(/cancelCount\(countRef\.current\)/);
    expect(src).not.toMatch(/countRef\.current = INITIAL_COUNT/);
    expect(src).toMatch(/abortRef\.current\?\.abort\(\)/);
    expect(src).toMatch(/restoreFilterFocus\(\)/);
  });
  it("countFor receives the session-sanitized draft", () => {
    expect(src).toMatch(/countFor\(effective, ctl\.signal\)/);
    expect(src).toMatch(/sanitizeForSession\(draft, session\)/);
  });
});

describe("section allow-list and native world section", () => {
  const ctx = { signedIn: true, budgetReady: true, storeCount: 2, categoryCount: 2 };
  it("defaults are unchanged (no world section unless asked)", () => {
    expect(visibleSections(ctx).map((x) => x.id)).toEqual(["sort", "brand", "price", "budget", "categories", "discount", "more"]);
  });
  it("world section sits right after sort", () => {
    expect(visibleSections({ ...ctx, world: true }).map((x) => x.id).slice(0, 3)).toEqual(["sort", "world", "brand"]);
  });
  it("the allow-list keeps canonical order and drops everything else", () => {
    expect(visibleSections({ ...ctx, only: ["more", "sort"] }).map((x) => x.id)).toEqual(["sort", "more"]);
    expect(visibleSections({ ...ctx, only: [] })).toEqual([]);
    expect(visibleSections({ signedIn: false, budgetReady: false, storeCount: 0, categoryCount: 0, only: ["budget", "brand"] })).toEqual([]);
  });
});
