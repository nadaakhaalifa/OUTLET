/**
 * Negative authorization matrix for the returns module. Every route is exercised for
 * unauthenticated (401), wrong audience (401), suspended subject (403), missing role or scope
 * (403) and another actor's object (404, identical to a missing one, no side effect).
 */
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHZ_META, type AuthzMeta } from "../../../platform/decorators";
import { ReturnsController } from "../adapters/returns.controller";
import { IDEM, TOKENS, U, bearer, createReturnsHarness, line, type ReturnsHarness } from "./returns-harness";

let h: ReturnsHarness;
let seq = 0;
const idem = () => ({ "Idempotency-Key": IDEM(900_000 + ++seq) });
const auth = (t: string | null): Record<string, string> => (t === null ? {} : bearer(t));

/** The shopper-1 line and its return (state RECEIVED) in store A. */
let lineId: string;
let returnId: string;
const MISSING = U(424_242);

interface Route {
  readonly key: string;
  readonly authz: AuthzMeta["kind"];
  readonly audience: "buyer_api" | "seller_api";
  readonly objectId: boolean;
  readonly send: (token: string | null, id: string | null) => Test;
}

const ROUTES: readonly Route[] = [
  {
    key: "POST /v1/orders/lines/:orderLineId/returns",
    authz: "resource",
    audience: "buyer_api",
    objectId: true,
    send: (t, id) =>
      h
        .http()
        .post(`/v1/orders/lines/${id ?? lineId}/returns`)
        .set(auth(t))
        .set(idem())
        .send({ qty: 1, reason: "changed_mind", resolution: "refund", method: "pickup" }),
  },
  {
    key: "GET /v1/me/returns",
    authz: "self",
    audience: "buyer_api",
    objectId: false,
    send: (t) => h.http().get("/v1/me/returns").set(auth(t)),
  },
  {
    key: "GET /v1/me/returns/:returnId",
    authz: "resource",
    audience: "buyer_api",
    objectId: true,
    send: (t, id) => h.http().get(`/v1/me/returns/${id ?? returnId}`).set(auth(t)),
  },
  {
    key: "POST /v1/returns/:returnId/dispute",
    authz: "resource",
    audience: "buyer_api",
    objectId: true,
    send: (t, id) =>
      h.http().post(`/v1/returns/${id ?? returnId}/dispute`).set(auth(t)).set(idem()).send({ statement: "it was unused" }),
  },
  {
    key: "GET /v1/seller/returns",
    authz: "resource",
    audience: "seller_api",
    objectId: false,
    send: (t) => h.http().get("/v1/seller/returns").set(auth(t)),
  },
  {
    key: "POST /v1/seller/returns/:returnId/inspect",
    authz: "resource",
    audience: "seller_api",
    objectId: true,
    send: (t, id) =>
      h.http().post(`/v1/seller/returns/${id ?? returnId}/inspect`).set(auth(t)).set(idem()).send({ result: "approve" }),
  },
];

const strip = (body: Record<string, unknown>) => {
  const { request_id: _r, ...rest } = body;
  return rest;
};

beforeAll(async () => {
  h = await createReturnsHarness();
  const l = line(1);
  h.lines.add(l);
  lineId = l.orderLineId;
  const r = await h
    .http()
    .post(`/v1/orders/lines/${lineId}/returns`)
    .set(bearer(TOKENS.shopper1))
    .set(idem())
    .send({ qty: 1, reason: "changed_mind", resolution: "refund", method: "pickup" });
  returnId = r.body.id as string;
  await h.schedulePickup.execute(returnId);
  await h.pickedUp.execute(returnId);
  await h.received.execute(returnId);
}, 30_000);
afterAll(async () => {
  await h.close();
});

describe("route coverage", () => {
  it("every controller route is in the matrix and declares an authorization mode", () => {
    const proto = ReturnsController.prototype as unknown as Record<string, unknown>;
    const METHODS: Record<number, string> = { [RequestMethod.GET]: "GET", [RequestMethod.POST]: "POST" };
    const found: string[] = [];
    for (const name of Object.getOwnPropertyNames(ReturnsController.prototype)) {
      const fn = proto[name];
      if (typeof fn !== "function") continue;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      if (method === undefined) continue;
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
      const meta = Reflect.getMetadata(AUTHZ_META, fn) as AuthzMeta | undefined;
      expect(meta, `${name} must declare authorization`).toBeDefined();
      const key = `${METHODS[method]} /v1/${path}`;
      found.push(key);
      const entry = ROUTES.find((r) => r.key === key);
      expect(entry, `${key} missing from matrix`).toBeDefined();
      expect(meta?.kind).toBe(entry?.authz);
      if (meta?.kind === "resource") expect(meta.audience).toBe(entry?.audience);
    }
    expect(found.sort()).toEqual(ROUTES.map((r) => r.key).sort());
  });
});

