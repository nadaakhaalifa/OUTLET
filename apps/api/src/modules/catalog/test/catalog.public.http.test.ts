import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { PlatformModule, createIdGenerator, nodeCsprng } from "../../../platform";
import { SEED, createCatalogDevFixtures } from "../adapters/in-memory";
import { CatalogModule } from "../catalog.module";
import { PRINCIPALS, STORE_A, STORE_B, TestAuthModule, TestClock, bearer, createCatalogHarness, idemKey, type CatalogHarness } from "./harness";

const UP_IMG = "0192f3a4-5b6c-7d8e-9f01-0000000a0001";
const UP_DEFECT = "0192f3a4-5b6c-7d8e-9f01-0000000a0003";
const UP_B_IMG = "0192f3a4-5b6c-7d8e-9f01-0000000b0001";
const MISSING = "0192f3a4-5b6c-7d8e-9f01-aaaaaaaaaaaa";

/** Allow-list snapshot of the anonymous product representation (OpenAPI PublicProduct). */
const TOP_KEYS = [
  "condition", "department", "defect_photos", "description", "id", "image_url", "blurhash", "images", "material", "price",
  "return_eligibility", "seller_legal_identity", "seller_legal_identity_visible", "size_chart_available", "skus",
  "sponsored", "store", "title", "updated_at",
];
const STORE_KEYS = ["id", "kind", "live_drop", "name", "slug", "verified_badge"];
const SKU_KEYS = ["available", "color", "id", "price", "size_label", "units_left"];
const PRICE_KEYS = ["badge", "claim_id", "discount_pct", "price", "reference_price"];
const LEGAL_KEYS = ["commercial_register_no", "governorate", "legal_name", "tax_card_no"];
const FORBIDDEN_ANYWHERE = /is_favorite|barcode_gtin|installment_quote|delivery_eta|video_url|iban|signatory|national_id|seller_id|store_id|health/i;

let h: CatalogHarness;

beforeAll(async () => {
  h = await createCatalogHarness();
});
afterAll(async () => h.close());

function body(over: Record<string, unknown> = {}) {
  return {
    title: { ar: "فستان كتان أبيض", en: "White linen dress" },
    description: { ar: "فستان صيفي خفيف" },
    category_id: SEED.categoryDresses,
    brand_id: SEED.brandAcme,
    condition: "new_with_tags",
    image_upload_ids: [UP_IMG],
    skus: [
      { size_label: "M", color: "White", price: { amount: "129900", currency: "EGP" }, initial_stock: 4, seller_sku: "LD-M" },
      { size_label: "L", color: "White", price: { amount: "139900", currency: "EGP" }, initial_stock: 40, seller_sku: "LD-L" },
    ],
    ...over,
  };
}

async function createProduct(principal = PRINCIPALS.ownerA, over: Record<string, unknown> = {}) {
  h.fixtures.uploads.add(STORE_A, UP_IMG);
  h.fixtures.uploads.add(STORE_A, UP_DEFECT);
  h.fixtures.uploads.add(STORE_B, UP_B_IMG);
  const r = await h.http().post("/v1/seller/products").set(bearer(principal)).set("Idempotency-Key", idemKey()).send(body(over));
  expect(r.status).toBe(201);
  return r.body as { id: string; skus: { id: string }[] };
}

async function publish(principal: typeof PRINCIPALS.ownerA, id: string, status: "active" | "paused" = "active") {
  const etag = (await h.http().get(`/v1/seller/products/${id}`).set(bearer(principal))).headers.etag as string;
  const r = await h.http().patch(`/v1/seller/products/${id}`).set(bearer(principal)).set("If-Match", etag).send({ status });
  expect(r.status).toBe(200);
}

async function activeProduct(over: Record<string, unknown> = {}) {
  const p = await createProduct(PRINCIPALS.ownerA, over);
  await publish(PRINCIPALS.ownerA, p.id);
  return p;
}

const pub = (id: string) => h.http().get(`/v1/public/products/${id}`);

