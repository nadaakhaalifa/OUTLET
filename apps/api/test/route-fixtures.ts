import type { InjectOptions } from "fastify";
import { DEVICE, bearer, idemKey } from "./harness.js";
import { makePng, multipartBody } from "./png.js";
import type { TestApp } from "./harness.js";

export interface HappyRequest {
  readonly req: InjectOptions;
  readonly status: number;
  /** Run once before counting (steady state: e.g. readiness caches its one-off checks). */
  readonly warmup?: boolean;
}

/**
 * One entry per production route, keyed `METHOD /openapi/path`. routes.test.ts fails when a route has no entry, so a
 * new endpoint cannot ship without its negative-authorization and query-count cases.
 * Store-tenant happy requests act for `seed.storeA` (the generator swaps tokens and X-Store-Id around it).
 */
export interface RouteFixture {
  happy(t: TestApp): Promise<HappyRequest>;
  /** Public routes with object ids: a request for an id that does not exist (or is not public) → 404. */
  missing?(t: TestApp): InjectOptions;
  /** User-tenant routes with object ids: the same request for another user's object → 404. */
  otherTenant?(t: TestApp): Promise<InjectOptions>;
}

const device = { "x-device-id": DEVICE };

const WRITE_ROLES = ["catalog"] as const;
const sellerHeaders = (t: TestApp, token: string, store: string): Record<string, string> => ({ ...bearer(token), "x-store-id": store, "idempotency-key": idemKey(t) });

/** A fresh DRAFT listing created through the API (open_box = a grade that needs a defect card). */
export const newDraft = async (t: TestApp, store: string, grade = "new_with_tags"): Promise<{ id: string; version: number; token: string }> => {
  const { token } = await t.seller(store, WRITE_ROLES);
  const res = await t.inject({ method: "POST", url: "/v1/eg/seller/products", headers: sellerHeaders(t, token, store), payload: { condition_grade_code: grade, primary_category_id: t.seed.categoryId } });
  const body = JSON.parse(res.body) as { id: string; version: number };
  return { id: body.id, version: body.version, token };
};

export const DETAILS = (categoryId: string) => ({
  title_ar: "حذاء رياضي",
  description_ar: "حذاء رياضي بحالة ممتازة",
  primary_category_id: categoryId,
  attributes: {},
});

