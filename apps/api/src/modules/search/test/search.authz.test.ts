/**
 * Negative authorization matrix for the search module: every route is exercised for
 * unauthenticated (401), wrong audience (401), suspended subject (403) and another user's
 * saved search (404, byte-identical to a missing one, with no side effect).
 */
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { buildAccessClaims } from "@outlet/auth-core";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHZ_META, RATE_LIMIT_META, type AuthzMeta } from "../../../platform/decorators";
import { AUTHENTICATOR, type Authenticator } from "../../../platform";
import { login, type LoggedIn } from "../../../test/harness";
import { SavedSearchesController, SearchController } from "../adapters/search.controller";
import { createSearchHarness, uid, type SearchHarness } from "./search-harness";

let h: SearchHarness;
let a: LoggedIn;
let b: LoggedIn;
let aSaved: string;
let bSaved: string;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const auth = (t: string | null): Record<string, string> => (t === null ? {} : bearer(t));

interface Route {
  readonly key: string;
  readonly objectId: boolean;
  readonly send: (token: string | null, id: string | null) => Test;
}

const ROUTES: readonly Route[] = [
  { key: "GET /v1/search", objectId: false, send: (t) => h.http().get("/v1/search?q=dress").set(auth(t)) },
  { key: "GET /v1/search/suggestions", objectId: false, send: (t) => h.http().get("/v1/search/suggestions?q=dr").set(auth(t)) },
  { key: "POST /v1/search/parse", objectId: false, send: (t) => h.http().post("/v1/search/parse").set(auth(t)).send({ text: "dress" }) },
  { key: "GET /v1/me/saved-searches", objectId: false, send: (t) => h.http().get("/v1/me/saved-searches").set(auth(t)) },
  {
    key: "POST /v1/me/saved-searches",
    objectId: false,
    send: (t) => h.http().post("/v1/me/saved-searches").set(auth(t)).send({ name: "n", filter: {} }),
  },
  {
    key: "GET /v1/me/saved-searches/:savedSearchId",
    objectId: true,
    send: (t, id) => h.http().get(`/v1/me/saved-searches/${id ?? uid(4)}`).set(auth(t)),
  },
  {
    key: "PATCH /v1/me/saved-searches/:savedSearchId",
    objectId: true,
    send: (t, id) =>
      h.http().patch(`/v1/me/saved-searches/${id ?? uid(4)}`).set(auth(t)).set("If-Match", '"x"').send({ name: "hijack" }),
  },
  {
    key: "DELETE /v1/me/saved-searches/:savedSearchId",
    objectId: true,
    send: (t, id) => h.http().delete(`/v1/me/saved-searches/${id ?? uid(4)}`).set(auth(t)),
  },
];

const strip = (body: Record<string, unknown>) => {
  const { request_id: _r, ...rest } = body;
  return rest;
};

beforeAll(async () => {
  h = await createSearchHarness();
  a = await login(h, "+201005599201");
  b = await login(h, "+201005599202");
  const mk = async (u: LoggedIn) =>
    (await h.http().post("/v1/me/saved-searches").set(bearer(u.accessToken)).send({ name: "mine", filter: {} })).body.id as string;
  aSaved = await mk(a);
  bSaved = await mk(b);
}, 30_000);
afterAll(async () => {
  await h.close();
});

describe("route coverage", () => {
  it("every controller route is in the matrix, declares authorization and a rate limit", () => {
    const found: string[] = [];
    const METHODS: Record<number, string> = {
      [RequestMethod.GET]: "GET",
      [RequestMethod.POST]: "POST",
      [RequestMethod.PATCH]: "PATCH",
      [RequestMethod.DELETE]: "DELETE",
    };
    const scan = (ctor: { prototype: object }, base: string) => {
      const proto = ctor.prototype as unknown as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(ctor.prototype)) {
        const fn = proto[name];
        if (typeof fn !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
        if (method === undefined) continue;
        const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
        const meta = Reflect.getMetadata(AUTHZ_META, fn) as AuthzMeta | undefined;
        expect(meta, `${name} must declare authorization`).toBeDefined();
        expect(meta?.kind).not.toBe("public");
        expect(Reflect.getMetadata(RATE_LIMIT_META, fn), `${name} must declare a rate limit`).toBeDefined();
        const suffix = path === "/" || path === "" ? "" : `/${path}`;
        found.push(`${METHODS[method]} ${base}${suffix}`);
      }
    };
    scan(SearchController, "/v1/search");
    scan(SavedSearchesController, "/v1/me/saved-searches");
    expect(found.sort()).toEqual(ROUTES.map((r) => r.key).sort());
  });
});

describe.each(ROUTES.map((r) => [r.key, r] as const))("%s", (_key, route) => {
  it("unauthenticated is 401 with no extra problem members", async () => {
    const r = await route.send(null, bSaved);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("unauthenticated");
    expect(Object.keys(r.body).sort()).toEqual(["code", "request_id", "status", "title", "type"]);
  });

  it("a malformed bearer token is 401", async () => {
    expect((await route.send("not-a-real-token-0000000000", bSaved)).status).toBe(401);
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
        jti: `jti-search-${route.key}`,
        amr: ["otp_sms"],
        nowMs: h.clock.nowMs(),
      }),
    );
    expect((await route.send(sellerToken, aSaved)).status).toBe(401);

    const original = authn.authenticate.bind(authn);
    authn.authenticate = async (t, n) => {
      const p = await original(t, n);
      return p === null ? null : { ...p, actor: { ...p.actor, status: "suspended" } };
    };
    try {
      const r = await route.send(a.accessToken, aSaved);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("account_not_active");
    } finally {
      authn.authenticate = original;
    }
  });
});

describe("another user's saved search", () => {
  it.each(ROUTES.filter((r) => r.objectId).map((r) => [r.key, r] as const))(
    "%s is 404, identical to a missing and a malformed id, with no side effect",
    async (_k, route) => {
      const foreign = await route.send(a.accessToken, bSaved);
      const missing = await route.send(a.accessToken, uid(4));
      const malformed = await route.send(a.accessToken, "not-a-uuid");
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(malformed.status).toBe(404);
      expect(strip(foreign.body)).toEqual(strip(missing.body));
      const still = await h.http().get(`/v1/me/saved-searches/${bSaved}`).set(bearer(b.accessToken));
      expect(still.status).toBe(200);
      expect(still.body.name).toBe("mine");
    },
  );

  it("never lists another user's rows", async () => {
    const r = await h.http().get("/v1/me/saved-searches").set(bearer(a.accessToken));
    expect(JSON.stringify(r.body)).not.toContain(bSaved);
    expect(JSON.stringify(r.body)).not.toContain(b.userId);
  });

  it("the owner can still delete their own (positive control)", async () => {
    const r = await h.http().delete(`/v1/me/saved-searches/${aSaved}`).set(bearer(a.accessToken));
    expect(r.status).toBe(204);
  });
});
