/**
 * Negative authorization matrix for the promotions module. Every route is exercised for:
 * unauthenticated (401), malformed token (401), wrong audience (401), suspended subject (403),
 * wrong role (403), missing token scope (403), missing passkey on admin (403) and another tenant's
 * object (404, byte-identical to a missing one, no side effect).
 */
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHZ_META, type AuthzMeta } from "../../../platform/decorators";
import type { LoggedIn } from "../../../test/harness";
import {
  AdminPromotionsController,
  InternalPromotionsController,
  SellerPromotionsController,
} from "../adapters/promotions.controllers";
import { record } from "./repository-contract";
import {
  ADMIN_SCOPES,
  EGP,
  SELLER_SCOPES,
  SERVICE_TOKEN,
  adminGrants,
  brandGrants,
  createPromotionsHarness,
  login,
  uid,
  type PromotionsHarness,
} from "./promotions-harness";

let h: PromotionsHarness;
let user: LoggedIn;
let storeA: string;
let storeB: string;
let platformPromo: string;
let aPromo: string;
let bPromo: string;

const bearer = (t: string | null): Record<string, string> => (t === null ? {} : { Authorization: `Bearer ${t}` });
const idem = () => ({ "Idempotency-Key": uid(7) });
const iso = (ms: number) => new Date(ms).toISOString();
const body = (code: string) => ({
  type: "percent",
  title: { ar: "خصم" },
  code,
  funding: { platform_pct: 0, seller_pct: 100 },
  value: { percent_bp: 500 },
  starts_at: iso(h.clock.nowMs() - 1000),
  ends_at: iso(h.clock.nowMs() + 86_400_000),
});

type Surface = "admin" | "seller";
interface Route {
  readonly key: string;
  readonly surface: Surface;
  readonly objectId: boolean;
  readonly send: (token: string | null, id: string | null) => Test;
}

const routes = (s: Surface): Route[] => {
  const p = `/v1/${s}/promotions`;
  const withToken = (t: string | null) => bearer(t);
  const seed = (n: string) => `${s.toUpperCase()}${n}`;
  return [
    { key: `GET ${p}`, surface: s, objectId: false, send: (t) => h.http().get(p).set(withToken(t)) },
    {
      key: `POST ${p}`,
      surface: s,
      objectId: false,
      send: (t) => h.http().post(p).set(withToken(t)).set(idem()).send(body(seed(`NEW${uid(1).slice(-6)}`))),
    },
    {
      key: `GET ${p}/:promotionId`,
      surface: s,
      objectId: true,
      send: (t, id) => h.http().get(`${p}/${id ?? uid(4)}`).set(withToken(t)),
    },
    {
      key: `PATCH ${p}/:promotionId`,
      surface: s,
      objectId: true,
      send: (t, id) =>
        h.http().patch(`${p}/${id ?? uid(4)}`).set(withToken(t)).set("If-Match", `"${id ?? uid(4)}-v1"`).send({ status: "paused" }),
    },
    {
      key: `DELETE ${p}/:promotionId`,
      surface: s,
      objectId: true,
      send: (t, id) => h.http().delete(`${p}/${id ?? uid(4)}`).set(withToken(t)),
    },
  ];
};
const ADMIN_ROUTES = routes("admin");
const SELLER_ROUTES = routes("seller");

const tokens: Record<string, string> = {};
let adminNoPasskey: string;
let adminWrongRole: string;
let adminNoScope: string;
let sellerA: string;
let sellerCatalog: string;
let sellerNoScope: string;
let shopperAsSeller: string;
let shopperAsAdmin: string;
let suspendedAdmin: string;
let suspendedSeller: string;

beforeAll(async () => {
  h = await createPromotionsHarness();
  user = await login(h, "+201005599202");
  storeA = uid(1);
  storeB = uid(1);
  const mk = async (over: Parameters<typeof record>[0]) => {
    const r = record(over);
    await h.repo.insert(r);
    return r.id;
  };
  platformPromo = await mk({});
  aPromo = await mk({ owner: { kind: "store", storeId: storeA }, funding: { platformPct: 0, sellerPct: 100 } });
  bPromo = await mk({ owner: { kind: "store", storeId: storeB }, funding: { platformPct: 0, sellerPct: 100 } });
  tokens["admin"] = await h.mint(user, { audience: "admin_api", grants: adminGrants("marketing"), scopes: ADMIN_SCOPES, passkey: true });
  adminNoPasskey = await h.mint(user, { audience: "admin_api", grants: adminGrants("marketing"), scopes: ADMIN_SCOPES, passkey: false });
  adminWrongRole = await h.mint(user, { audience: "admin_api", grants: adminGrants("finance"), scopes: ADMIN_SCOPES, passkey: true });
  adminNoScope = await h.mint(user, { audience: "admin_api", grants: adminGrants("marketing"), scopes: [], passkey: true });
  sellerA = await h.mint(user, { audience: "seller_api", grants: brandGrants(storeA, "manager"), scopes: SELLER_SCOPES });
  sellerCatalog = await h.mint(user, { audience: "seller_api", grants: brandGrants(storeA, "catalog"), scopes: SELLER_SCOPES });
  sellerNoScope = await h.mint(user, { audience: "seller_api", grants: brandGrants(storeA, "owner"), scopes: [] });
  shopperAsSeller = await h.mint(user, { audience: "seller_api", grants: [{ kind: "shopper" }], scopes: SELLER_SCOPES });
  shopperAsAdmin = await h.mint(user, { audience: "admin_api", grants: [{ kind: "shopper" }], scopes: ADMIN_SCOPES, passkey: true });
  suspendedAdmin = await h.mint(user, { audience: "admin_api", grants: adminGrants(), scopes: ADMIN_SCOPES, passkey: true, status: "suspended" });
  suspendedSeller = await h.mint(user, { audience: "seller_api", grants: brandGrants(storeA), scopes: SELLER_SCOPES, status: "suspended" });
}, 30_000);
afterAll(async () => {
  await h.close();
});

