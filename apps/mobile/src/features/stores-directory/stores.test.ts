import { describe, expect, it } from "vitest";
import {
  EMPTY_DIRECTORY_FILTER, InMemoryStoresDirectoryPort, activeFilterCount, filterStores, normalizeQuery, parseStoresParam, pruneSelected,
  locationCounts, matchesLocation, outletsChrome, pluralForm, selectGovernorate, toggleArea, type OutletLocations,
  shopAllTarget, sortHasNoData, sortStores, toggleSelection, toCardView, PortError,
} from "./model";
import { FIXTURE_STORES, type StoreSummary } from "../worlds/model";

const named = (id: string, name: string, over: Partial<StoreSummary> = {}): StoreSummary => ({ ...FIXTURE_STORES[0]!, id, name, status: "active", ...over });

describe("normalizeQuery", () => {
  it("folds alef, ya, ta-marbuta, strips diacritics and tatweel", () => {
    expect(normalizeQuery("أَزْيَاءُ  مَدِينَة")).toBe("ازياء مدينه");
    expect(normalizeQuery("إسلام آباد")).toBe("اسلام اباد");
    expect(normalizeQuery("مـصر")).toBe("مصر");
    expect(normalizeQuery("على")).toBe(normalizeQuery("علي"));
  });
  it("maps Eastern and Persian digits and lowercases", () => {
    expect(normalizeQuery("Store ١٢٣")).toBe("store 123");
    expect(normalizeQuery("۴۵")).toBe("45");
  });
});

describe("filterStores", () => {
  const stores = [
    named("a", "متجر الأزياء", { kind: "local", liveDrop: true, isFavourite: true, maxVerifiedDiscountPct: 40 }),
    named("b", "Atlas Sport", { kind: "global", liveDrop: false, isFavourite: false, maxVerifiedDiscountPct: null }),
    named("c", "Hidden", { status: "suspended" }),
  ];
  it("hides suspended stores and matches Arabic with folding", () => {
    expect(filterStores(stores, EMPTY_DIRECTORY_FILTER).map((s) => s.id)).toEqual(["a", "b"]);
    expect(filterStores(stores, { ...EMPTY_DIRECTORY_FILTER, query: "الازياء" }).map((s) => s.id)).toEqual(["a"]);
  });
  it("applies world, verified, live and my-stores", () => {
    expect(filterStores(stores, { ...EMPTY_DIRECTORY_FILTER, world: "global" }).map((s) => s.id)).toEqual(["b"]);
    expect(filterStores(stores, { ...EMPTY_DIRECTORY_FILTER, verifiedDeals: true }).map((s) => s.id)).toEqual(["a"]);
    expect(filterStores(stores, { ...EMPTY_DIRECTORY_FILTER, liveDrop: true }).map((s) => s.id)).toEqual(["a"]);
    expect(filterStores(stores, { ...EMPTY_DIRECTORY_FILTER, myStores: true }).map((s) => s.id)).toEqual(["a"]);
  });
  it("counts active filters", () => {
    expect(activeFilterCount(EMPTY_DIRECTORY_FILTER)).toBe(0);
    expect(activeFilterCount({ query: "x", world: "local", verifiedDeals: true, liveDrop: true, myStores: true, governorateId: "EG-C", areaIds: ["maadi", "nasr-city"] })).toBe(8);
  });
});