describe("GET /v1/public/products/{productId} (anonymous)", () => {
  it("serves an active product without credentials with exactly the allow-listed keys", async () => {
    const p = await activeProduct({
      skus: [
        { size_label: "M", color: "White", price: { amount: "129900", currency: "EGP" }, initial_stock: 4, barcode_gtin: "4006381333931" },
        { size_label: "L", color: "White", price: { amount: "139900", currency: "EGP" }, initial_stock: 40 },
      ],
    });
    h.fixtures.stock.set(p.skus[0]?.id ?? "", { onHand: 3, available: 3 });
    h.fixtures.stock.set(p.skus[1]?.id ?? "", { onHand: 40, available: 40 });
    const r = await pub(p.id);
    expect(r.status).toBe(200);
    for (const k of Object.keys(r.body)) expect(TOP_KEYS, k).toContain(k);
    expect(Object.keys(r.body.store).sort()).toEqual(STORE_KEYS);
    for (const s of r.body.skus as Record<string, unknown>[]) for (const k of Object.keys(s)) expect(SKU_KEYS, k).toContain(k);
    expect(Object.keys(r.body.price).sort()).toEqual(PRICE_KEYS);
    expect(Object.keys(r.body.seller_legal_identity).sort()).toEqual(LEGAL_KEYS);
    expect(JSON.stringify(r.body)).not.toMatch(FORBIDDEN_ANYWHERE);
    expect(r.body.sponsored).toBe(false);
  });

  it("never exposes stock above 5 and keeps the honest price rules", async () => {
    const p = await activeProduct();
    h.fixtures.stock.set(p.skus[0]?.id ?? "", { onHand: 3, available: 3 });
    h.fixtures.stock.set(p.skus[1]?.id ?? "", { onHand: 40, available: 40 });
    const r = await pub(p.id);
    const [m, l] = r.body.skus as { units_left: number | null; available: boolean }[];
    expect(m).toMatchObject({ available: true, units_left: 3 });
    expect(l).toMatchObject({ available: true, units_left: null });
    expect(r.body.price).toMatchObject({ badge: "none", reference_price: null, discount_pct: null });
    expect(JSON.stringify(r.body)).not.toContain('"40"');
    // A claim without a complete verified block is dropped, a complete one passes through.
    const skuId = p.skus[0]?.id ?? "";
    h.fixtures.prices.set(skuId, { badge: "verified_discount", referencePrice: { amount: 200_000n, currency: "EGP" }, discountPct: 2, claimId: "c" });
    const bad = await pub(p.id);
    expect((bad.body.skus as { id: string; price: { badge: string; reference_price: unknown } }[]).find((s) => s.id === skuId)?.price).toMatchObject({ badge: "none", reference_price: null });
    h.fixtures.prices.set(skuId, { badge: "verified_discount", referencePrice: { amount: 200_000n, currency: "EGP" }, discountPct: 35, claimId: "0192f3a4-5b6c-7d8e-9f01-0000000d0001" });
    const ok = await pub(p.id);
    expect((ok.body.skus as { id: string; price: Record<string, unknown> }[]).find((s) => s.id === skuId)?.price).toMatchObject({
      badge: "verified_discount",
      discount_pct: 35,
    });
  });

  it("ignores credentials and cookies, sets no cookie and is not CORS-enabled", async () => {
    const p = await activeProduct();
    const anon = await pub(p.id);
    const withToken = await pub(p.id).set(bearer(PRINCIPALS.buyer)).set("Cookie", "sid=1").set("Origin", "https://evil.example");
    expect(withToken.status).toBe(200);
    expect(withToken.body).toEqual(anon.body);
    for (const r of [anon, withToken]) {
      expect(r.headers["set-cookie"]).toBeUndefined();
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    }
    // A garbage bearer does not turn a public read into a 401.
    expect((await pub(p.id).set("Authorization", "Bearer nope")).status).toBe(200);
  });

  it("is CDN cacheable with a 5 s shared window and revalidates with 304", async () => {
    const p = await activeProduct();
    const r = await pub(p.id);
    expect(r.headers["cache-control"]).toBe("public, max-age=0, s-maxage=5, stale-while-revalidate=5");
    const again = await pub(p.id).set("If-None-Match", String(r.headers.etag));
    expect(again.status).toBe(304);
    h.fixtures.stock.set(p.skus[0]?.id ?? "", { onHand: 1, available: 1 });
    const changed = await pub(p.id).set("If-None-Match", String(r.headers.etag));
    expect(changed.status).toBe(200);
  });

  it("answers the same 404 for draft, paused, missing and every product of a non-public store", async () => {
    const draft = await createProduct();
    const paused = await activeProduct();
    await publish(PRINCIPALS.ownerA, paused.id, "paused");
    const missing = await pub(MISSING);
    expect(missing.status).toBe(404);
    for (const id of [draft.id, paused.id]) {
      const r = await pub(id);
      expect(r.status).toBe(404);
      expect({ ...r.body, request_id: undefined }).toEqual({ ...missing.body, request_id: undefined });
    }
    const live = await activeProduct();
    const base = { id: STORE_A, slug: "store-a", nameAr: "متجر أ", kind: "local" as const, verifiedBadge: false, liveDrop: false, isFavorite: false, legal: { legalName: "L", commercialRegisterNo: "CR-1", taxCardNo: "TC-1", governorate: "Cairo", approved: true } };
    h.fixtures.stores.set({ ...base, visible: false });
    expect((await pub(live.id)).status).toBe(404);
    h.fixtures.stores.set({ ...base, visible: true, paused: true });
    expect((await pub(live.id)).status).toBe(404);
    h.fixtures.stores.set({ ...base, visible: true });
    expect((await pub(live.id)).status).toBe(200);
    expect((await pub("not-a-uuid")).status).toBe(400);
  });

  it("answers 410 for a delisted product of a public store and 404 when the store is not public", async () => {
    const p = await activeProduct();
    const stored = await h.fixtures.products.findById(p.id);
    if (stored === null) throw new Error("fixture");
    expect(await h.fixtures.products.replace({ ...stored, status: "delisted", version: stored.version + 1 }, stored.version)).toBe(true);
    const r = await pub(p.id);
    expect(r.status).toBe(410);
    expect(r.body.code).toBe("gone");
    const base = { id: STORE_A, slug: "store-a", nameAr: "متجر أ", kind: "local" as const, verifiedBadge: false, liveDrop: false, isFavorite: false, legal: { legalName: "L", commercialRegisterNo: "CR-1", taxCardNo: "TC-1", governorate: "Cairo", approved: true } };
    h.fixtures.stores.set({ ...base, visible: false });
    expect((await pub(p.id)).status).toBe(404);
    h.fixtures.stores.set({ ...base, visible: true });
  });

  it("a minor-defect product exposes defect photos and nothing else new", async () => {
    const p = await activeProduct({ condition: "minor_defect", defect_photo_upload_ids: [UP_DEFECT] });
    const r = await pub(p.id);
    expect(r.status).toBe(200);
    for (const k of Object.keys(r.body)) expect(TOP_KEYS, k).toContain(k);
  });
});

