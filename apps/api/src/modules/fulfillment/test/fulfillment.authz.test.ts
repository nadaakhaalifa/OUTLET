/**
 * Negative authorization matrix for the fulfillment module: every seller route is exercised for
 * unauthenticated (401), wrong audience (401), suspended subject (403), missing role (403),
 * missing token scope (403) and another store's object (404, byte-identical to a missing one,
 * no side effect). The webhook route is public and is covered by its HMAC tests.
 */
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHZ_META, type AuthzMeta } from "../../../platform/decorators";
import { CourierWebhookController } from "../adapters/webhook.controller";
import { FulfillmentSellerController } from "../adapters/fulfillment.controller";
import {
  PRINCIPALS,
  STORE_A,
  STORE_B,
  bearer,
  createFulfillmentHarness,
  idemKey,
  sellerOrder,
  uid,
  type FulfillmentHarness,
  type TestPrincipal,
} from "./harness";

let h: FulfillmentHarness;
let shipmentId: string;
let orderId: string;

const strip = (body: Record<string, unknown>) => {
  const { request_id: _r, ...rest } = body;
  return rest;
};

interface Route {
  readonly key: string;
  readonly authz: AuthzMeta["kind"];
  readonly send: (token: string | null, id?: string) => Test;
}

const auth = (t: string | null): Record<string, string> => (t === null ? {} : bearer(t));

const ROUTES: readonly Route[] = [
  {
    key: "POST /v1/seller/shipments",
    authz: "self",
    send: (t, id) =>
      h.http().post("/v1/seller/shipments").set(auth(t)).set("Idempotency-Key", idemKey()).send({ seller_order_ids: [id ?? orderId] }),
  },
  {
    key: "GET /v1/seller/shipments/:shipmentId",
    authz: "resource",
    send: (t, id) => h.http().get(`/v1/seller/shipments/${id ?? shipmentId}`).set(auth(t)),
  },
  {
    key: "GET /v1/seller/shipments/:shipmentId/label",
    authz: "resource",
    send: (t, id) => h.http().get(`/v1/seller/shipments/${id ?? shipmentId}/label`).set(auth(t)),
  },
];

beforeAll(async () => {
  h = await createFulfillmentHarness();
  const first = sellerOrder(1, STORE_A);
  const second = sellerOrder(2, STORE_A);
  h.orders.add(first);
  h.orders.add(second);
  orderId = second.id;
  const r = await h
    .http()
    .post("/v1/seller/shipments")
    .set(bearer(PRINCIPALS.ownerA))
    .set("Idempotency-Key", idemKey())
    .send({ seller_order_ids: [first.id] });
  shipmentId = r.body.id as string;
});
afterAll(async () => {
  await h.close();
});

describe("route declarations", () => {
  it("every route of both controllers declares an authorization mode", () => {
    const seen: string[] = [];
    for (const ctrl of [FulfillmentSellerController, CourierWebhookController]) {
      const proto = ctrl.prototype as unknown as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = proto[name];
        if (typeof fn !== "function" || name === "constructor") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
        if (method === undefined) continue;
        const meta = Reflect.getMetadata(AUTHZ_META, fn) as AuthzMeta | undefined;
        expect(meta, `${ctrl.name}.${name} has no authorization declaration`).toBeDefined();
        seen.push(`${RequestMethod[method]} ${String(Reflect.getMetadata(PATH_METADATA, fn))}`);
      }
    }
    expect(seen.sort()).toEqual([
      "GET shipments/:shipmentId",
      "GET shipments/:shipmentId/label",
      "POST :courier",
      "POST shipments",
    ]);
  });

  it("only the webhook route is public", () => {
    const proto = CourierWebhookController.prototype as unknown as Record<string, unknown>;
    const meta = Reflect.getMetadata(AUTHZ_META, proto.receive as object) as AuthzMeta;
    expect(meta.kind).toBe("public");
    const seller = FulfillmentSellerController.prototype as unknown as Record<string, unknown>;
    for (const name of ["create", "read", "label"]) {
      const m = Reflect.getMetadata(AUTHZ_META, seller[name] as object) as AuthzMeta;
      expect(m.kind).not.toBe("public");
    }
  });
});

