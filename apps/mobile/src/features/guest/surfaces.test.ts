import { describe, expect, it } from "vitest";
import { fakeApi } from "../../services/fake-api";
import { ApiDiscoverPort } from "../discover/api";
import { buildModules } from "../discover/model";
import { ApiHomeBannersPort } from "../home-banners/api";
import { ApiHomePort, guestForYou } from "../home/api";
import { ApiSearchPort } from "../search/api";
import { EMPTY_FILTER } from "../search/model";
import { ApiWorldsPort } from "../worlds/api";
import { GuestWishlistsPort, type SavedProductReader } from "../wishlists/guest-wishlists";
import { SessionWishlistsPort } from "../wishlists/session-wishlists";
import { InMemoryWishlistsPort, UndoTracker } from "../wishlists/model";
import { GuestBagPort } from "../bag/guest-bag";
import { rerankByAffinity } from "./affinity";
import { InMemoryGuestStorage } from "./storage";
import { GuestStore } from "./store";
import { readGuestSignals, withGuestStore } from "./signals";

const U1 = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
const U2 = "0192f3a4-5b6c-7d8e-9f01-23456789abc2";
const U3 = "0192f3a4-5b6c-7d8e-9f01-23456789abc3";
const egp = (n: number) => ({ amount: String(n), currency: "EGP" });
const store = (id: string) => ({ id, slug: "s", name: { ar: "متجر", en: "Store" }, kind: "local", verified_badge: true, live_drop: false });
const prod = (id: string, sid: string) => ({ id, title: { ar: "قميص", en: "Shirt" }, store: store(sid), price: { price: egp(1000), badge: "none" }, condition: "new_with_tags", sponsored: false });
const page = <T>(items: T[]) => ({ items, page: { next_cursor: null, has_more: false } });
const feedBody = { items: [{ product_id: U1, store_id: U2, price_piastres: "1000", verified_discount_pct: null, reason: "", sponsored: false }, { product_id: U3, store_id: U3, price_piastres: "1000", verified_discount_pct: null, reason: "", sponsored: false }], personalized: false, model_version: "m", degraded: [], page: { next_cursor: null, has_more: false } };
const routes = {
  "GET /v1/public/search": () => ({ body: page([prod(U1, U2), prod(U3, U3)]) }),
  "GET /v1/public/feed": () => ({ body: feedBody }),
  "GET /v1/public/stores": () => ({ body: page([store(U1)]) }),
  "GET /v1/public/home/banners": () => ({ body: { items: [] } }),
  "GET /v1/public/search/suggestions": () => ({ body: { queries: ["a"], stores: [], categories: [] } }),
  "GET /v1/drops": () => ({ body: page([]) }),
};
const guestCtx = (signals: { stores: Record<string, number>; viewed: string[] }) => {
  const { ctx, calls } = fakeApi(routes);
  return { ctx: { ...ctx, isGuest: async () => true, guestSignals: async () => ({ ...signals, categories: {} }) }, calls };
};
const noBearerOnly = (calls: { path: string }[]) => expect(calls.every((c) => c.path.startsWith("/v1/public/") || c.path === "/v1/drops")).toBe(true);

