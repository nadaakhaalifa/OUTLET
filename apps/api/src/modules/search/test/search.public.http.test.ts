import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AuthModule } from "../../auth";
import { PlatformModule, createIdGenerator, nodeCsprng } from "../../../platform";
import { FakeClock } from "../../../test/harness";
import { FakeProductFacts, InMemorySearchIndex } from "../adapters/in-memory";
import { SearchModule } from "../search.module";
import { publicSearchWire } from "../adapters/public.controller";
import { doc, P } from "./index-contract";
import { EGP, createSearchHarness, factsFor, type SearchHarness } from "./search-harness";
import { storeSummary } from "../../cart";

/** Allow-list snapshot of an anonymous listing card (OpenAPI PublicProductSummary). */
const ITEM_KEYS = ["blurhash", "condition", "id", "image_url", "price", "sponsored", "store", "title"];
const STORE_KEYS = [
  "cover_url", "follower_count", "id", "kind", "live_drop", "logo_url", "max_verified_discount_pct", "name",
  "rating", "rating_count", "slug", "verified_badge",
];
const PRICE_KEYS = ["badge", "discount_pct", "price", "reference_price"];
const RESULT_KEYS = ["did_you_mean", "items", "page", "relaxed_filter", "total_estimate"];

let h: SearchHarness;
const seed = async (n: number, d: Parameters<typeof doc>[1] = {}, f: Parameters<typeof factsFor>[1] = {}) => {
  await h.index.upsert(doc(n, d));
  h.facts.set(factsFor(P(n), f));
};
const get = (query: Record<string, string> = {}) => h.http().get("/v1/public/search").query(query);

beforeAll(async () => {
  h = await createSearchHarness();
  await seed(1, { searchText: "فستان أبيض لينين", colors: ["white"], priceAmount: 100_000n }, {
    unitPrice: EGP(1000n),
    store: storeSummary("0192f3a4-0000-7000-8000-00000000aa01", { isFavorite: true, followerCount: 7 }),
  });
  await seed(2, { searchText: "جزمة سوداء", colors: ["black"], priceAmount: 200_000n }, { unitPrice: EGP(2000n) });
  await seed(3, { searchText: "dress sponsored promo", sponsored: true }, { unitPrice: EGP(500n), sponsored: true });
}, 30_000);
afterAll(async () => h.close());

