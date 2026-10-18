import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, type LoggedIn } from "../../../test/harness";
import { SearchUnavailableError } from "../domain/ports";
import { doc, P, S } from "./index-contract";
import { EGP, createSearchHarness, factsFor, type SearchHarness } from "./search-harness";

let h: SearchHarness;
let a: LoggedIn;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const seed = async (n: number, d: Parameters<typeof doc>[1] = {}, f: Parameters<typeof factsFor>[1] = {}) => {
  await h.index.upsert(doc(n, d));
  h.facts.set(factsFor(P(n), f));
};

beforeAll(async () => {
  h = await createSearchHarness();
  a = await login(h, "+201005599101");
  await seed(1, { searchText: "فستان أبيض لينين", colors: ["white"], materials: ["linen"], priceAmount: 100_000n }, { unitPrice: EGP(1000n) });
  await seed(2, { searchText: "جزمة سوداء", colors: ["black"], priceAmount: 200_000n }, { unitPrice: EGP(2000n) });
}, 30_000);
afterAll(async () => {
  await h.close();
});

describe("GET /v1/search", () => {
  it("finds Arabic listings from an English query and returns the OpenAPI shape", async () => {
    const r = await h.http().get("/v1/search").query({ q: "white linen dress under 1500" }).set(bearer(a.accessToken));
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([P(1)]);
    expect(r.body.items[0].price.price).toEqual({ amount: "100000", currency: "EGP" });
    expect(r.body.items[0].price.discount_pct).toBeNull();
    expect(r.body.page).toEqual({ next_cursor: null, has_more: false });
    expect(r.body.applied_filters).toEqual({
      colors: ["white"],
      materials: ["linen"],
      price_max: { amount: "150000", currency: "EGP" },
    });
    expect(r.body.degraded).toBe(true);
  });

  it("the Arabic phrasing returns the same ids", async () => {
    const r = await h.http().get("/v1/search").query({ q: "فستان ابيض لينين تحت ١٥٠٠" }).set(bearer(a.accessToken));
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([P(1)]);
  });

  it("never shows a % off without verified evidence", async () => {
    await seed(3, { searchText: "dress promo" }, {
      unitPrice: EGP(500n),
      badge: "verified_discount",
      referencePrice: null,
      discountPct: 50,
    });
    const r = await h.http().get("/v1/search").query({ q: "promo" }).set(bearer(a.accessToken));
    expect(r.body.items[0].price).toEqual({
      price: { amount: "50000", currency: "EGP" },
      badge: "none",
      reference_price: null,
      discount_pct: null,
    });
  });

  it("accepts the filters JSON and rejects invalid ones with pointers", async () => {
    const ok = await h
      .http()
      .get("/v1/search")
      .query({ filters: JSON.stringify({ colors: ["black"] }) })
      .set(bearer(a.accessToken));
    expect(ok.status).toBe(200);
    expect(ok.body.items.map((i: { id: string }) => i.id)).toEqual([P(2)]);

    for (const bad of [
      "not json",
      JSON.stringify({ unknown_key: true }),
      JSON.stringify({ colors: Array.from({ length: 31 }, (_, i) => `c${i}`) }),
      JSON.stringify({ min_verified_discount_pct: 1 }),
      JSON.stringify({ price_max: { amount: "-1", currency: "EGP" } }),
    ]) {
      const r = await h.http().get("/v1/search").query({ filters: bad }).set(bearer(a.accessToken));
      expect(r.status, bad).toBe(400);
      expect(r.body.code).toBe("validation_failed");
    }
  });

  it("applies the departments filter on the authenticated route and echoes it in applied_filters", async () => {
    await seed(20, { searchText: "dept shirt", department: "men" }, { department: "men" });
    await seed(21, { searchText: "dept shirt", department: "women" }, { department: "women" });
    const r = await h
      .http()
      .get("/v1/search")
      .query({ q: "dept", filters: JSON.stringify({ departments: ["men"] }) })
      .set(bearer(a.accessToken));
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([P(20)]);
    expect(r.body.applied_filters).toMatchObject({ departments: ["men"] });
    const bad = await h.http().get("/v1/search").query({ filters: JSON.stringify({ departments: ["pets"] }) }).set(bearer(a.accessToken));
    expect(bad.status).toBe(400);
    await h.index.remove(P(20));
    await h.index.remove(P(21));
  });

  it("filters by brand_ids; brand is on the wire only when the facts carry it", async () => {
    const B = "00000000-0000-4000-8000-000000000001";
    await seed(30, { searchText: "brandy tee", brandId: B }, { brand: { id: B, name: { ar: "ماركة", en: "Brand" } } });
    await seed(31, { searchText: "brandy tee" });
    const r = await h
      .http()
      .get("/v1/search")
      .query({ q: "brandy", filters: JSON.stringify({ brand_ids: [B] }) })
      .set(bearer(a.accessToken));
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([P(30)]);
    expect(r.body.items[0].brand).toEqual({ id: B, name: { ar: "ماركة", en: "Brand" } });
    const all = await h.http().get("/v1/search").query({ q: "brandy" }).set(bearer(a.accessToken));
    const plain = all.body.items.find((i: { id: string }) => i.id === P(31));
    expect(plain).toBeDefined();
    expect("brand" in plain).toBe(false);
    await h.index.remove(P(30));
    await h.index.remove(P(31));
  });

  it("rejects page sizes above 50 and over-long queries", async () => {
    expect((await h.http().get("/v1/search?limit=51").set(bearer(a.accessToken))).status).toBe(400);
    expect((await h.http().get("/v1/search").query({ q: "x".repeat(301) }).set(bearer(a.accessToken))).status).toBe(400);
    expect((await h.http().get("/v1/search?cursor=zzz").set(bearer(a.accessToken))).status).toBe(400);
  });

  it("returns 503 search_unavailable when no engine can answer, and 503 catalog_unavailable when facts fail", async () => {
    const original = h.index.search.bind(h.index);
    h.index.search = async () => {
      throw new SearchUnavailableError("in_memory");
    };
    const r = await h.http().get("/v1/search").query({ q: "dress" }).set(bearer(a.accessToken));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("search_unavailable");
    h.index.search = original;
    h.facts.failing = true;
    const c = await h.http().get("/v1/search").query({ q: "dress" }).set(bearer(a.accessToken));
    expect(c.status).toBe(503);
    expect(c.body.code).toBe("catalog_unavailable");
    h.facts.failing = false;
  });
});

