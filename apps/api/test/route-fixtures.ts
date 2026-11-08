import type { InjectOptions } from "fastify";
import { DEVICE, bearer, idemKey } from "./harness.js";
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
};
