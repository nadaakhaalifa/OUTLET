import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../services/wire";
import type { HomeProduct } from "../home/model";
import { MAX_QUERY_LENGTH } from "../search/model";
import { ApiDiscoverPort } from "./api";
import { LatestOnly, MAX_PANEL_RECENTS, clampQuery, panelMode, panelRecents, suggestionTap } from "./inline-search";
import {
  EMPTY_DISCOVER, InMemoryDiscoverPort, MODULE_LIMIT, buildModules, discoverFailure, feedQuery,
  type DiscoverData, type DiscoverModuleId, type RecItem,
} from "./model";

const GUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const product = (n: number): HomeProduct => ({
  id: GUID(n), title: `Item ${n}`, storeId: GUID(900), storeName: "Store", kind: "dress", price: 1000n, referencePrice: null, verifiedPct: null,
  isLaunchPrice: false, createdAtMs: 0, endsAtMs: null, sponsored: false,
});
const rec = (n: number, extra: Partial<RecItem> = {}): RecItem => ({ productId: GUID(n), reason: null, priceDrop: null, ...extra });
const CATALOGUE = Array.from({ length: 30 }, (_, i) => product(i + 1));
const drop = { seenPrice: 2000n, dropBy: 500n };

function full(over: Partial<DiscoverData> = {}): DiscoverData {
  return {
    settings: { personalization: true, historyPaused: false },
    catalogue: CATALOGUE,
    saved: { title: "Red dress", similar: [rec(1), rec(2)] },
    goesWithBag: [rec(3)],
    feed: { personalized: true, degraded: false, items: [rec(4, { reason: "Because you like denim" }), rec(5, { priceDrop: drop })] },
    popular: { personalized: false, degraded: false, items: [rec(6), rec(7)] },
    recentlyViewed: [GUID(8)],
    ...over,
  };
}
const ids = (d: DiscoverData, flags?: { stylistOpen: boolean }): DiscoverModuleId[] => buildModules(d, flags).map((m) => m.id);

describe("module visibility matrix", () => {
  it("personalization on shows every personal module in order and hides popular", () => {
    expect(ids(full())).toEqual(["becauseSaved", "goesWithBag", "priceDropped", "picked", "recentlyViewed"]);
  });
  it("personalization off shows only non-personalised modules, ignoring any personal data it was handed", () => {
    expect(ids(full({ settings: { personalization: false, historyPaused: false } }))).toEqual(["popular", "recentlyViewed"]);
  });
  it("hides modules whose data is empty", () => {
    expect(ids(full({ saved: null }))).not.toContain("becauseSaved");
    expect(ids(full({ goesWithBag: null }))).not.toContain("goesWithBag");
    expect(ids(full({ saved: { title: "x", similar: [] } }))).not.toContain("becauseSaved");
    expect(ids(full({ recentlyViewed: [] }))).not.toContain("recentlyViewed");
    expect(ids(EMPTY_DISCOVER)).toEqual([]);
  });
  it("kill.stylist closed hides only goes-with-bag", () => {
    expect(ids(full(), { stylistOpen: false })).toEqual(["becauseSaved", "priceDropped", "picked", "recentlyViewed"]);
  });
  it("paused history hides recently viewed", () => {
    expect(ids(full({ settings: { personalization: true, historyPaused: true } }))).not.toContain("recentlyViewed");
  });
  it("falls back to popular when the personalised feed is empty, degraded or not personalised", () => {
    for (const feed of [null, { personalized: true, degraded: true, items: [rec(4)] }, { personalized: false, degraded: false, items: [rec(4)] }, { personalized: true, degraded: false, items: [] }]) {
      const m = ids(full({ feed }));
      expect(m).toContain("popular");
      expect(m).not.toContain("picked");
    }
  });
  it("never labels a personalised feed as Popular when personalization is off", () => {
    const d = full({ settings: { personalization: false, historyPaused: false }, popular: { personalized: true, degraded: false, items: [rec(6)] } });
    expect(ids(d)).not.toContain("popular");
  });
  it("shows price-dropped only for real server drops", () => {
    const d = full({ feed: { personalized: true, degraded: false, items: [rec(4), rec(5, { priceDrop: { seenPrice: 10n, dropBy: 0n } })] } });
    expect(ids(d)).not.toContain("priceDropped");
  });
  it("drops ids the catalogue cannot resolve, de-duplicates, and caps at 10", () => {
    const many = Array.from({ length: 25 }, (_, i) => rec(i + 1));
    const d = full({ saved: { title: "t", similar: [rec(1), rec(1), rec(999), ...many] } });
    const m = buildModules(d).find((x) => x.id === "becauseSaved");
    expect(m?.products).toHaveLength(MODULE_LIMIT);
    expect(new Set(m?.products.map((p) => p.id)).size).toBe(MODULE_LIMIT);
    expect(m?.products.some((p) => p.id === GUID(999))).toBe(false);
  });
  it("uses the server reason as a caption only when present", () => {
    const m = buildModules(full()).find((x) => x.id === "picked");
    expect(m?.captions).toEqual({ [GUID(4)]: "Because you like denim" });
  });
  it("property: off never yields a personal module, whatever the data", () => {
    let seed = 11;
    const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const list = () => Array.from({ length: rnd(6) }, () => rec(1 + rnd(30), rnd(2) === 0 ? { priceDrop: drop } : {}));
    for (let i = 0; i < 300; i++) {
      const d = full({
        settings: { personalization: rnd(2) === 0, historyPaused: rnd(2) === 0 },
        saved: rnd(2) === 0 ? null : { title: "t", similar: list() },
        goesWithBag: rnd(2) === 0 ? null : list(),
        feed: rnd(3) === 0 ? null : { personalized: rnd(2) === 0, degraded: rnd(2) === 0, items: list() },
        popular: rnd(3) === 0 ? null : { personalized: false, degraded: false, items: list() },
      });
      const m = ids(d, { stylistOpen: rnd(2) === 0 });
      if (!d.settings.personalization) for (const id of m) expect(["popular", "recentlyViewed"]).toContain(id);
      expect(new Set(m).size).toBe(m.length);
      expect(m.includes("popular") && m.includes("picked")).toBe(false);
    }
  });
});