describe("GET /v1/search/suggestions and POST /v1/search/parse", () => {
  it("suggests", async () => {
    const r = await h.http().get("/v1/search/suggestions").query({ q: "فست" }).set(bearer(a.accessToken));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["categories", "queries", "stores"]);
  });

  it("parses Arabic and English to the same filter", async () => {
    const ar = await h.http().post("/v1/search/parse").set(bearer(a.accessToken)).send({ text: "فستان ابيض لينين تحت ١٥٠٠" });
    const en = await h.http().post("/v1/search/parse").set(bearer(a.accessToken)).send({ text: "white linen dress under 1500" });
    expect(ar.status).toBe(200);
    expect(ar.body).toEqual(en.body);
    expect(en.body.keywords).toBe("dress");
    expect(en.body.filter.price_max).toEqual({ amount: "150000", currency: "EGP" });
    expect(h.llm.calls).toEqual([]);
  });

  it("rejects extra properties and empty text", async () => {
    expect((await h.http().post("/v1/search/parse").set(bearer(a.accessToken)).send({ text: "" })).status).toBe(400);
    expect((await h.http().post("/v1/search/parse").set(bearer(a.accessToken)).send({ text: "x", extra: 1 })).status).toBe(400);
  });
});

describe("saved searches", () => {
  it("creates, lists, gets with ETag, updates with If-Match, deletes", async () => {
    const c = await h
      .http()
      .post("/v1/me/saved-searches")
      .set(bearer(a.accessToken))
      .send({ name: "  white dresses ", query: "white dress", filter: { colors: ["white"] }, alert_enabled: true });
    expect(c.status).toBe(201);
    expect(c.body.name).toBe("white dresses");
    expect(c.body.filter).toEqual({ colors: ["white"] });
    expect(c.body.alert_enabled).toBe(true);
    const id = c.body.id as string;

    const list = await h.http().get("/v1/me/saved-searches").set(bearer(a.accessToken));
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(id);

    const one = await h.http().get(`/v1/me/saved-searches/${id}`).set(bearer(a.accessToken));
    expect(one.status).toBe(200);
    const etag = one.headers.etag as string;
    expect(etag).toBeTruthy();
    const nm = await h.http().get(`/v1/me/saved-searches/${id}`).set(bearer(a.accessToken)).set("If-None-Match", etag);
    expect(nm.status).toBe(304);

    const noMatch = await h.http().patch(`/v1/me/saved-searches/${id}`).set(bearer(a.accessToken)).send({ alert_enabled: false });
    expect(noMatch.status).toBe(428);
    const stale = await h
      .http()
      .patch(`/v1/me/saved-searches/${id}`)
      .set(bearer(a.accessToken))
      .set("If-Match", '"stale"')
      .send({ alert_enabled: false });
    expect(stale.status).toBe(412);
    const up = await h
      .http()
      .patch(`/v1/me/saved-searches/${id}`)
      .set(bearer(a.accessToken))
      .set("If-Match", etag)
      .send({ alert_enabled: false, filter: { world: "local" } });
    expect(up.status).toBe(200);
    expect(up.body.alert_enabled).toBe(false);
    expect(up.body.filter).toEqual({ world: "local" });

    expect((await h.http().delete(`/v1/me/saved-searches/${id}`).set(bearer(a.accessToken))).status).toBe(204);
    expect((await h.http().get(`/v1/me/saved-searches/${id}`).set(bearer(a.accessToken))).status).toBe(404);
  });

  it("validates input and enforces the cap of 50", async () => {
    const send = (body: unknown) => h.http().post("/v1/me/saved-searches").set(bearer(a.accessToken)).send(body as object);
    expect((await send({ name: "", filter: {} })).status).toBe(400);
    expect((await send({ name: "x", filter: { bogus: 1 } })).status).toBe(400);
    expect((await send({ name: "x" })).status).toBe(400);
    const b = await login(h, "+201005599102");
    for (let i = 0; i < 50; i += 1) {
      const r = await h.http().post("/v1/me/saved-searches").set(bearer(b.accessToken)).send({ name: `s${i}`, filter: {} });
      expect(r.status).toBe(201);
    }
    const over = await h.http().post("/v1/me/saved-searches").set(bearer(b.accessToken)).send({ name: "one more", filter: {} });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("saved_search_limit_reached");
  });

  it("pages the list with an opaque cursor", async () => {
    const c = await login(h, "+201005599103");
    for (let i = 0; i < 3; i += 1) {
      await h.http().post("/v1/me/saved-searches").set(bearer(c.accessToken)).send({ name: `p${i}`, filter: {} });
      h.clock.advance(1000);
    }
    const p1 = await h.http().get("/v1/me/saved-searches?limit=2").set(bearer(c.accessToken));
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.page.has_more).toBe(true);
    const p2 = await h
      .http()
      .get("/v1/me/saved-searches")
      .query({ limit: 2, cursor: p1.body.page.next_cursor })
      .set(bearer(c.accessToken));
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.page.has_more).toBe(false);
    expect((await h.http().get("/v1/me/saved-searches?cursor=%%").set(bearer(c.accessToken))).status).toBe(400);
  });
});

describe("events", () => {
  it("emits a PII-free no-result event for demand gaps", async () => {
    await h.http().get("/v1/search").query({ q: "zzzz qqqq" }).set(bearer(a.accessToken));
    const ev = h.searchEvents.events.find((e) => e.name === "search_no_result");
    expect(ev).toEqual({ name: "search_no_result", locale: "ar", normalizedQuery: "zzzz qqqq" });
  });
});

void S;
