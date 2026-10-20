/**
 * Guest-only public reads (ADR-0055 G-2, G-3, G-5; G-4 lives in the home-banners suite): dark (404) while
 * flag.guest_browsing is blocked, allow-listed, cacheable, no cookie, no per-user input, and the owner's rule:
 * a guest never causes a server write (the merge after sign-in is the only one).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, login, type Harness } from "../../../test/harness";
import { GUEST_BROWSING_GATE, PUBLIC_READ_GATE } from "../../../platform/tokens";
import { CART_CATALOG, type FakeCatalog } from "../../cart";

let on: Harness;
let off: Harness;
let closed: Harness;
let catalog: FakeCatalog;
let n = 0;
const uid = (): string => `0192f3a4-5b6c-7d8e-9f01-${String(900_000 + ++n).padStart(12, "0")}`;
const EGP = (p: bigint) => ({ amount: p * 100n, currency: "EGP" as const });
const STORE = uid();
const CLOSED = uid();

beforeAll(async () => {
  on = await createHarness({ customise: (b) => b.overrideProvider(GUEST_BROWSING_GATE).useValue({ enabled: async () => true }) });
  off = await createHarness();
  closed = await createHarness({
    customise: (b) =>
      b.overrideProvider(GUEST_BROWSING_GATE).useValue({ enabled: async () => true }).overrideProvider(PUBLIC_READ_GATE).useValue({ enabled: async () => false }),
  });
  catalog = on.app.get<FakeCatalog>(CART_CATALOG, { strict: false });
  catalog.addStore(STORE);
  catalog.addStore(CLOSED);
  catalog.setStoreOpen(CLOSED, false);
}, 60_000);
afterAll(async () => {
  await on.close();
  await off.close();
  await closed.close();
});

const sku = (store = STORE, over: { unitsLeft?: number | null; available?: boolean } = {}): string => {
  const id = uid();
  catalog.addSku({ skuId: id, productId: uid(), storeId: store, title: { ar: "قميص" }, unitPrice: EGP(120n), available: over.available ?? true, unitsLeft: over.unitsLeft ?? null });
  return id;
};

describe("dark by default", () => {
  it.each([
    `/v1/public/skus?ids=${"0192f3a4-5b6c-7d8e-9f01-000000000001"}`,
    "/v1/public/feed",
    "/v1/public/home/banners",
    "/v1/public/search/suggestions?q=dress",
  ])("%s answers 404 while flag.guest_browsing is blocked", async (path) => {
    const r = await off.http().get(path);
    expect(r.status).toBe(404);
  });
});

describe("GET /v1/public/skus", () => {
  it("serves live price, availability, store state and units_left only when 1 to 5; unknown ids are listed, never distinguished", async () => {
    const a = sku(STORE, { unitsLeft: 3 });
    const b = sku(STORE, { unitsLeft: 40 });
    const c = sku(CLOSED);
    const missing = uid();
    const r = await on.http().get(`/v1/public/skus?ids=${[a, b, c, missing].join(",")}`);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.items.map((i: { id: string }) => [i.id, i]));
    expect(by[a]).toMatchObject({ price: { amount: "12000", currency: "EGP" }, available: true, units_left: 3, store: { id: STORE, open: true } });
    expect(by[b].units_left).toBeNull();
    expect(by[c]).toMatchObject({ available: false, store: { open: false } });
    expect(r.body.not_found_ids).toEqual([missing]);
    expect(Object.keys(by[a]).sort()).toEqual(["available", "id", "price", "product_id", "store", "units_left"]);
    expect(r.headers["cache-control"]).toMatch(/^public/);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });
  it("is 400 for 0 ids, 51 ids or a malformed id", async () => {
    expect((await on.http().get("/v1/public/skus?ids=")).status).toBe(400);
    expect((await on.http().get("/v1/public/skus?ids=nope")).status).toBe(400);
    const many = Array.from({ length: 51 }, () => uid()).join(",");
    expect((await on.http().get(`/v1/public/skus?ids=${many}`)).status).toBe(400);
  });
  it("a bearer token changes nothing", async () => {
    const a = sku();
    const u = await login(on, "+201007788001");
    const anon = await on.http().get(`/v1/public/skus?ids=${a}`);
    const authed = await on.http().get(`/v1/public/skus?ids=${a}`).set({ Authorization: `Bearer ${u.accessToken}` });
    expect(authed.body).toEqual(anon.body);
  });
});

describe("GET /v1/public/feed", () => {
  it("is never personalised: personalized, affordable and unknown keys are 400; the body says personalized false", async () => {
    const r = await on.http().get("/v1/public/feed?limit=5");
    expect(r.status).toBe(200);
    expect(r.body.personalized).toBe(false);
    expect(r.body.page).toEqual({ next_cursor: null, has_more: false });
    expect(r.headers["set-cookie"]).toBeUndefined();
    for (const q of ["personalized=true", "affordable=true", "user_id=x"]) {
      expect((await on.http().get(`/v1/public/feed?${q}`)).status).toBe(400);
    }
  });
});

describe("GET /v1/public/search/suggestions", () => {
  it("serves queries, stores and categories without per-user fields", async () => {
    const r = await on.http().get("/v1/public/search/suggestions?q=dress");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["categories", "queries", "stores"]);
    expect(JSON.stringify(r.body)).not.toContain("is_favorite");
    expect((await on.http().get("/v1/public/search/suggestions")).status).toBe(400);
  });
});

describe("owner rule: a guest makes no server write", () => {
  it("every guest route is GET and @Public; the only write is POST /v1/me/guest-merge (bearer required)", async () => {
    const r = await on.http().post("/v1/me/guest-merge").set({ "Idempotency-Key": uid() }).send({ bag_lines: [] });
    expect(r.status).toBe(401);
    for (const path of ["/v1/cart", "/v1/me/wishlists"]) expect((await on.http().get(path)).status).toBe(401);
    for (const m of ["post", "put", "patch", "delete"] as const) {
      for (const path of ["/v1/public/skus", "/v1/public/feed", "/v1/public/home/banners", "/v1/public/search/suggestions"]) {
        expect([404, 405]).toContain((await on.http()[m](path).send({})).status);
      }
    }
  });
});

describe("kill.public_catalog is honoured by every guest read", () => {
  it.each(["/v1/public/skus?ids=0192f3a4-5b6c-7d8e-9f01-000000000001", "/v1/public/feed", "/v1/public/search/suggestions?q=dress"])(
    "%s answers 503 while the anonymous catalog is blocked",
    async (path) => {
      expect((await closed.http().get(path)).status).toBe(503);
    },
  );
});

describe("conditional GET", () => {
  it.each([
    () => `/v1/public/skus?ids=${sku()}`,
    () => "/v1/public/feed?limit=3",
    () => "/v1/public/search/suggestions?q=dress",
  ])("answers 304 on a matching If-None-Match", async (mk) => {
    const path = mk();
    const first = await on.http().get(path);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    expect((await on.http().get(path).set("If-None-Match", etag)).status).toBe(304);
  });
});

describe("rate limits (G-7)", () => {
  it("a request without x-device-id is still limited by IP (240/min on /skus) and a device header does not lift it", async () => {
    on.clock.advance(120_000);
    const a = sku();
    const codes: number[] = [];
    for (let i = 0; i < 241; i += 1) codes.push((await on.http().get(`/v1/public/skus?ids=${a}`)).status);
    expect(codes.slice(0, 240).every((c) => c === 200 || c === 304)).toBe(true);
    expect(codes[240]).toBe(429);
    const withDevice = await on.http().get(`/v1/public/skus?ids=${a}`).set("x-device-id", uid());
    expect(withDevice.status).toBe(429);
  });
});
