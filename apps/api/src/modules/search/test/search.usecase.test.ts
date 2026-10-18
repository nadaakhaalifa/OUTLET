import { beforeEach, describe, expect, it } from "vitest";
import {
  CatalogUnavailableError,
  InvalidCursorError,
  ParseSearchQuery,
  SearchEnginesUnavailableError,
  SearchProducts,
  SuggestQueries,
  TooManyFacetsError,
  passesLiveFacets,
} from "../application/search";
import {
  FakeLlmGateway,
  FakeProductFacts,
  InMemorySearchEventPublisher,
  InMemorySearchIndex,
  InMemorySuggestionDirectory,
  StaticKillSwitch,
  StaticShopperScope,
} from "../adapters/in-memory";
import { TypesenseSearchPort, type TypesenseTransport } from "../adapters/typesense";
import { SearchUnavailableError, type ProductFacts, type SearchPort } from "../domain/ports";
import { doc, P, S, T0 } from "./index-contract";
import { storeSummary } from "../../cart";
import { money } from "../domain/bridge";

const USER = "00000000-0000-4000-8000-000000000001";
const EGP = (p: bigint) => money(p * 100n);

const facts = (n: number, over: Partial<ProductFacts> = {}): ProductFacts => ({
  productId: P(n),
  title: { ar: `منتج ${n}` },
  store: storeSummary(S(1)),
  unitPrice: EGP(1000n),
  badge: "none",
  referencePrice: null,
  discountPct: null,
  condition: "new_with_tags",
  sponsored: false,
  purchasable: true,
  ...over,
});

interface Env {
  index: InMemorySearchIndex;
  facts: FakeProductFacts;
  kill: StaticKillSwitch;
  scope: StaticShopperScope;
  events: InMemorySearchEventPublisher;
  uc: SearchProducts;
}

const make = (primary?: SearchPort): Env => {
  const index = new InMemorySearchIndex();
  const f = new FakeProductFacts();
  const kill = new StaticKillSwitch(false);
  const scope = new StaticShopperScope();
  const events = new InMemorySearchEventPublisher();
  const uc = new SearchProducts({
    primary: primary ?? new TypesenseSearchPort(null),
    fallback: index,
    killSwitch: kill,
    facts: f,
    scope,
    events,
    clock: { nowMs: () => T0 },
  });
  return { index, facts: f, kill, scope, events, uc };
};

let e: Env;
beforeEach(() => {
  e = make();
});

const seed = async (n: number, d: Parameters<typeof doc>[1] = {}, f: Partial<ProductFacts> = {}) => {
  await e.index.upsert(doc(n, d));
  e.facts.set(facts(n, f));
};