const strip = (b: Record<string, unknown>) => {
  const { request_id: _r, ...rest } = b;
  return rest;
};

describe("route coverage", () => {
  it("every controller route is in the matrix and declares an authorization mode", () => {
    const METHODS: Record<number, string> = {
      [RequestMethod.GET]: "GET",
      [RequestMethod.POST]: "POST",
      [RequestMethod.PATCH]: "PATCH",
      [RequestMethod.DELETE]: "DELETE",
    };
    const expected = [...ADMIN_ROUTES, ...SELLER_ROUTES].map((r) => r.key).concat("POST /v1/promotions/evaluate");
    const found: string[] = [];
    const scan = (ctrl: { prototype: object }, prefix: string, audience: string | null) => {
      const proto = ctrl.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const fn = proto[name];
        if (typeof fn !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
        if (method === undefined) continue;
        const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
        const meta = Reflect.getMetadata(AUTHZ_META, fn) as AuthzMeta | undefined;
        expect(meta, `${name} must declare authorization`).toBeDefined();
        if (audience === null) expect(meta?.kind).toBe("public");
        else expect(meta).toEqual({ kind: "self", audience });
        const tail = path === "/" || path === "" ? "" : `/${path.replace(/^:(\w+)$/, ":$1")}`;
        found.push(`${METHODS[method]} ${prefix}${tail}`);
      }
    };
    scan(AdminPromotionsController, "/v1/admin/promotions", "admin_api");
    scan(SellerPromotionsController, "/v1/seller/promotions", "seller_api");
    scan(InternalPromotionsController, "/v1/promotions", null);
    expect(found.sort()).toEqual(expected.sort());
  });
});

describe.each([
  ["admin", ADMIN_ROUTES],
  ["seller", SELLER_ROUTES],
] as const)("%s routes", (surface, list) => {
  const wrongAudience = () => (surface === "admin" ? sellerA : tokens["admin"] ?? "");
  const noRole = () => (surface === "admin" ? shopperAsAdmin : shopperAsSeller);
  const suspended = () => (surface === "admin" ? suspendedAdmin : suspendedSeller);
  const noScope = () => (surface === "admin" ? adminNoScope : sellerNoScope);
  const ownObject = () => (surface === "admin" ? platformPromo : aPromo);

  describe.each(list.map((r) => [r.key, r] as const))("%s", (_k, route) => {
    it("unauthenticated is 401 with no extra problem members", async () => {
      const r = await route.send(null, ownObject());
      expect(r.status).toBe(401);
      expect(r.body.code).toBe("unauthenticated");
      expect(Object.keys(r.body).sort()).toEqual(["code", "request_id", "status", "title", "type"]);
    });

    it("a malformed bearer token is 401", async () => {
      expect((await route.send("not-a-real-token-0000000000", ownObject())).status).toBe(401);
    });

    it("a token minted for another audience is 401, including a buyer token", async () => {
      expect((await route.send(wrongAudience(), ownObject())).status).toBe(401);
      expect((await route.send(user.accessToken, ownObject())).status).toBe(401);
    });

    it("a suspended subject is 403", async () => {
      const r = await route.send(suspended(), ownObject());
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("account_not_active");
    });

    it("a shopper grant on the right audience is 403", async () => {
      const r = await route.send(noRole(), ownObject());
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("forbidden");
    });

    it("a missing token scope is 403", async () => {
      expect((await route.send(noScope(), ownObject())).status).toBe(403);
    });
  });

  it("a role without promotion rights is 403", async () => {
    const t = surface === "admin" ? adminWrongRole : sellerCatalog;
    for (const r of list) expect((await r.send(t, surface === "admin" ? platformPromo : aPromo)).status).toBe(403);
  });
});

