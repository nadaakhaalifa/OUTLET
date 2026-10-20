/**
 * Negative authorization matrix for the cart module: every route is exercised for
 * unauthenticated (401), wrong audience (401), suspended subject (403) and another user's
 * object (404, byte-identical to a missing one, no side effect).
 */
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { buildAccessClaims } from "@outlet/auth-core";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHZ_META, type AuthzMeta } from "../../../platform/decorators";
import { AUTHENTICATOR, type Authenticator } from "../../../platform";
import { login, type LoggedIn } from "../../../test/harness";
import { CartController } from "../adapters/cart.controller";
import { EGP, createCartHarness, uid, type CartHarness } from "./cart-harness";

let h: CartHarness;
let a: LoggedIn;
let b: LoggedIn;
let storeId: string;
let aLineId: string;
let bLineId: string;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const idem = () => ({ "Idempotency-Key": uid(7) });

interface Route {
  readonly key: string;
  readonly authz: AuthzMeta["kind"];
  readonly objectId: boolean;
  readonly send: (token: string | null, lineId: string | null) => Test;
}

const auth = (t: string | null): Record<string, string> => (t === null ? {} : bearer(t));

const ROUTES: readonly Route[] = [
  { key: "GET /v1/cart", authz: "self", objectId: false, send: (t) => h.http().get("/v1/cart").set(auth(t)) },
  {
    key: "POST /v1/cart/lines",
    authz: "self",
    objectId: false,
    send: (t) => h.http().post("/v1/cart/lines").set(auth(t)).set(idem()).send({ sku_id: uid(2), qty: 1 }),
  },
  {
    key: "PATCH /v1/cart/lines/:lineId",
    authz: "resource",
    objectId: true,
    send: (t, id) => h.http().patch(`/v1/cart/lines/${id ?? uid(4)}`).set(auth(t)).set("If-Match", '"x"').send({ qty: 2 }),
  },
  {
    key: "DELETE /v1/cart/lines/:lineId",
    authz: "resource",
    objectId: true,
    send: (t, id) => h.http().delete(`/v1/cart/lines/${id ?? uid(4)}`).set(auth(t)),
  },
  {
    key: "GET /v1/cart/free-delivery-suggestions",
    authz: "self",
    objectId: false,
    send: (t) => h.http().get(`/v1/cart/free-delivery-suggestions?store_id=${storeId}`).set(auth(t)),
  },
];

const strip = (body: Record<string, unknown>) => {
  const { request_id: _r, ...rest } = body;
  return rest;
};

beforeAll(async () => {
  h = await createCartHarness();
  storeId = uid(1);
  h.catalog.addStore(storeId);
  const mk = () => {
    const skuId = uid(2);
    h.catalog.addSku({ skuId, productId: uid(3), storeId, title: { ar: "قميص" }, unitPrice: EGP(100n), available: true });
    return skuId;
  };
  a = await login(h, "+201005599001");
  b = await login(h, "+201005599002");
  const ra = await h.http().post("/v1/cart/lines").set(bearer(a.accessToken)).set(idem()).send({ sku_id: mk(), qty: 1 });
  const rb = await h.http().post("/v1/cart/lines").set(bearer(b.accessToken)).set(idem()).send({ sku_id: mk(), qty: 1 });
  aLineId = ra.body.groups[0].lines[0].id;
  bLineId = rb.body.groups[0].lines[0].id;
}, 30_000);
afterAll(async () => {
  await h.close();
});

describe("route coverage", () => {
  it("every controller route is in the matrix and declares an authorization mode", () => {
    const proto = CartController.prototype as unknown as Record<string, unknown>;
    const found: string[] = [];
    const METHODS: Record<number, string> = {
      [RequestMethod.GET]: "GET",
      [RequestMethod.POST]: "POST",
      [RequestMethod.PATCH]: "PATCH",
      [RequestMethod.DELETE]: "DELETE",
    };
    for (const name of Object.getOwnPropertyNames(CartController.prototype)) {
      const fn = proto[name];
      if (typeof fn !== "function") continue;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      if (method === undefined) continue;
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
      const meta = Reflect.getMetadata(AUTHZ_META, fn) as AuthzMeta | undefined;
      expect(meta, `${name} must declare authorization`).toBeDefined();
      const full = `/v1/cart${path === "/" || path === "" ? "" : `/${path}`}`;
      const key = `${METHODS[method]} ${full}`;
      found.push(key);
      const entry = ROUTES.find((r) => r.key === key);
      expect(entry, `${key} missing from matrix`).toBeDefined();
      expect(meta?.kind).toBe(entry?.authz);
    }
    expect(found.sort()).toEqual(ROUTES.map((r) => r.key).sort());
  });
});

describe.each(ROUTES.map((r) => [r.key, r] as const))("%s", (_key, route) => {
  it("unauthenticated is 401 with no extra problem members", async () => {
    const r = await route.send(null, bLineId);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("unauthenticated");
    expect(Object.keys(r.body).sort()).toEqual(["code", "request_id", "status", "title", "type"]);
  });

  it("a malformed bearer token is 401", async () => {
    expect((await route.send("not-a-real-token-0000000000", bLineId)).status).toBe(401);
  });

  it("a seller_api token is 401, a suspended subject is 403", async () => {
    const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
    const issuer = authn as unknown as { issue(claims: unknown): Promise<string> };
    const sellerToken = await issuer.issue(
      buildAccessClaims({
        issuer: h.config.tokenIssuer,
        userId: a.userId,
        audience: "seller_api",
        sessionId: a.sessionId,
        jti: `jti-cart-${route.key}`,
        amr: ["otp_sms"],
        nowMs: h.clock.nowMs(),
      }),
    );
    expect((await route.send(sellerToken, aLineId)).status).toBe(401);

    const original = authn.authenticate.bind(authn);
    authn.authenticate = async (t, n) => {
      const p = await original(t, n);
      return p === null ? null : { ...p, actor: { ...p.actor, status: "suspended" } };
    };
    try {
      const r = await route.send(a.accessToken, aLineId);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("account_not_active");
    } finally {
      authn.authenticate = original;
    }
  });
});

describe("another user's line", () => {
  it.each(ROUTES.filter((r) => r.objectId).map((r) => [r.key, r] as const))(
    "%s is 404, identical to a missing id, and has no side effect",
    async (_k, route) => {
      const foreign = await route.send(a.accessToken, bLineId);
      const missing = await route.send(a.accessToken, uid(4));
      const malformed = await route.send(a.accessToken, "not-a-uuid");
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(malformed.status).toBe(404);
      expect(strip(foreign.body)).toEqual(strip(missing.body));
      const stillThere = await h.http().get("/v1/cart").set(bearer(b.accessToken));
      expect(stillThere.body.groups[0].lines.map((l: { id: string }) => l.id)).toContain(bLineId);
      const own = await h.http().get("/v1/cart").set(bearer(a.accessToken));
      expect(own.body.groups[0].lines.map((l: { id: string }) => l.id)).not.toContain(bLineId);
    },
  );

  it("never exposes another user's bag through GET /v1/cart", async () => {
    const r = await h.http().get("/v1/cart").set(bearer(a.accessToken));
    expect(JSON.stringify(r.body)).not.toContain(bLineId);
    expect(JSON.stringify(r.body)).not.toContain(b.userId);
  });

  it("the owner can still delete their own line (positive control)", async () => {
    const r = await h.http().delete(`/v1/cart/lines/${aLineId}`).set(bearer(a.accessToken));
    expect(r.status).toBe(200);
    expect(r.body.groups).toEqual([]);
  });
});