describe("GET /v1/public/sitemap/products/{page}", () => {
  it("lists active products of public stores with an accurate lastmod and nothing else", async () => {
    const live = await activeProduct();
    const draft = await createProduct();
    const r = await h.http().get("/v1/public/sitemap/products/1");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["items", "page"]);
    const ids = (r.body.items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(draft.id);
    for (const i of r.body.items as Record<string, unknown>[]) {
      expect(Object.keys(i).sort()).toEqual(["id", "lastmod"]);
      expect(String(i["lastmod"])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(r.headers["cache-control"]).toMatch(/s-maxage=300/);
    for (const bad of ["0", "1001", "x", "-1"]) expect((await h.http().get(`/v1/public/sitemap/products/${bad}`)).status, bad).toBe(400);
  });

  it("omits products of a non-public store", async () => {
    const live = await activeProduct();
    const base = { id: STORE_A, slug: "store-a", nameAr: "متجر أ", kind: "local" as const, verifiedBadge: false, liveDrop: false, isFavorite: false, legal: { legalName: "L", commercialRegisterNo: "CR-1", taxCardNo: "TC-1", governorate: "Cairo", approved: true } };
    h.fixtures.stores.set({ ...base, visible: true, paused: true });
    const r = await h.http().get("/v1/public/sitemap/products/1");
    expect((r.body.items as { id: string }[]).map((i) => i.id)).not.toContain(live.id);
    h.fixtures.stores.set({ ...base, visible: true });
  });
});

describe("GET /v1/public/categories (anonymous)", () => {
  const CATEGORY_KEYS = ["id", "name", "parent_id", "position", "return_class", "slug"];

  it("serves the active taxonomy to anonymous callers with exactly the allow-listed keys", async () => {
    const r = await h.http().get("/v1/public/categories");
    expect(r.status).toBe(200);
    const items = r.body.items as { id: string; slug: string; name: { ar: string }; parent_id: string | null; position: number }[];
    expect(Object.keys(r.body)).toEqual(["items"]);
    expect(items.length).toBeGreaterThan(0);
    for (const c of items) {
      expect(Object.keys(c).sort()).toEqual(CATEGORY_KEYS);
      expect(c.name.ar.length).toBeGreaterThan(0);
    }
    const slugs = items.map((c) => c.slug);
    expect(slugs).toContain("dresses");
    expect(slugs).not.toContain("retired");
    expect(items.every((c) => c.parent_id === null || items.some((p) => p.id === c.parent_id))).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/product_type|requires_size_chart|active|seller|store_id|health/i);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("is indistinguishable with a bearer token, even a garbage one", async () => {
    const anon = await h.http().get("/v1/public/categories");
    const withToken = await h.http().get("/v1/public/categories").set(bearer(PRINCIPALS.buyer));
    const garbage = await h.http().get("/v1/public/categories").set("Authorization", "Bearer nope");
    expect(withToken.status).toBe(200);
    expect(garbage.status).toBe(200);
    expect(withToken.body).toEqual(anon.body);
  });

  it("is CDN cacheable for 300 s and revalidates with 304", async () => {
    const r = await h.http().get("/v1/public/categories");
    expect(r.headers["cache-control"]).toBe("public, max-age=0, s-maxage=300, stale-while-revalidate=60");
    const again = await h.http().get("/v1/public/categories").set("If-None-Match", String(r.headers.etag));
    expect(again.status).toBe(304);
  });
});

describe("kill switch kill.public_catalog", () => {
  it("answers 503 public_catalog_disabled on every catalog public route when blocked, and leaves authenticated reads alone", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const clock = new TestClock();
    const ids = createIdGenerator(clock, nodeCsprng);
    const fixtures = createCatalogDevFixtures();
    let allowed = false;
    const moduleRef = await Test.createTestingModule({
      imports: [
        PlatformModule.forRoot(config, { clock, ids, publicReadGate: { enabled: async () => allowed } }),
        TestAuthModule.register(),
        CatalogModule.forRoot(config, fixtures),
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    configureApp(app, config);
    await app.init();
    try {
      const http = () => request(app.getHttpServer());
      for (const path of [`/v1/public/products/${MISSING}`, "/v1/public/sitemap/products/1", "/v1/public/categories"]) {
        const r = await http().get(path);
        expect(r.status, path).toBe(503);
        expect(r.body.code).toBe("public_catalog_disabled");
        expect(r.headers["retry-after"]).toBeDefined();
      }
      // The authenticated route is not behind the switch (it answers 404 for a missing id, not 503).
      expect((await http().get(`/v1/products/${MISSING}`).set(bearer(PRINCIPALS.buyer))).status).toBe(404);
      allowed = true;
      expect((await http().get(`/v1/public/products/${MISSING}`)).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});