describe("guest surfaces call only public routes", () => {
  it("worlds, search, suggestions, banners, home", async () => {
    const { ctx, calls } = guestCtx({ stores: {}, viewed: [] });
    await new ApiWorldsPort(ctx).listStores();
    const sp = new ApiSearchPort(ctx);
    await sp.search("x", EMPTY_FILTER, null);
    await sp.suggest("x");
    await sp.suggestGrouped("x");
    await new ApiHomeBannersPort(ctx).load();
    const home = await new ApiHomePort(ctx).load();
    expect(home.forYouIds).toBeNull();
    noBearerOnly(calls);
    expect(calls.length).toBeGreaterThan(5);
  });
  it("discover: public routes only, re-ranked on the phone, device recently viewed, no server personalisation", async () => {
    const { ctx, calls } = guestCtx({ stores: { [U3]: 3 }, viewed: [U1] });
    const data = await new ApiDiscoverPort(ctx).load(null);
    noBearerOnly(calls);
    expect(calls.some((c) => c.query.get("personalized") !== null)).toBe(false);
    expect(data.feed?.items.map((i) => i.productId)).toEqual([U3, U1]);
    expect(data.popular?.items.map((i) => i.productId)).toEqual([U1, U3]);
    expect(data.saved).toBeNull();
    expect(data.goesWithBag).toBeNull();
    const ids = buildModules(data).map((m) => m.id);
    expect(ids).toContain("picked");
    expect(ids).toContain("recentlyViewed");
  });
  it("discover with no device signals hides the picked module and shows plain Popular", async () => {
    const { ctx } = guestCtx({ stores: {}, viewed: [] });
    const data = await new ApiDiscoverPort(ctx).load(null);
    expect(data.feed).toBeNull();
    const ids = buildModules(data).map((m) => m.id);
    expect(ids).toEqual(["popular"]);
  });
  it("re-rank is deterministic and stable on ties", () => {
    const items = [{ s: "a" }, { s: "b" }, { s: "c" }];
    const aff = { stores: { c: 2 }, categories: {} };
    const k = (t: { s: string }) => ({ storeId: t.s, categoryId: null });
    expect(rerankByAffinity(items, aff, k)).toEqual(rerankByAffinity(items, aff, k));
    expect(rerankByAffinity(items, aff, k).map((x) => x.s)).toEqual(["c", "a", "b"]);
    expect(guestForYou([], [], null)).toBeNull();
  });
  it("withGuestStore exposes device counters only", async () => {
    const st = new GuestStore(new InMemoryGuestStorage());
    await st.hydrate();
    st.like("stores", "s1"); st.view("p1");
    const sig = await readGuestSignals(st);
    expect(sig).toEqual({ stores: { s1: 1 }, categories: {}, viewed: ["p1"], historyPaused: false });
    expect(await withGuestStore(fakeApi({}).ctx, st).guestSignals?.()).toEqual(sig);
    st.clearHistory();
    expect(await readGuestSignals(st)).toEqual({ stores: {}, categories: {}, viewed: [], historyPaused: false });
  });
});

const info = (title: string) => ({ title, storeId: "st1", storeName: "Nile", storeVerified: true, price: 900n, listed: true, sizes: new Map([["sku1", { label: "M", price: 900n }]]) });
const reader = (m: Record<string, ReturnType<typeof info>>): SavedProductReader => ({ read: async () => new Map(Object.entries(m)) });

async function mk(r: SavedProductReader | null) {
  const st = new GuestStore(new InMemoryGuestStorage()); await st.hydrate();
  const bag = new GuestBagPort(st, null);
  return { st, port: new GuestWishlistsPort(st, bag, r, (i) => `L-${i}`), bag };
}

describe("GuestWishlistsPort", () => {
  it("saves per intent, lists locally with live data, keeps first seen price, never writes to a server", async () => {
    const { st, port } = await mk(reader({ p1: info("Shirt") }));
    await port.saveItem("p1", "want", { title: "Shirt", price: 1000n });
    await port.saveItem("p1", "want", { title: "Shirt", price: 5000n });
    await port.saveItem("p1", "need", { title: "Shirt", price: 1000n });
    const lists = await port.list();
    expect(lists.map((l) => [l.id, l.title])).toEqual([["guest-need", "L-need"], ["guest-want", "L-want"]]);
    const it0 = lists[1]?.items[0];
    expect(it0).toMatchObject({ title: "Shirt", addedPrice: 1000n, currentPrice: 900n, status: "listed", storeName: "Nile" });
    expect(st.getState().saved).toHaveLength(2);
    expect(await port.isGuest()).toBe(true);
  });
  it("falls back to the saved title and last seen price when the public read fails; empty lists are omitted", async () => {
    const { port } = await mk({ read: async () => { throw new Error("x"); } });
    expect(await port.list()).toEqual([]);
    await port.saveItem("p1", "treat", { title: "Coat", price: 700n });
    const i = (await port.list())[0]?.items[0];
    expect(i).toMatchObject({ title: "Coat", currentPrice: null, addedPrice: 700n });
  });
  it("remove with undo: undo cancels, commit unsaves", async () => {
    const { port, st } = await mk(null);
    await port.saveItem("p1", "need", { title: "A", price: 1n });
    const id = (await port.list())[0]?.items[0]?.id ?? "";
    const t = new UndoTracker(5000, { set: () => 1, clear: () => undefined });
    let removed = 0;
    t.schedule(id, () => { removed++; void port.removeItem("guest-need", id); });
    expect(t.undo(id)).toBe(true);
    expect(st.getState().saved).toHaveLength(1);
    await port.removeItem("guest-need", id);
    expect(st.getState().saved).toHaveLength(0);
    expect(removed).toBe(0);
  });
  it("add to bag goes to the guest bag; cool-off is local; share and new lists are refused", async () => {
    const { st, port } = await mk(reader({ p1: info("Shirt") }));
    await port.saveItem("p1", "want", { title: "Shirt", price: 1000n });
    st.unsave("p1");
    st.save({ productId: "p1", skuId: "sku1", intent: "want", seenPricePiastres: "1000" });
    await port.list();
    await port.addToBag("sku1");
    expect(st.getState().bag[0]).toMatchObject({ skuId: "sku1", productId: "p1", qty: 1 });
    expect(await port.bagProductIds()).toEqual(["p1"]);
    await port.setCoolOff("guest-want", true);
    expect((await port.list())[0]?.coolOffEnabled).toBe(true);
    await expect(port.createShare("guest-want", null)).rejects.toThrow();
    await expect(port.create({ intent: "need", title: "t", targetDate: null, budget: null, recipientNickname: null, occasion: null })).rejects.toThrow();
  });
  it("session port switches on sign-in with no server call while signed out", async () => {
    const { port } = await mk(null);
    const server = new InMemoryWishlistsPort();
    let signed = false;
    const s = new SessionWishlistsPort(server, port, async () => signed);
    expect(await s.isGuest()).toBe(true);
    await s.saveItem("p77", "need", { title: "Z", price: 1n });
    expect(server.removed).toEqual([]);
    expect((await server.list()).flatMap((l) => l.items).some((i) => i.productId === "p77")).toBe(false);
    signed = true;
    expect(await s.isGuest()).toBe(false);
    expect((await s.list()).length).toBe(2);
  });
});