describe.each(ROUTES.map((r) => [r.key, r] as const))("%s", (_key, route) => {
  const suspended = route.audience === "buyer_api" ? TOKENS.suspended : TOKENS.suspendedSeller;

  it("unauthenticated is 401 with no extra problem members", async () => {
    const r = await route.send(null, null);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("unauthenticated");
    expect(Object.keys(r.body).sort()).toEqual(["code", "request_id", "status", "title", "type"]);
  });

  it("a malformed bearer token is 401", async () => {
    expect((await route.send("not-a-real-token-0000000000", null)).status).toBe(401);
  });

  it("the other audience's token is 401", async () => {
    const token = route.audience === "buyer_api" ? TOKENS.sellerAudShopper : TOKENS.buyerAudSeller;
    expect((await route.send(token, null)).status).toBe(401);
  });

  it("a suspended subject is 403", async () => {
    const r = await route.send(suspended, null);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("account_not_active");
  });
});

describe("seller role and scope", () => {
  it("a shopper grant on the seller audience is 403", async () => {
    expect((await h.http().get("/v1/seller/returns").set(bearer(TOKENS.sellerAudShopper))).status).toBe(403);
    const r = await h
      .http()
      .post(`/v1/seller/returns/${returnId}/inspect`)
      .set(bearer(TOKENS.sellerAudShopper))
      .set(idem())
      .send({ result: "approve" });
    expect(r.status).toBe(403);
  });

  it("a catalog role cannot read or inspect returns (403) and the return is untouched", async () => {
    expect((await h.http().get("/v1/seller/returns").set(bearer(TOKENS.catalogA))).status).toBe(403);
    const r = await h
      .http()
      .post(`/v1/seller/returns/${returnId}/inspect`)
      .set(bearer(TOKENS.catalogA))
      .set(idem())
      .send({ result: "approve" });
    expect(r.status).toBe(403);
    expect((await h.repo.findById(returnId))?.state).toBe("RECEIVED");
  });

  it("a token without seller:write cannot inspect (403)", async () => {
    const r = await h
      .http()
      .post(`/v1/seller/returns/${returnId}/inspect`)
      .set(bearer(TOKENS.noScopeA))
      .set(idem())
      .send({ result: "approve" });
    expect(r.status).toBe(403);
    expect((await h.repo.findById(returnId))?.state).toBe("RECEIVED");
  });
});

describe("another actor's object", () => {
  it("a foreign order line is 404, byte-identical to a missing one, with no side effect", async () => {
    const route = ROUTES[0];
    if (route === undefined) throw new Error("matrix");
    const foreign = await route.send(TOKENS.shopper2, lineId);
    const missing = await route.send(TOKENS.shopper2, MISSING);
    const malformed = await route.send(TOKENS.shopper2, "not-a-uuid");
    expect([foreign.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
    expect(strip(foreign.body)).toEqual(strip(missing.body));
    expect(await h.repo.committedQty(lineId)).toBe(1);
  });

  it("a foreign return is 404 for read and dispute, identical to a missing one", async () => {
    for (const idx of [2, 3]) {
      const route = ROUTES[idx];
      if (route === undefined) throw new Error("matrix");
      const foreign = await route.send(TOKENS.shopper2, returnId);
      const missing = await route.send(TOKENS.shopper2, MISSING);
      const malformed = await route.send(TOKENS.shopper2, "not-a-uuid");
      expect([foreign.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
      expect(strip(foreign.body)).toEqual(strip(missing.body));
    }
    expect((await h.repo.findById(returnId))?.dispute).toBeNull();
  });

  it("another store's seller gets 404 on inspect, identical to a missing return, and the return is untouched", async () => {
    const route = ROUTES[5];
    if (route === undefined) throw new Error("matrix");
    const foreign = await route.send(TOKENS.ownerB, returnId);
    const missing = await route.send(TOKENS.ownerB, MISSING);
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    expect(strip(foreign.body)).toEqual(strip(missing.body));
    expect((await h.repo.findById(returnId))?.state).toBe("RECEIVED");
  });

  it("another store's queue never contains this return", async () => {
    const r = await h.http().get("/v1/seller/returns").set(bearer(TOKENS.ownerB));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(returnId);
    const mine = await h.http().get("/v1/me/returns").set(bearer(TOKENS.shopper2));
    expect(JSON.stringify(mine.body)).not.toContain(returnId);
  });

  it("the owning shopper and the owning store can act (positive controls)", async () => {
    const own = await h.http().get(`/v1/me/returns/${returnId}`).set(bearer(TOKENS.shopper1));
    expect(own.status).toBe(200);
    const sup = await h
      .http()
      .post(`/v1/seller/returns/${returnId}/inspect`)
      .set(bearer(TOKENS.supportA))
      .set(idem())
      .send({ result: "approve" });
    expect(sup.status).toBe(200);
  });
});
