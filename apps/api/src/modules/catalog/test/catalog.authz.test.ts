import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED } from "../adapters/in-memory";
import { PRINCIPALS, STORE_A, bearer, createCatalogHarness, idemKey, type CatalogHarness } from "./harness";

/**
 * Negative authorization matrix for every catalog route (master prompt A2.10):
 * unauthenticated 401, wrong audience 401, suspended 403, wrong role or scope 403, other tenant 404.
 */
let h: CatalogHarness;
let productId = "";
let importId = "";
const UP = "0192f3a4-5b6c-7d8e-9f01-0000000e0001";
const MISSING = "0192f3a4-5b6c-7d8e-9f01-0000000eeeee";
const PROBLEM_KEYS = ["type", "title", "status", "detail", "code", "request_id", "errors"];

beforeAll(async () => {
  h = await createCatalogHarness();
  h.fixtures.uploads.add(STORE_A, UP, "product_ref,title_ar,category_slug,condition,size_label,price_egp\n");
  const r = await h
    .http()
    .post("/v1/seller/products")
    .set(bearer(PRINCIPALS.ownerA))
    .set("Idempotency-Key", idemKey())
    .send({
      title: { ar: "فستان" },
      category_id: SEED.categoryDresses,
      condition: "new_with_tags",
      skus: [{ size_label: "M", price: { amount: "1000", currency: "EGP" } }],
    });
  productId = r.body.id as string;
  const imp = await h.http().post("/v1/seller/catalog/imports").set(bearer(PRINCIPALS.ownerA)).set("Idempotency-Key", idemKey()).send({ upload_id: UP });
  importId = imp.body.id as string;
  expect(productId).not.toBe("");
  expect(importId).not.toBe("");
});
afterAll(async () => {
  await h.close();
});

function expectProblem(body: Record<string, unknown>): void {
  for (const k of Object.keys(body)) expect(PROBLEM_KEYS).toContain(k);
}

function routes(): { name: string; id: boolean; write: boolean; send: (token: string | null, id?: string) => Promise<{ status: number; body: Record<string, unknown> }> }[] {
  const auth = (t: string | null): Record<string, string> => (t === null ? {} : { Authorization: `Bearer ${t}` });
  return [
    {
      name: "GET /v1/products/{id}",
      id: true,
      write: false,
      send: (t, id) => h.http().get(`/v1/products/${id ?? productId}`).set(auth(t)),
    },
    { name: "GET /v1/seller/categories", id: false, write: false, send: (t) => h.http().get("/v1/seller/categories").set(auth(t)) },
    { name: "GET /v1/seller/products", id: false, write: false, send: (t) => h.http().get("/v1/seller/products").set(auth(t)) },
    {
      name: "POST /v1/seller/products",
      id: false,
      write: true,
      send: (t) =>
        h
          .http()
          .post("/v1/seller/products")
          .set(auth(t))
          .set("Idempotency-Key", idemKey())
          .send({ title: { ar: "قميص" }, category_id: SEED.categoryDresses, condition: "sample", skus: [{ size_label: "S", price: { amount: "500", currency: "EGP" } }] }),
    },
    {
      name: "GET /v1/seller/products/{id}",
      id: true,
      write: false,
      send: (t, id) => h.http().get(`/v1/seller/products/${id ?? productId}`).set(auth(t)),
    },
    {
      name: "PATCH /v1/seller/products/{id}",
      id: true,
      write: true,
      send: (t, id) => h.http().patch(`/v1/seller/products/${id ?? productId}`).set(auth(t)).set("If-Match", '"x"').send({ material: "كتان" }),
    },
    {
      name: "POST /v1/seller/catalog/imports",
      id: false,
      write: true,
      send: (t) => h.http().post("/v1/seller/catalog/imports").set(auth(t)).set("Idempotency-Key", idemKey()).send({ upload_id: UP }),
    },
    {
      name: "GET /v1/seller/catalog/imports/{id}",
      id: true,
      write: false,
      send: (t, id) => h.http().get(`/v1/seller/catalog/imports/${id ?? importId}`).set(auth(t)),
    },
  ];
}

describe("catalog authorization matrix", () => {
  it("covers every route registered by the module", () => {
    expect(routes().map((r) => r.name)).toEqual([
      "GET /v1/products/{id}",
      "GET /v1/seller/categories",
      "GET /v1/seller/products",
      "POST /v1/seller/products",
      "GET /v1/seller/products/{id}",
      "PATCH /v1/seller/products/{id}",
      "POST /v1/seller/catalog/imports",
      "GET /v1/seller/catalog/imports/{id}",
    ]);
  });

  for (const r of routes()) {
    describe(r.name, () => {
      it("401 without credentials and with a garbage token", async () => {
        for (const t of [null, "garbage-token-not-known-0000"]) {
          const res = await r.send(t);
          expect(res.status).toBe(401);
          expectProblem(res.body);
        }
      });

      it("401 for a token of the wrong audience", async () => {
        const token = r.name.includes("/seller/") ? PRINCIPALS.buyer.token : PRINCIPALS.ownerA.token;
        const res = await r.send(token);
        expect(res.status).toBe(401);
        expectProblem(res.body);
      });

      it("403 for a suspended actor", async () => {
        const token = r.name.includes("/seller/") ? PRINCIPALS.sellerSuspended.token : PRINCIPALS.buyerSuspended.token;
        const res = await r.send(token);
        expect(res.status).toBe(403);
        expectProblem(res.body);
      });

      if (r.name.includes("/seller/")) {
        it("403 for a seller token without any store grant", async () => {
          const res = await r.send(PRINCIPALS.noGrants.token);
          // Id routes resolve the object first: a real object with no grant is a 403, never data.
          expect(res.status).toBe(403);
          expectProblem(res.body);
        });
      }

      if (r.write) {
        it("403 for read-only store roles and for a read-only token scope", async () => {
          for (const p of [PRINCIPALS.supportA, PRINCIPALS.warehouseA, PRINCIPALS.readOnlyScopeA]) {
            const res = await r.send(p.token);
            expect(res.status).toBe(403);
            expectProblem(res.body);
          }
        });
      }

      if (r.id && r.name.includes("/seller/")) {
        it("404 for another tenant, identical to a missing object", async () => {
          const foreign = await r.send(PRINCIPALS.ownerB.token);
          const missing = await r.send(PRINCIPALS.ownerB.token, MISSING);
          expect(foreign.status).toBe(404);
          expect(missing.status).toBe(404);
          expect({ ...foreign.body, request_id: undefined }).toEqual({ ...missing.body, request_id: undefined });
        });
      }
    });
  }

  it("allows the owner and read-only roles where the rules say so", async () => {
    const byName = new Map(routes().map((r) => [r.name, r]));
    const get = byName.get("GET /v1/seller/products/{id}");
    const list = byName.get("GET /v1/seller/products");
    expect((await get?.send(PRINCIPALS.supportA.token))?.status).toBe(200);
    expect((await list?.send(PRINCIPALS.warehouseA.token))?.status).toBe(200);
    expect((await get?.send(PRINCIPALS.ownerA.token))?.status).toBe(200);
    // A buyer can never read the seller view of a product, even a public one.
    expect((await get?.send(PRINCIPALS.buyer.token))?.status).toBe(401);
  });

  it("denies a store header naming a store the actor does not staff", async () => {
    const r = await h
      .http()
      .get("/v1/seller/products")
      .set(bearer(PRINCIPALS.ownerA))
      .set("X-Store-Id", "0192f3a4-5b6c-7d8e-9f01-000000009002");
    expect(r.status).toBe(403);
  });
});