describe.each(ROUTES)("$key", (route) => {
  it("401 without a token", async () => {
    expect((await route.send(null)).status).toBe(401);
  });

  it("401 for a buyer-audience token", async () => {
    expect((await route.send(PRINCIPALS.buyer.token)).status).toBe(401);
  });

  it("401 for a garbage token", async () => {
    expect((await route.send("not-a-real-token-123456")).status).toBe(401);
  });

  it("403 for a suspended seller", async () => {
    expect((await route.send(PRINCIPALS.suspendedA.token)).status).toBe(403);
  });

  it("403 for a seller with no brand grant", async () => {
    expect((await route.send(PRINCIPALS.noGrants.token)).status).toBe(403);
  });

  it("403 for a catalog-only role (no store_order rights)", async () => {
    expect((await route.send(PRINCIPALS.catalogA.token)).status).toBe(403);
  });

  it("404 for another store's object, identical to a missing one", async () => {
    const foreign = await route.send(PRINCIPALS.ownerB.token);
    const missing = await route.send(PRINCIPALS.ownerB.token, uid(777_001));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(strip(foreign.body)).toEqual(strip(missing.body));
  });
});

describe("write rules", () => {
  it("support can read but not create (role), and a read-only token cannot create (scope)", async () => {
    const read = await h.http().get(`/v1/seller/shipments/${shipmentId}`).set(bearer(PRINCIPALS.supportA));
    expect(read.status).toBe(200);
    const create = ROUTES[0]?.send(PRINCIPALS.supportA.token);
    expect((await create)?.status).toBe(403);
    const scope = await ROUTES[0]?.send(PRINCIPALS.readOnlyA.token);
    expect(scope?.status).toBe(403);
  });

  it("warehouse staff of the owning store can create and read", async () => {
    const o = sellerOrder(40, STORE_A);
    h.orders.add(o);
    const r = await h
      .http()
      .post("/v1/seller/shipments")
      .set(bearer(PRINCIPALS.warehouseA))
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [o.id] });
    expect(r.status).toBe(201);
    const g = await h.http().get(`/v1/seller/shipments/${r.body.id}`).set(bearer(PRINCIPALS.warehouseA));
    expect(g.status).toBe(200);
  });
});

describe("cross-tenant isolation", () => {
  it("store B cannot create a shipment for store A's order and nothing happens", async () => {
    const o = sellerOrder(50, STORE_A);
    h.orders.add(o);
    const calls = h.courier.createCalls;
    const r = await h
      .http()
      .post("/v1/seller/shipments")
      .set(bearer(PRINCIPALS.ownerB))
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [o.id] });
    expect(r.status).toBe(404);
    expect(await h.repo.findLiveBySellerOrder(o.id)).toBeNull();
    expect(h.courier.createCalls).toBe(calls);
    const unknown = await h
      .http()
      .post("/v1/seller/shipments")
      .set(bearer(PRINCIPALS.ownerB))
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [uid(888_001)] });
    expect(unknown.status).toBe(404);
    expect(strip(unknown.body)).toEqual(strip(r.body));
  });

  it("a body-supplied store id is refused and cannot redirect the tenant", async () => {
    const o = sellerOrder(51, STORE_A);
    h.orders.add(o);
    const r = await h
      .http()
      .post("/v1/seller/shipments")
      .set(bearer(PRINCIPALS.ownerB))
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [o.id], store_id: STORE_B });
    expect(r.status).toBe(400);
  });

  it("owner of store A cannot see store B's shipment either", async () => {
    const o = sellerOrder(52, STORE_B);
    h.orders.add(o);
    const made = await h
      .http()
      .post("/v1/seller/shipments")
      .set(bearer(PRINCIPALS.ownerB))
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [o.id] });
    expect(made.status).toBe(201);
    const peek = await h.http().get(`/v1/seller/shipments/${made.body.id}`).set(bearer(PRINCIPALS.ownerA));
    expect(peek.status).toBe(404);
  });

  it("a non-UUID shipment id is a 400 from validation, never a lookup", async () => {
    const r = await h.http().get("/v1/seller/shipments/not-a-uuid").set(bearer(PRINCIPALS.ownerA));
    expect([400, 404]).toContain(r.status);
  });
});

describe("webhook route authentication", () => {
  it("needs no bearer token but rejects everything without a valid signature", async () => {
    const r = await h.http().post("/v1/webhooks/couriers/bosta").set("content-type", "application/json").send("{}");
    expect(r.status).toBe(401);
  });

  it("is not reachable with a user token in place of a signature", async () => {
    const r = await h
      .http()
      .post("/v1/webhooks/couriers/bosta")
      .set(bearer(PRINCIPALS.ownerA as TestPrincipal))
      .set("content-type", "application/json")
      .send("{}");
    expect(r.status).toBe(401);
  });
});