describe("settings persist on the device", () => {
  it("history pause persists across re-hydrate and a paused view or like records nothing", async () => {
    const storage = new InMemoryGuestStorage();
    const a = new GuestStore(storage); await a.hydrate();
    a.view("p0"); a.like("stores", "s0");
    a.setHistoryPaused(true);
    a.view("p1"); a.like("stores", "s1");
    await a.flush();
    const b = new GuestStore(storage); await b.hydrate();
    expect(b.getState().settings.historyPaused).toBe(true);
    expect(b.getState().viewed.map((v) => v.productId)).toEqual(["p0"]);
    expect(b.getState().affinity.stores).toEqual({ s0: 1 });
    expect((await readGuestSignals(b)).historyPaused).toBe(true);
  });
  it("cool-off persists across re-hydrate through the wishlists port", async () => {
    const storage = new InMemoryGuestStorage();
    const a = new GuestStore(storage); await a.hydrate();
    const pa = new GuestWishlistsPort(a, new GuestBagPort(a, null), null, (i) => i);
    await pa.saveItem("p1", "want", { title: "T", price: 1n });
    await pa.setCoolOff("guest-want", true);
    await a.flush();
    const b = new GuestStore(storage); await b.hydrate();
    const pb = new GuestWishlistsPort(b, new GuestBagPort(b, null), null, (i) => i);
    expect((await pb.list())[0]?.coolOffEnabled).toBe(true);
  });
});

describe.each([
  ["guest", async () => (await mk(null)).port],
  ["server fake", async () => new InMemoryWishlistsPort([])],
])("wishlists port contract: %s", (_n, make) => {
  it("saves per intent, dedupes, removes", async () => {
    const p = await make();
    await p.saveItem("p1", "want", { title: "A", price: 10n });
    await p.saveItem("p1", "want", { title: "A", price: 10n });
    await p.saveItem("p1", "need", { title: "A", price: 10n });
    const lists = await p.list();
    expect(lists.map((l) => l.intent).sort()).toEqual(["need", "want"]);
    expect(lists.every((l) => l.items.length === 1)).toBe(true);
    const want = lists.find((l) => l.intent === "want");
    await p.removeItem(want?.id ?? "", want?.items[0]?.id ?? "");
    const after = await p.list();
    expect(after.flatMap((l) => l.items)).toHaveLength(1);
    expect(after.flatMap((l) => l.items.map((i) => i.productId))).toEqual(["p1"]);
  });
});

describe("guest save with a size", () => {
  it("saved with a sku: row has skuPref and Add to bag lands in the guest bag; without: skuPref null (screen opens the product)", async () => {
    const { st, port } = await mk(reader({ p1: info("Shirt"), p2: info("Coat") }));
    await port.saveItem("p1", "need", { title: "Shirt", price: 1000n, skuId: "sku1" });
    await port.saveItem("p2", "need", { title: "Coat", price: 1000n });
    const items = (await port.list())[0]?.items ?? [];
    expect(items.find((i) => i.productId === "p1")?.skuPref).toBe("sku1");
    expect(items.find((i) => i.productId === "p2")?.skuPref).toBeNull();
    await port.addToBag("sku1");
    expect(st.getState().bag.map((l) => l.skuId)).toEqual(["sku1"]);
  });
});