describe("sortStores", () => {
  const s = [
    named("a", "B store", { trendingRank: 2, maxVerifiedDiscountPct: null, newestDropAtMs: 5 }),
    named("b", "A store", { trendingRank: 3, maxVerifiedDiscountPct: 50, newestDropAtMs: null }),
    named("c", "C store", { trendingRank: 1, maxVerifiedDiscountPct: 20, newestDropAtMs: 9 }),
  ];
  it("sorts each key with nulls last and does not mutate", () => {
    expect(sortStores(s, "trending").map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(sortStores(s, "biggestDiscount").map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(sortStores(s, "newDrops").map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(sortStores(s, "az").map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(s.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
  it("reports sorts with no data", () => {
    expect(sortHasNoData([named("a", "x", { newestDropAtMs: null })], "newDrops")).toBe(true);
    expect(sortHasNoData(s, "newDrops")).toBe(false);
  });
});

describe("selection", () => {
  it("toggles and enforces the cap", () => {
    expect(toggleSelection([], "a").ids).toEqual(["a"]);
    expect(toggleSelection(["a", "b"], "a").ids).toEqual(["b"]);
    const full = toggleSelection(["a", "b"], "c", 2);
    expect(full).toEqual({ ids: ["a", "b"], limitHit: true });
  });
  it("prunes unknown ids and builds routes", () => {
    expect(pruneSelected(["s1", "zzz", "s4"], FIXTURE_STORES)).toEqual(["s1"]);
    expect(shopAllTarget([])).toEqual({ pathname: "/shop-all" });
    expect(shopAllTarget(["a"])).toEqual({ pathname: "/shop-all", params: { store: "a" } });
    expect(shopAllTarget(["a", "b"])).toEqual({ pathname: "/shop-all", params: { stores: "a,b" } });
  });
  it("parses the stores param", () => {
    expect(parseStoresParam("a, b,,a,c")).toEqual(["a", "b", "c"]);
    expect(parseStoresParam(undefined)).toEqual([]);
    expect(parseStoresParam("a,b,c", 2)).toEqual(["a", "b"]);
  });
});

describe("InMemoryStoresDirectoryPort", () => {
  it("returns fixtures and can fail", async () => {
    const p = new InMemoryStoresDirectoryPort();
    expect((await p.listStores()).length).toBe(FIXTURE_STORES.length);
    p.setFailure("offline");
    await expect(p.listStores()).rejects.toBeInstanceOf(PortError);
  });
});

import { nextRoute, parseScope, scopeToWorld, showsOrigin } from "./model";
describe("step flow", () => {
  it("parses scope params", () => {
    expect(parseScope("local")).toBe("local");
    expect(parseScope("x")).toBeNull();
    expect(parseScope(undefined)).toBeNull();
  });
  it("maps scope to world", () => {
    expect(scopeToWorld("both")).toBe("all");
    expect(scopeToWorld("global")).toBe("global");
  });
  it("routes each step", () => {
    expect(nextRoute("inStore").pathname).toBe("/stores/outlets");
    expect(nextRoute("online", "local")).toEqual({ pathname: "/stores/list", params: { scope: "local" } });
    expect(nextRoute("online", "global")).toEqual({ pathname: "/stores/list", params: { scope: "global" } });
    expect(nextRoute("online")).toEqual({ pathname: "/stores/list", params: { scope: "both" } });
  });
  it("shows origin only for both", () => {
    expect(showsOrigin("both")).toBe(true);
    expect(showsOrigin("local")).toBe(false);
  });
});

describe("toCardView", () => {
  it("renders only data that exists", () => {
    const v = toCardView(named("a", "A", { rating: null, deliveryDays: null, maxVerifiedDiscountPct: null }));
    expect(v.locationLine).toBeNull();
    expect(v.hoursText).toBeNull();
    expect(v.distanceKm).toBeNull();
    expect(v.rating).toBeNull();
  });
  it("joins city and country and passes optional extras through", () => {
    const v = toCardView(named("a", "A"), { city: "Cairo", country: "Egypt", hoursText: "Open", distanceKm: 2.4 });
    expect(v.locationLine).toBe("Cairo, Egypt");
    expect(v.hoursText).toBe("Open");
    expect(v.distanceKm).toBe(2.4);
  });
});

describe("online and outlet data sets are separate", () => {
  it("keeps outlet fixtures out of the online list", async () => {
    const online = await new InMemoryStoresDirectoryPort().listStores();
    expect(online.some((s) => s.id.startsWith("dev-"))).toBe(false);
  });
});

describe("location filter", () => {
  const stores = [named("a", "A"), named("b", "B"), named("c", "C"), named("d", "D")];
  const locs: OutletLocations = {
    a: { governorateId: "EG-C", areaId: "nasr-city" },
    b: { governorateId: "EG-C", areaId: "maadi" },
    c: { governorateId: "EG-GZ", areaId: "6th-october" },
    d: { governorateId: null, areaId: null },
  };
  const ids = (f: Partial<typeof EMPTY_DIRECTORY_FILTER>) => filterStores(stores, { ...EMPTY_DIRECTORY_FILTER, ...f }, locs).map((s) => s.id);
  it("no location filter keeps everything, including unknown location", () => {
    expect(ids({})).toEqual(["a", "b", "c", "d"]);
  });
  it("governorate only matches the whole governorate", () => {
    expect(ids({ governorateId: "EG-C" })).toEqual(["a", "b"]);
  });
  it("areas multi-select within the governorate", () => {
    expect(ids({ governorateId: "EG-C", areaIds: ["nasr-city"] })).toEqual(["a"]);
    expect(ids({ governorateId: "EG-C", areaIds: ["nasr-city", "maadi"] })).toEqual(["a", "b"]);
    expect(ids({ governorateId: "EG-C", areaIds: ["6th-october"] })).toEqual([]);
  });
  it("unknown-location outlets never match an active location filter, and no locations means no match", () => {
    expect(matchesLocation(undefined, { governorateId: "EG-C", areaIds: [] })).toBe(false);
    expect(filterStores(stores, { ...EMPTY_DIRECTORY_FILTER, governorateId: "EG-C" })).toEqual([]);
  });
  it("combines with the text query", () => {
    expect(ids({ governorateId: "EG-C", query: "b" })).toEqual(["b"]);
  });
  it("narrowing never grows the result (property)", () => {
    const wide = ids({ governorateId: "EG-C" });
    for (const area of ["nasr-city", "maadi", "6th-october"]) for (const x of ids({ governorateId: "EG-C", areaIds: [area] })) expect(wide).toContain(x);
  });
  it("counts are real and ignore the location filter itself", () => {
    const c = locationCounts(stores, locs, { ...EMPTY_DIRECTORY_FILTER, governorateId: "EG-GZ" });
    expect(c.governorates).toEqual({ "EG-C": 2, "EG-GZ": 1 });
    expect(c.areas).toEqual({ "nasr-city": 1, maadi: 1, "6th-october": 1 });
    expect(locationCounts(stores, locs, { ...EMPTY_DIRECTORY_FILTER, query: "a" }).governorates).toEqual({ "EG-C": 1 });
  });
  it("counts location terms in activeFilterCount", () => {
    expect(activeFilterCount({ ...EMPTY_DIRECTORY_FILTER, governorateId: "EG-C" })).toBe(1);
    expect(activeFilterCount({ ...EMPTY_DIRECTORY_FILTER, governorateId: "EG-C", areaIds: ["maadi"] })).toBe(2);
  });
  it("selection helpers", () => {
    const sel = { governorateId: "EG-C", areaIds: ["maadi"] };
    expect(selectGovernorate(sel, "EG-C")).toBe(sel);
    expect(selectGovernorate(sel, "EG-GZ")).toEqual({ governorateId: "EG-GZ", areaIds: [] });
    expect(toggleArea(sel, { id: "maadi", governorateId: "EG-C" })).toEqual({ governorateId: "EG-C", areaIds: [] });
    expect(toggleArea(sel, { id: "dokki", governorateId: "EG-GZ" })).toEqual({ governorateId: "EG-GZ", areaIds: ["dokki"] });
    expect(toggleArea({ governorateId: null, areaIds: [] }, { id: "dokki", governorateId: "EG-GZ" })).toEqual({ governorateId: "EG-GZ", areaIds: ["dokki"] });
  });
  it("plural buckets", () => {
    expect([0, 1, 2, 3, 10, 11, 99, 100, 101, 102, 103, 110, 111].map(pluralForm)).toEqual(
      ["Other", "One", "Two", "Few", "Few", "Many", "Many", "Other", "Other", "Other", "Few", "Few", "Many"]);
  });
  it("outlets chrome: hero, filter button and location sheet only when outlet data exists", () => {
    expect(outletsChrome(true, false)).toEqual({ hero: false, filterButton: false, locationSheet: false });
    expect(outletsChrome(true, true)).toEqual({ hero: true, filterButton: true, locationSheet: true });
    expect(outletsChrome(false, true)).toEqual({ hero: false, filterButton: false, locationSheet: false });
    expect(outletsChrome(false, false)).toEqual({ hero: false, filterButton: false, locationSheet: false });
  });
});