describe("SearchProducts", () => {
  it("returns live price from the catalog, not the index value", async () => {
    await seed(1, { priceAmount: 1n, searchText: "dress" }, { unitPrice: EGP(750n) });
    const r = await e.uc.execute({ userId: USER, q: "dress", filter: {} });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.facts.unitPrice.amount).toBe(75_000n);
  });

  it("drops hits that are out of stock live, gone, or from a closed store", async () => {
    await seed(1, { searchText: "dress" });
    await seed(2, { searchText: "dress" }, { purchasable: false });
    await e.index.upsert(doc(3, { searchText: "dress" })); // no live facts at all
    const r = await e.uc.execute({ userId: USER, q: "dress", filter: {} });
    expect(r.items.map((i) => i.facts.productId)).toEqual([P(1)]);
  });

  it("applies price filters to the LIVE price (index price is stale)", async () => {
    await seed(1, { priceAmount: 50_000n, searchText: "dress" }, { unitPrice: EGP(900n) });
    await seed(2, { priceAmount: 50_000n, searchText: "dress" }, { unitPrice: EGP(300n) });
    const r = await e.uc.execute({ userId: USER, q: "dress under 500", filter: {} });
    expect(r.items.map((i) => i.facts.productId)).toEqual([P(2)]);
    expect(r.appliedFilter.priceMax).toBe(50_000n);
  });

  it("Arabic and English phrasing return the same results", async () => {
    await seed(1, { searchText: "فستان أبيض لينين", colors: ["white"], materials: ["linen"], priceAmount: 100_000n });
    await seed(2, { searchText: "فستان أسود", colors: ["black"], priceAmount: 100_000n });
    const ar = await e.uc.execute({ userId: USER, q: "فستان ابيض لينين تحت ١٥٠٠", filter: {} });
    const en = await e.uc.execute({ userId: USER, q: "white linen dress under 1500", filter: {} });
    expect(ar.items.map((i) => i.facts.productId)).toEqual([P(1)]);
    expect(en.items.map((i) => i.facts.productId)).toEqual([P(1)]);
    expect(ar.appliedFilter).toEqual(en.appliedFilter);
  });

  it("explicit filters win over text-derived ones", async () => {
    await seed(1, { searchText: "dress", priceAmount: 100_000n });
    const r = await e.uc.execute({ userId: USER, q: "dress under 500", filter: { priceMax: 300_000n } });
    expect(r.appliedFilter.priceMax).toBe(300_000n);
    expect(r.items).toHaveLength(1);
  });

  it("serves the Postgres fallback as degraded when the primary is down, and not degraded when it is up", async () => {
    await seed(1, { searchText: "dress" });
    const down = await e.uc.execute({ userId: USER, q: "dress", filter: {} });
    expect(down.degraded).toBe(true);

    const idx = new InMemorySearchIndex();
    await idx.upsert(doc(1, { searchText: "dress" }));
    const transport: TypesenseTransport = {
      search: (r) => idx.search(r),
      suggest: (p, l) => idx.suggest(p, l),
    };
    const up = make(new TypesenseSearchPort(transport));
    await up.index.upsert(doc(1, { searchText: "dress" }));
    up.facts.set(facts(1));
    const r = await up.uc.execute({ userId: USER, q: "dress", filter: {} });
    expect(r.degraded).toBe(false);
    expect(r.items).toHaveLength(1);
  });

  it("the kill switch forces the fallback even when Typesense works", async () => {
    const idx = new InMemorySearchIndex();
    let calls = 0;
    const t: TypesenseTransport = {
      search: async (r) => {
        calls += 1;
        return idx.search(r);
      },
      suggest: async () => [],
    };
    const env = make(new TypesenseSearchPort(t));
    await env.index.upsert(doc(1, { searchText: "dress" }));
    env.facts.set(facts(1));
    env.kill.disabled = true;
    const r = await env.uc.execute({ userId: USER, q: "dress", filter: {} });
    expect(calls).toBe(0);
    expect(r.degraded).toBe(true);
  });

  it("a Typesense timeout degrades instead of failing", async () => {
    const t: TypesenseTransport = { search: () => new Promise(() => undefined), suggest: async () => [] };
    const env = make(new TypesenseSearchPort(t, 20));
    await env.index.upsert(doc(1, { searchText: "dress" }));
    env.facts.set(facts(1));
    const r = await env.uc.execute({ userId: USER, q: "dress", filter: {} });
    expect(r.degraded).toBe(true);
    expect(r.items).toHaveLength(1);
  });

  it("both engines down is a typed error", async () => {
    const broken: SearchPort = {
      engine: "postgres_fts",
      search: async () => {
        throw new SearchUnavailableError("postgres_fts");
      },
      suggest: async () => [],
    };
    const uc = new SearchProducts({
      primary: new TypesenseSearchPort(null),
      fallback: broken,
      killSwitch: e.kill,
      facts: e.facts,
      scope: e.scope,
      events: e.events,
      clock: { nowMs: () => T0 },
    });
    await expect(uc.execute({ userId: USER, q: "x", filter: {} })).rejects.toBeInstanceOf(SearchEnginesUnavailableError);
  });

  it("fails closed when live facts are unavailable", async () => {
    await seed(1, { searchText: "dress" });
    e.facts.failing = true;
    await expect(e.uc.execute({ userId: USER, q: "dress", filter: {} })).rejects.toBeInstanceOf(CatalogUnavailableError);
  });

  it("caps sponsored results at 2 in the top 10", async () => {
    for (let i = 1; i <= 14; i += 1) await seed(i, { searchText: "dress", sponsored: i <= 5 });
    const r = await e.uc.execute({ userId: USER, q: "dress", filter: {}, limit: 20 });
    expect(r.items.slice(0, 10).filter((i) => i.sponsored)).toHaveLength(2);
    expect(r.items).toHaveLength(14);
  });

  it("labels an item sponsored when either the index or the live facts say so", async () => {
    await seed(1, { searchText: "dress", sponsored: false }, { sponsored: true });
    await seed(2, { searchText: "dress", sponsored: true }, { sponsored: false });
    const r = await e.uc.execute({ userId: USER, q: "dress", filter: {} });
    expect(r.items.every((i) => i.sponsored)).toBe(true);
  });

  it("relaxes the least important filter on zero results and reports it", async () => {
    await seed(1, { searchText: "dress", colors: ["white"] });
    const r = await e.uc.execute({
      userId: USER,
      q: "dress",
      filter: { colors: ["white"], newArrivals: true, minRating: 4.5 },
    });
    expect(r.items).toHaveLength(1);
    expect(r.relaxedFilters).toEqual(["new_arrivals", "min_rating"]);
    expect(r.appliedFilter).toEqual({ colors: ["white"] });
  });

  it("never relaxes hard constraints and suggests a correction", async () => {
    await seed(1, { searchText: "dress", priceAmount: 500_000n }, { unitPrice: EGP(5000n) });
    const r = await e.uc.execute({ userId: USER, q: "dres", filter: { priceMax: 10_000n } });
    expect(r.items).toEqual([]);
    expect(r.relaxedFilters).toEqual([]);
    expect(r.appliedFilter.priceMax).toBe(10_000n);
    const typo = await e.uc.execute({ userId: USER, q: "fostn", filter: {} });
    expect(typo.didYouMean).toBe("fostan");
    expect(e.events.events.filter((x) => x.name === "search_no_result")).toHaveLength(2);
  });

  it("My Stores scope uses the shopper's favourites; an empty list yields nothing", async () => {
    await seed(1, { searchText: "dress", storeId: S(1) });
    await seed(2, { searchText: "dress", storeId: S(2) });
    e.scope.set(USER, [S(2)]);
    const r = await e.uc.execute({ userId: USER, q: "dress", filter: { world: "my_stores" } });
    expect(r.items.map((i) => i.facts.productId)).toEqual([P(2)]);
    e.scope.set(USER, []);
    const none = await e.uc.execute({ userId: USER, q: "dress", filter: { world: "my_stores" } });
    expect(none.items).toEqual([]);
  });

  it("paginates by cursor without duplicates or gaps, even when some hits are dropped", async () => {
    for (let i = 1; i <= 9; i += 1) await seed(i, { searchText: "dress" }, { purchasable: i % 3 !== 0 });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 6; round += 1) {
      const r = await e.uc.execute({ userId: USER, q: "dress", filter: {}, limit: 2, ...(cursor !== undefined ? { cursor } : {}) });
      seen.push(...r.items.map((i) => i.facts.productId));
      if (r.nextCursor === null) break;
      cursor = r.nextCursor;
    }
    expect(seen).toEqual([1, 2, 4, 5, 7, 8].map(P));
  });

  it("rejects a cursor made for a different query", async () => {
    for (let i = 1; i <= 4; i += 1) await seed(i, { searchText: "dress" });
    const r = await e.uc.execute({ userId: USER, q: "dress", filter: {}, limit: 2 });
    expect(r.nextCursor).not.toBeNull();
    await expect(
      e.uc.execute({ userId: USER, q: "shoes", filter: {}, limit: 2, cursor: r.nextCursor ?? "" }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(e.uc.execute({ userId: USER, q: "dress", filter: {}, cursor: "%%%" })).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("rejects more than 30 facets after merging text and explicit filters", async () => {
    const colors = Array.from({ length: 30 }, (_, i) => `c${i}`);
    await expect(
      e.uc.execute({ userId: USER, q: "white dress under 100", filter: { colors, materials: ["linen"] } }),
    ).rejects.toBeInstanceOf(TooManyFacetsError);
  });

  it("clamps the page size to 50", async () => {
    for (let i = 1; i <= 60; i += 1) await seed(i, { searchText: "dress" });
    const r = await e.uc.execute({ userId: USER, q: "dress", filter: {}, limit: 500 });
    expect(r.items).toHaveLength(50);
  });
});

describe("passesLiveFacets", () => {
  const base = facts(1);
  it("requires evidence for verified-discount filters and fails closed on unknown enrichments", () => {
    expect(passesLiveFacets({ verifiedDiscountOnly: true }, base)).toBe(false);
    const verified = facts(1, { badge: "verified_discount", referencePrice: EGP(2000n), discountPct: 50 });
    expect(passesLiveFacets({ verifiedDiscountOnly: true, minVerifiedDiscountPct: 40 }, verified)).toBe(true);
    expect(passesLiveFacets({ minVerifiedDiscountPct: 60 }, verified)).toBe(false);
    // A "verified" badge without a reference price is not a claim.
    expect(passesLiveFacets({ verifiedDiscountOnly: true }, facts(1, { badge: "verified_discount" }))).toBe(false);
    expect(passesLiveFacets({ codAvailable: true }, base)).toBe(false);
    expect(passesLiveFacets({ codAvailable: true }, facts(1, { codAvailable: true }))).toBe(true);
    expect(passesLiveFacets({ mySizeOnly: true }, base)).toBe(false);
  });
});

describe("ParseSearchQuery and SuggestQueries", () => {
  it("is rule-based and does not call the LLM when everything parsed", async () => {
    const llm = new FakeLlmGateway();
    const r = await new ParseSearchQuery({ llm }).execute({ text: "white linen dress under 1500" });
    expect(r.keywords).toBe("dress");
    expect(llm.calls).toEqual([]);
  });

  it("only consults the gateway for unparsed fragments, validates its output and survives failures", async () => {
    const llm = new FakeLlmGateway();
    const uc = new ParseSearchQuery({ llm });
    llm.response = { colors: ["red"] };
    const ok = await uc.execute({ text: "dress under" });
    expect(ok.filter.colors).toEqual(["red"]);
    llm.response = { colors: ["red"], __proto_pollute: true, price_max: { amount: "-5", currency: "EGP" } };
    const bad = await uc.execute({ text: "dress under" });
    expect(bad.filter).toEqual({});
    llm.failing = true;
    expect((await uc.execute({ text: "dress under" })).filter).toEqual({});
    expect((await new ParseSearchQuery({ llm: null }).execute({ text: "dress under" })).unparsed).toEqual(["under"]);
  });

  it("suggests queries, stores and categories", async () => {
    const dir = new InMemorySuggestionDirectory();
    dir.storeList.push(storeSummary(S(1), { name: { ar: "فاشون", en: "Fashion Hub" } }));
    dir.categoryList.push({ id: S(7), name: { ar: "فساتين", en: "Dresses" } });
    const idx = new InMemorySearchIndex();
    await idx.upsert(doc(1, { titleAr: "فستان صيفي", searchText: "فستان صيفي" }));
    const s = await new SuggestQueries({ index: idx, directory: dir }).execute({ userId: USER, q: "فس" });
    expect(s.queries).toEqual(["فستان صيفي"]);
    expect(s.categories).toHaveLength(1);
    const f = await new SuggestQueries({ index: idx, directory: dir }).execute({ userId: USER, q: "fash" });
    expect(f.stores).toHaveLength(1);
  });
});

describe("sort, facet counts and brand (WP-API)", () => {
  const seed = async (e: Env) => {
    for (let i = 1; i <= 8; i += 1) {
      await e.index.upsert(doc(i, { storeId: S(1 + (i % 2)), categoryIds: [`00000000-0000-4000-c000-00000000000${1 + (i % 3)}`], priceAmount: BigInt(i * 7 % 5 + 1) * 10_000n, listedAtMs: T0 - i * 1000 }));
      e.facts.set(facts(i));
    }
  };
  const withIndexPrimary = (): Env => {
    const e = make();
    const uc = new SearchProducts({
      primary: e.index,
      fallback: e.index,
      killSwitch: e.kill,
      facts: e.facts,
      scope: e.scope,
      events: e.events,
      clock: { nowMs: () => T0 },
    });
    return { ...e, uc };
  };

  it("price_asc paging is stable, disjoint and complete", async () => {
    const e = withIndexPrimary();
    await seed(e);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await e.uc.execute({ userId: USER, q: "", filter: {}, limit: 3, sort: "price_asc", ...(cursor !== undefined ? { cursor } : {}) });
      seen.push(...r.items.map((i) => i.facts.productId));
      cursor = r.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(new Set(seen).size).toBe(8);
    const prices = seen.map((id) => Number(id.slice(-12)) * 7 % 5);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  it("a cursor from one sort is rejected under another", async () => {
    const e = withIndexPrimary();
    await seed(e);
    const r = await e.uc.execute({ userId: USER, q: "", filter: {}, limit: 3, sort: "price_asc" });
    await expect(e.uc.execute({ userId: USER, q: "", filter: {}, limit: 3, sort: "price_desc", cursor: r.nextCursor ?? "" })).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("facet counts ignore the facet's own selection and are absent when degraded", async () => {
    const e = withIndexPrimary();
    await seed(e);
    const cat1 = "00000000-0000-4000-c000-000000000001";
    const r = await e.uc.execute({ userId: USER, q: "", filter: { categoryIds: [cat1], storeIds: [S(1)] } });
    const cats = r.facetCounts?.categories ?? [];
    expect(cats.reduce((n, b) => n + b.count, 0)).toBe(4); // store S1 docs, any category
    const inCat1 = [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => n % 3 === 0).length; // category c...01 is i%3==0
    expect((r.facetCounts?.stores ?? []).reduce((n, b) => n + b.count, 0)).toBe(inCat1);
    const degraded = make();
    await seed(degraded);
    const d = await degraded.uc.execute({ userId: USER, q: "", filter: {} });
    expect(d.degraded).toBe(true);
    expect(d.facetCounts).toBeUndefined();
  });

  it("omits counts on later pages and with live-only filters", async () => {
    const e = withIndexPrimary();
    await seed(e);
    const first = await e.uc.execute({ userId: USER, q: "", filter: {}, limit: 3 });
    expect(first.facetCounts).toBeDefined();
    const second = await e.uc.execute({ userId: USER, q: "", filter: {}, limit: 3, cursor: first.nextCursor ?? "" });
    expect(second.facetCounts).toBeUndefined();
    for (let i = 1; i <= 8; i += 1) e.facts.set(facts(i, { codAvailable: true }));
    const live = await e.uc.execute({ userId: USER, q: "", filter: { codAvailable: true } });
    expect(live.items.length).toBeGreaterThan(0);
    expect(live.facetCounts).toBeUndefined();
  });

  it("brand filter matches only documents that carry brand data", async () => {
    const e = withIndexPrimary();
    const B = "00000000-0000-4000-d000-000000000001";
    await e.index.upsert(doc(1, { brandId: B }));
    await e.index.upsert(doc(2));
    e.facts.set(facts(1));
    e.facts.set(facts(2));
    const r = await e.uc.execute({ userId: USER, q: "", filter: { brandIds: [B] } });
    expect(r.items.map((i) => i.facts.productId)).toEqual([P(1)]);
  });
});