describe("feed query (honesty and budget rules)", () => {
  it("asks for personalized=false when off and never sends affordable or any budget field", () => {
    expect(feedQuery(false)).toEqual({ personalized: "false", limit: 10 });
    expect(feedQuery(true)).toEqual({ personalized: "true", limit: 10 });
    expect(Object.keys(feedQuery(true)).sort()).toEqual(["limit", "personalized"]);
  });
  it("clamps the limit to the wire range", () => {
    expect(feedQuery(true, 0).limit).toBe(1);
    expect(feedQuery(true, 500).limit).toBe(50);
  });
});

describe("InMemoryDiscoverPort", () => {
  it("returns no personal data when personalization is off and records the call", async () => {
    const port = new InMemoryDiscoverPort(full());
    const d = await port.load(false);
    expect(d.settings.personalization).toBe(false);
    expect(d.saved).toBeNull();
    expect(d.goesWithBag).toBeNull();
    expect(d.feed).toBeNull();
    expect(port.calls).toEqual([{ personalization: false }]);
  });
  it("maps offline and failed to screen errors", async () => {
    const port = new InMemoryDiscoverPort(full(), "offline");
    await expect(port.load(null)).rejects.toMatchObject({ kind: "offline" });
    expect(discoverFailure(await port.load(null).catch((e: unknown) => e))).toEqual({ status: "error", offline: true });
    expect(discoverFailure(new Error("x"))).toEqual({ status: "error", offline: false });
  });
});

/* ---- API adapter: which operations are called ---- */