const readFixture = (url: (t: TestApp) => string, otherId: (t: TestApp) => Promise<string> | string): RouteFixture => ({
  happy: async (t) => {
    const { token } = await t.seller(t.seed.storeA, ["catalog"]);
    return { req: { method: "GET", url: url(t), headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
  },
  otherTenant: async (t) => {
    const { token } = await t.seller(t.seed.storeA, ["catalog"]);
    return { method: "GET", url: `/v1/eg/seller/products/${await otherId(t)}${url(t).includes("/readiness") ? "/readiness" : ""}`, headers: { ...bearer(token), "x-store-id": t.seed.storeA } };
  },
});

const foreignCache = new WeakMap<TestApp, string>();
/** A listing of store B, created once per test app. */
export const foreignProduct = async (t: TestApp): Promise<string> => {
  const hit = foreignCache.get(t);
  if (hit !== undefined) return hit;
  const d = await newDraft(t, t.seed.storeB);
  foreignCache.set(t, d.id);
  return d.id;
};

export const ROUTE_FIXTURES: Readonly<Record<string, RouteFixture>> = {
  "GET /v1/health/live": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/health/live" }, status: 200 }),
  },
  "GET /v1/health/ready": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/health/ready" }, status: 200, warmup: true }),
  },
  "GET /v1/{market}/stores": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/eg/stores?limit=10", headers: device }, status: 200 }),
  },
  "GET /v1/{market}/categories": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/eg/categories?limit=50", headers: device }, status: 200 }),
  },
  "GET /v1/{market}/deals": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/eg/deals?band=59_50&limit=10", headers: device }, status: 200 }),
  },
  "GET /v1/{market}/products/{product_id}": {
    happy: (t) => Promise.resolve({ req: { method: "GET", url: `/v1/eg/products/${t.seed.productA}`, headers: device }, status: 200 }),
    missing: () => ({ method: "GET", url: "/v1/eg/products/00000000-0000-4000-8000-00000000dead", headers: device }),
  },
  "GET /v1/{market}/stores/{store_slug}": {
    happy: (t) => Promise.resolve({ req: { method: "GET", url: `/v1/eg/stores/${t.seed.slugA}`, headers: device }, status: 200 }),
    missing: () => ({ method: "GET", url: "/v1/eg/stores/no-such-store", headers: device }),
  },
  "GET /v1/{market}/stores/{store_slug}/products": {
    happy: (t) => Promise.resolve({ req: { method: "GET", url: `/v1/eg/stores/${t.seed.slugA}/products?limit=10`, headers: device }, status: 200 }),
    missing: () => ({ method: "GET", url: "/v1/eg/stores/no-such-store/products", headers: device }),
  },
  "GET /v1/{market}/passports/{passport_code}": {
    happy: (t) => Promise.resolve({ req: { method: "GET", url: `/v1/eg/passports/${t.seed.passportA}`, headers: device }, status: 200 }),
    missing: () => ({ method: "GET", url: "/v1/eg/passports/0000000000000000000000000A", headers: device }),
  },
  "POST /v1/{market}/seller/products": {
    happy: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return {
        req: {
          method: "POST",
          url: "/v1/eg/seller/products",
          headers: { ...bearer(token), "x-store-id": t.seed.storeA, "idempotency-key": idemKey(t) },
          payload: { condition_grade_code: "new_with_tags", primary_category_id: t.seed.categoryId },
        },
        status: 201,
      };
    },
  },
  "GET /v1/{market}/seller/products": {
    happy: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { req: { method: "GET", url: "/v1/eg/seller/products?limit=10", headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
    },
  },
  "GET /v1/{market}/seller/products/{product_id}": readFixture((t) => `/v1/eg/seller/products/${t.seed.productA}`, foreignProduct),
  "GET /v1/{market}/seller/products/{product_id}/readiness": readFixture((t) => `/v1/eg/seller/products/${t.seed.productA}/readiness`, foreignProduct),
  "PATCH /v1/{market}/seller/products/{product_id}": {
    happy: async (t) => {
      const d = await newDraft(t, t.seed.storeA);
      return {
        req: {
          method: "PATCH",
          url: `/v1/eg/seller/products/${d.id}`,
          headers: { ...sellerHeaders(t, d.token, t.seed.storeA), "if-match": `"${String(d.version)}"` },
          payload: { details: DETAILS(t.seed.categoryId), price: { price: { amount_minor: "129900", currency: "EGP" } } },
        },
        status: 200,
      };
    },
    otherTenant: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return {
        method: "PATCH",
        url: `/v1/eg/seller/products/${await foreignProduct(t)}`,
        headers: { ...sellerHeaders(t, token, t.seed.storeA), "if-match": '"1"' },
        payload: { details: DETAILS(t.seed.categoryId) },
      };
    },
  },
  "POST /v1/{market}/seller/products/{product_id}/media": {
    happy: async (t) => {
      const d = await newDraft(t, t.seed.storeA);
      const form = multipartBody({ kind: "product" }, { name: "front.png", type: "image/png", data: makePng() });
      return { req: { method: "POST", url: `/v1/eg/seller/products/${d.id}/media`, headers: { ...sellerHeaders(t, d.token, t.seed.storeA), "content-type": form.contentType }, payload: form.payload }, status: 201 };
    },
    otherTenant: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      const form = multipartBody({ kind: "product" }, { name: "front.png", type: "image/png", data: makePng() });
      return { method: "POST", url: `/v1/eg/seller/products/${await foreignProduct(t)}/media`, headers: { ...sellerHeaders(t, token, t.seed.storeA), "content-type": form.contentType }, payload: form.payload };
    },
  },
  "POST /v1/{market}/seller/products/{product_id}/defect-cards": {
    happy: async (t) => {
      const d = await newDraft(t, t.seed.storeA, "open_box");
      return {
        req: {
          method: "POST",
          url: `/v1/eg/seller/products/${d.id}/defect-cards`,
          headers: { ...sellerHeaders(t, d.token, t.seed.storeA), "if-match": `"${String(d.version)}"` },
          payload: DEFECT_CARD(),
        },
        status: 201,
      };
    },
    otherTenant: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { method: "POST", url: `/v1/eg/seller/products/${await foreignProduct(t)}/defect-cards`, headers: { ...sellerHeaders(t, token, t.seed.storeA), "if-match": '"1"' }, payload: DEFECT_CARD() };
    },
  },
  "POST /v1/{market}/seller/products/{product_id}/publish": {
    // A fresh draft cannot go live: the 409 with its reason list is the steady-state answer measured here (the 200 path has its own test).
    happy: async (t) => {
      const d = await newDraft(t, t.seed.storeA);
      return { req: { method: "POST", url: `/v1/eg/seller/products/${d.id}/publish`, headers: sellerHeaders(t, d.token, t.seed.storeA), payload: {} }, status: 409 };
    },
    otherTenant: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { method: "POST", url: `/v1/eg/seller/products/${await foreignProduct(t)}/publish`, headers: sellerHeaders(t, token, t.seed.storeA), payload: {} };
    },
  },
  "GET /v1/{market}/seller/categories": {
    happy: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { req: { method: "GET", url: "/v1/eg/seller/categories?limit=50", headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
    },
  },
  "GET /v1/{market}/seller/attribute-sets/{category_id}": {
    happy: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { req: { method: "GET", url: `/v1/eg/seller/attribute-sets/${t.seed.categoryId}`, headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
    },
    // Not tenant data: an unknown or inactive category is 404.
    otherTenant: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { method: "GET", url: "/v1/eg/seller/attribute-sets/00000000-0000-4000-8000-00000000dead", headers: { ...bearer(token), "x-store-id": t.seed.storeA } };
    },
  },
};

export function DEFECT_CARD() {
  return {
    summary_ar: "خدش خفيف على الجانب",
    affects_function: false,
    items: [{ defect_type_code: "stain", location_ar: "الجانب الأيمن", severity: "minor", affects_function: false, photo_media_id: "00000000-0000-4000-8000-0000000d0001", hotspot_x_bp: 2500, hotspot_y_bp: 6000 }],
  };
}