describe("admin only", () => {
  it("a passkey-less admin session is 403 on every route", async () => {
    for (const r of ADMIN_ROUTES) expect((await r.send(adminNoPasskey, platformPromo)).status).toBe(403);
  });

  it("a store promotion is a 404 for admin object routes, identical to a missing id", async () => {
    for (const r of ADMIN_ROUTES.filter((x) => x.objectId)) {
      const foreign = await r.send(tokens["admin"] ?? "", aPromo);
      const missing = await r.send(tokens["admin"] ?? "", uid(4));
      expect(foreign.status).toBe(404);
      expect(strip(foreign.body)).toEqual(strip(missing.body));
    }
    expect((await h.repo.get(aPromo))?.status).toBe("active");
  });
});

describe("another tenant's promotion", () => {
  it.each(SELLER_ROUTES.filter((r) => r.objectId).map((r) => [r.key, r] as const))(
    "%s is 404 for another store, a platform promotion and a missing id, with no side effect",
    async (_k, route) => {
      const t = sellerA;
      const other = await route.send(t, bPromo);
      const platform = await route.send(t, platformPromo);
      const missing = await route.send(t, uid(4));
      const malformed = await route.send(t, "not-a-uuid");
      for (const r of [other, platform, missing]) expect(r.status).toBe(404);
      expect(malformed.status).toBe(400);
      expect(strip(other.body)).toEqual(strip(missing.body));
      expect(strip(platform.body)).toEqual(strip(missing.body));
      expect((await h.repo.get(bPromo))?.status).toBe("active");
      expect((await h.repo.get(platformPromo))?.version).toBe(1);
    },
  );

  it("list never contains another store's or platform rows", async () => {
    const r = await h.http().get("/v1/seller/promotions").set(bearer(sellerA));
    const ids = (r.body.items as { id: string }[]).map((x) => x.id);
    expect(ids).toEqual([aPromo]);
  });

  it("a header cannot select a store the actor has no grant for", async () => {
    const r = await h.http().get("/v1/seller/promotions").set(bearer(sellerA)).set("X-Store-Id", storeB);
    expect(r.status).toBe(404);
    const created = await h
      .http()
      .post("/v1/seller/promotions")
      .set(bearer(sellerA))
      .set("X-Store-Id", storeB)
      .set(idem())
      .send(body("CROSSSTORE"));
    expect(created.status).toBe(404);
    expect(await h.repo.list({ owner: { kind: "store", storeId: storeB }, afterId: null, limit: 10 })).toHaveLength(1);
  });

  it("the owner can still read, patch and end their own promotion (positive control)", async () => {
    const g = await h.http().get(`/v1/seller/promotions/${aPromo}`).set(bearer(sellerA));
    expect(g.status).toBe(200);
    const p = await h
      .http()
      .patch(`/v1/seller/promotions/${aPromo}`)
      .set(bearer(sellerA))
      .set("If-Match", g.headers.etag as string)
      .send({ status: "paused" });
    expect(p.status).toBe(200);
    const d = await h.http().delete(`/v1/seller/promotions/${aPromo}`).set(bearer(sellerA));
    expect(d.status).toBe(204);
  });
});

describe("internal evaluate", () => {
  const evalBody = () => ({
    user_id: user.userId,
    lines: [{ sku_id: uid(2), store_id: storeA, qty: 1, unit_price: EGP(100n) }],
    at: iso(h.clock.nowMs()),
  });
  const post = (headers: Record<string, string>) => h.http().post("/v1/promotions/evaluate").set(headers).send(evalBody());

  it("no credential, a wrong service token, a user token and a malformed header are all 401", async () => {
    for (const headers of [
      {},
      { Authorization: "Bearer wrong-token-0123456789-abcdefghij" },
      { Authorization: `Bearer ${user.accessToken}` },
      { Authorization: `Bearer ${tokens["admin"] ?? ""}` },
      { Authorization: SERVICE_TOKEN },
      { Authorization: `Basic ${SERVICE_TOKEN}` },
    ]) {
      const r = await post(headers);
      expect(r.status).toBe(401);
      expect(r.body.code).toBe("invalid_credentials");
    }
  });

  it("the service credential is accepted (positive control)", async () => {
    expect((await post({ Authorization: `Bearer ${SERVICE_TOKEN}` })).status).toBe(200);
  });

  it("authenticates before validating, so a stranger with a bad body still gets only 401", async () => {
    const r = await h.http().post("/v1/promotions/evaluate").set({ Authorization: "Bearer nope-0123456789-abcdefghijklm" }).send({});
    expect(r.status).toBe(401);
    const ok = await h.http().post("/v1/promotions/evaluate").set({ Authorization: `Bearer ${SERVICE_TOKEN}` }).send({});
    expect(ok.status).toBe(400);
  });
});