describe("GET /v1/public/search (anonymous)", () => {
  it("answers without credentials with exactly the allow-listed keys and no per-user value", async () => {
    const r = await get({ q: "فستان" });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(expect.arrayContaining(["items", "page"]));
    for (const k of Object.keys(r.body)) expect(RESULT_KEYS, k).toContain(k);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const it of r.body.items as Record<string, unknown>[]) {
      for (const k of Object.keys(it)) expect(ITEM_KEYS, k).toContain(k);
      for (const k of Object.keys(it["store"] as object)) expect(STORE_KEYS, k).toContain(k);
      expect(Object.keys(it["price"] as object).sort()).toEqual(PRICE_KEYS);
    }
    expect(JSON.stringify(r.body)).not.toMatch(/is_favorite|applied_filters|degraded|claim_id|installment/);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("is_favorite of a store never reaches the anonymous projection even when the facts carry it", () => {
    const f = factsFor(P(1), { store: storeSummary("0192f3a4-0000-7000-8000-00000000aa01", { isFavorite: true }) });
    const w = publicSearchWire({
      items: [{ facts: f, sponsored: false }],
      nextCursor: null,
      totalEstimate: 1,
      appliedFilter: {},
      relaxedFilters: [],
      didYouMean: null,
      degraded: false,
    });
    expect(JSON.stringify(w)).not.toContain("is_favorite");
  });

  it("does not serve sponsored placements", async () => {
    const r = await get({ q: "promo" });
    expect(r.status).toBe(200);
    expect((r.body.items as { id: string }[]).map((i) => i.id)).not.toContain(P(3));
  });

  it("never shows a % off without verified evidence", async () => {
    await seed(4, { searchText: "dress fake discount" }, { unitPrice: EGP(500n), badge: "verified_discount", referencePrice: null, discountPct: 50 });
    const r = await get({ q: "fake discount" });
    expect(r.body.items[0].price).toEqual({ price: { amount: "50000", currency: "EGP" }, badge: "none", reference_price: null, discount_pct: null });
  });

  it("filters by department (women also sees unisex, kids is strict) and echoes department on items", async () => {
    await seed(10, { searchText: "department women dress", department: "women" }, { department: "women" });
    await seed(11, { searchText: "department kids dress", department: "kids" }, { department: "kids" });
    await seed(12, { searchText: "department unisex dress", department: "unisex" });
    const q = async (departments: string[]) =>
      get({ q: "department", filters: JSON.stringify({ departments }) });
    const women = await q(["women"]);
    expect(women.status).toBe(200);
    expect((women.body.items as { id: string }[]).map((i) => i.id).sort()).toEqual([P(10), P(12)]);
    expect((women.body.items as { id: string; department?: string }[]).find((i) => i.id === P(10))?.department).toBe("women");
    const kids = await q(["kids"]);
    expect((kids.body.items as { id: string }[]).map((i) => i.id)).toEqual([P(11)]);
    expect((await q(["accessories"])).status).toBe(400);
    for (const n of [10, 11, 12]) await h.index.remove(P(n));
  });

  it("accepts the public facets and refuses personal, account or unknown ones with 400", async () => {
    const ok = await get({ filters: JSON.stringify({ colors: ["black"], world: "local", price_max: { amount: "300000", currency: "EGP" } }) });
    expect(ok.status).toBe(200);
    expect((ok.body.items as { id: string }[]).map((i) => i.id)).toEqual([P(2)]);
    for (const bad of [
      { my_size_only: true },
      { fits_remaining_budget: true },
      { budget_max: { amount: "100", currency: "EGP" } },
      { monthly_max: { amount: "100", currency: "EGP" } },
      { cod_available: true },
      { payable_with_store_credit: true },
      { installments_available: true },
      { free_delivery_eligible: true },
      { world: "my_stores" },
      { unknown_key: 1 },
    ]) {
      const r = await get({ filters: JSON.stringify(bad) });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("bounds the query: 30 facets, page size 50, filters length, query length and cursor", async () => {
    const tooMany = { colors: Array.from({ length: 31 }, (_, i) => `c${i}`) };
    expect((await get({ filters: JSON.stringify(tooMany) })).status).toBe(400);
    const facets31 = {
      colors: Array.from({ length: 30 }, (_, i) => `c${i}`),
      materials: Array.from({ length: 30 }, (_, i) => `m${i}`),
    };
    expect((await get({ filters: JSON.stringify(facets31) })).status).toBe(400);
    expect((await get({ limit: "51" })).status).toBe(400);
    expect((await get({ limit: "0" })).status).toBe(400);
    expect((await get({ limit: "50" })).status).toBe(200);
    expect((await get({ filters: "x".repeat(2001) })).status).toBe(400);
    expect((await get({ filters: "not json" })).status).toBe(400);
    expect((await get({ q: "a".repeat(500) })).status).toBe(400);
    expect((await get({ cursor: "garbage" })).status).toBe(400);
    expect((await get({ debug: "1" })).status).toBe(400);
  });

  it("is CDN cacheable with a validator and answers 304", async () => {
    const r = await get({ q: "فستان" });
    expect(r.headers["cache-control"]).toBe("public, max-age=0, s-maxage=30, stale-while-revalidate=30");
    const again = await get({ q: "فستان" }).set("If-None-Match", String(r.headers.etag));
    expect(again.status).toBe(304);
  });

  it("fails closed with 503 when the catalog facts are unavailable (no partial data)", async () => {
    h.facts.failing = true;
    const r = await get({ q: "فستان" });
    h.facts.failing = false;
    expect(r.status).toBe(503);
  });

  it("the authenticated search route is unchanged and still requires a token", async () => {
    expect((await h.http().get("/v1/search")).status).toBe(401);
  });
});

describe("kill switch kill.public_catalog", () => {
  it("answers 503 public_catalog_disabled while blocked and serves again when allowed", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const clock = new FakeClock();
    const ids = createIdGenerator(clock, nodeCsprng);
    const index = new InMemorySearchIndex();
    let allowed = false;
    const moduleRef = await Test.createTestingModule({
      imports: [
        PlatformModule.forRoot(config, { clock, ids, publicReadGate: { enabled: async () => allowed } }),
        AuthModule.forRoot(config),
        SearchModule.forRoot(config, { fallback: index, indexWriter: index, facts: new FakeProductFacts() }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    configureApp(app, config);
    await app.init();
    try {
      const http = () => request(app.getHttpServer());
      const blocked = await http().get("/v1/public/search");
      expect(blocked.status).toBe(503);
      expect(blocked.body.code).toBe("public_catalog_disabled");
      allowed = true;
      expect((await http().get("/v1/public/search")).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