function stub(personalization: boolean) {
  const calls: { op: string; input: unknown }[] = [];
  const wrap = (op: string, data: unknown) => async (input: unknown) => { calls.push({ op, input }); return { notModified: false, data }; };
  const money = { amount: "1000", currency: "EGP" };
  const summary = (n: number) => ({
    id: GUID(n), title: { ar: `منتج ${n}`, en: `Item ${n}` }, store: { id: GUID(900), name: { ar: "متجر", en: "Store" } }, price: { badge: "plain", price: money }, sponsored: false,
  });
  const recWire = (n: number) => ({ product_id: GUID(n), store_id: GUID(900), price_piastres: "1000", verified_discount_pct: null, reason: "r", sponsored: false });
  const client = {
    listMyHistory: wrap("listMyHistory", { items: [], page: {}, settings: { personalization, history_paused: false } }),
    search: wrap("search", { items: [summary(1), summary(2)] }),
    getFeed: async (input: { query: { personalized: string } }) => { calls.push({ op: "getFeed", input }); return { notModified: false, data: { items: [recWire(1)], personalized: input.query.personalized === "true", degraded: [] } }; },
    listMyRecentlyViewed: wrap("listMyRecentlyViewed", { items: [{ product_id: GUID(2), price_piastres: null, viewed_at: "2026-10-16T00:00:00Z" }] }),
    listWishlists: wrap("listWishlists", { items: [{ id: GUID(70), item_count: 1, created_at: "2026-10-01T00:00:00Z" }] }),
    getWishlist: wrap("getWishlist", { items: [{ product_id: GUID(1), state: "active", product: summary(1) }] }),
    getSimilarProducts: wrap("getSimilarProducts", { items: [recWire(2)], degraded: false }),
    getCart: wrap("getCart", { groups: [{ lines: [{ product_id: GUID(1), availability: "available" }] }] }),
  };
  const ctx = { client, locale: () => "en", nowMs: () => 1_000_000, deviceId: async () => "d" } as unknown as AdapterContext;
  return { calls, port: new ApiDiscoverPort(ctx) };
}

describe("ApiDiscoverPort", () => {
  it("with personalization on reads saves, bag and personalised feed", async () => {
    const { calls, port } = stub(true);
    const d = await port.load(null);
    const ops = calls.map((c) => c.op);
    expect(ops).toEqual(expect.arrayContaining(["listWishlists", "getWishlist", "getCart", "getSimilarProducts"]));
    expect(calls.find((c) => c.op === "getFeed")?.input).toEqual({ query: { personalized: "true", limit: 10 } });
    expect(d.saved?.title).toBe("Item 1");
    expect(ids(d)).toContain("becauseSaved");
  });
  it("with personalization off touches no saved, bag or similar data and asks for personalized=false only", async () => {
    const { calls, port } = stub(true);
    const d = await port.load(false);
    const ops = calls.map((c) => c.op);
    for (const banned of ["listWishlists", "getWishlist", "getCart", "getSimilarProducts"]) expect(ops).not.toContain(banned);
    const feeds = calls.filter((c) => c.op === "getFeed").map((c) => c.input);
    expect(feeds).toEqual([{ query: { personalized: "false", limit: 10 } }]);
    expect(d.saved).toBeNull();
    expect(ids(d)).toEqual(["popular", "recentlyViewed"]);
  });
  it("honours the server setting when the app has no local choice", async () => {
    const { calls, port } = stub(false);
    await port.load(null);
    expect(calls.map((c) => c.op)).not.toContain("getCart");
  });
  it("never sends an affordable flag on any feed call", async () => {
    const { calls, port } = stub(true);
    await port.load(true);
    await port.load(false);
    for (const c of calls.filter((x) => x.op === "getFeed")) expect(JSON.stringify(c.input)).not.toContain("affordable");
  });
});

/* ---- inline search rules ---- */

describe("inline search rules", () => {
  it("shows at most 5 recents", () => {
    expect(panelRecents(Array.from({ length: 8 }, (_, i) => `q${i}`))).toHaveLength(MAX_PANEL_RECENTS);
  });
  it("trims and caps the query at 100 characters", () => {
    expect(clampQuery("  white   dress ").query).toBe("white dress");
    const c = clampQuery("a".repeat(150));
    expect(c.query).toHaveLength(MAX_QUERY_LENGTH);
    expect(c.tooLong).toBe(true);
  });
  it("chooses recents, suggestions or results", () => {
    expect(panelMode("", false)).toBe("recents");
    expect(panelMode("  ", false)).toBe("recents");
    expect(panelMode("dr", false)).toBe("suggestions");
    expect(panelMode("dress", true)).toBe("results");
  });
  it("drops stale answers", () => {
    const l = new LatestOnly();
    const a = l.begin();
    const b = l.begin();
    expect(l.accepts(a)).toBe(false);
    expect(l.accepts(b)).toBe(true);
  });
  it("reports a tap by kind and position only", () => {
    expect(suggestionTap({ kind: "store", id: "s1", label: "Secret name" }, 2)).toEqual({ kind: "store", position: 2 });
  });
});
