/**
 * Machine-checked authorization matrix (master prompt A2.10).
 *
 * Every route registered with the Nest router is discovered from controller metadata and MUST have
 * an entry in MATRIX; a route without an entry (or an entry without a route) fails the suite.
 * For each implemented route the suite asserts:
 *   (a) unauthenticated -> 401 (protected routes) and a problem body that carries no extra fields
 *   (b) wrong audience token -> 401, suspended subject -> 403
 *   (c) another user's object -> 404, indistinguishable from a missing object, and no side effect
 *   (d) successful and failed responses contain only allow-listed fields
 * Also cross-checks docs/api/openapi.yaml and docs/security/authz-matrix.md.
 */
import { createHash, createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, ModulesContainer } from "@nestjs/core";
import { buildAccessClaims } from "@outlet/auth-core";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHZ_META, type AuthzMeta } from "../src/platform/decorators";
import { DEV_ATTESTATION_PREFIX, JWKS_KEY_FETCHER, type JwksKeyFetcher } from "../src/modules/auth";
import { AUTHENTICATOR, type Authenticator } from "../src/platform";
import { createHarness, INSTALL_ID, login, type Harness } from "../src/test/harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

// ---- Fixtures ------------------------------------------------------------------------------

const attest = (keyId: string) => ({ "X-App-Attest": `${DEV_ATTESTATION_PREFIX}${keyId}`, "X-Client-Platform": "ios" });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const MISSING_ID = "0192f3a4-5b6c-7d8e-9f01-0000000000ff";

interface TestKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: JsonWebKey;
}
function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: publicKey.export({ format: "jwk" }) };
}
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
function signJwt(key: TestKey, claims: Record<string, unknown>): string {
  const data = `${b64({ alg: "RS256", kid: key.kid, typ: "JWT" })}.${b64(claims)}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(key.privateKey).toString("base64url")}`;
}
class FakeJwks implements JwksKeyFetcher {
  readonly keys = new Map<string, JsonWebKey>();
  async getKey(provider: "apple" | "google", kid: string): Promise<JsonWebKey | null> {
    return this.keys.get(`${provider}:${kid}`) ?? null;
  }
}
const jwks = new FakeJwks();
const appleKey = makeKey("apple-key-1");
const googleKey = makeKey("google-key-1");
jwks.keys.set("apple:apple-key-1", appleKey.jwk);
jwks.keys.set("google:google-key-1", googleKey.jwk);

// ---- Problem body allow-list ---------------------------------------------------------------

/** Keys a problem body may carry. Extensions are listed per code below. */
const PROBLEM_KEYS = ["type", "title", "status", "detail", "code", "request_id", "errors", "blocked_until", "attempts_remaining", "purpose", "current_policy_version"];

// ---- Matrix --------------------------------------------------------------------------------

interface Ctx {
  readonly h: Harness;
  readonly a: Session;
  readonly b: Session;
}
interface Session {
  readonly token: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly refresh: string;
}

interface Entry {
  /** What the route's decorator must say; checked against the discovered metadata. */
  readonly authz: "public" | "self" | "resource";
  /** Issues the request. `token` null means no Authorization header. `owned` selects own vs foreign object. */
  readonly send: (c: Ctx, token: string | null, target?: "own" | "foreign" | "missing") => Test;
  /** Route takes an object id owned by a user. */
  readonly objectId?: boolean;
  /** Allowed top-level keys of a 2xx JSON body (empty for 204). */
  readonly okKeys: readonly string[];
  /** Fully qualified happy-path status for the owner. */
  readonly okStatus: number;
  /** Optional: prepare per-call state and return the send function result (for single-use credentials). */
  readonly prepare?: (c: Ctx, token: string) => Promise<() => Test>;
  /** The happy path revokes the caller's own session, so it runs on a throwaway user. */
  readonly consumesSession?: boolean;
}

const auth = (t: string | null): Record<string, string> => (t === null ? {} : bearer(t));
const ENTRY_ATTEST = attest("key-matrix-device");

const USER_KEYS = ["id", "phone_masked", "email", "locale", "age_band", "limited_capacity", "phone_verified", "status", "created_at"];

const MATRIX: Record<string, Entry> = {
  "GET /v1/health": {
    authz: "public",
    okStatus: 200,
    okKeys: ["status"],
    send: (c) => c.h.http().get("/v1/health"),
  },
  "GET /v1/ready": {
    authz: "public",
    okStatus: 200,
    okKeys: ["status", "checks"],
    send: (c) => c.h.http().get("/v1/ready"),
  },
  "POST /v1/auth/otp/request": {
    authz: "public",
    okStatus: 202,
    okKeys: ["challenge_id", "expires_at", "resend_available_at", "attempts_remaining", "channel"],
    send: (c) => c.h.http().post("/v1/auth/otp/request").set(ENTRY_ATTEST).send({ phone_e164: `+2010099${String(Math.floor(Math.random() * 90000) + 10000)}` }),
  },
  "POST /v1/auth/otp/verify": {
    authz: "public",
    okStatus: 422,
    okKeys: ["type", ...PROBLEM_KEYS],
    send: (c) =>
      c.h
        .http()
        .post("/v1/auth/otp/verify")
        .set(ENTRY_ATTEST)
        .send({ challenge_id: MISSING_ID, code: "000000", device: { platform: "ios", install_id: INSTALL_ID } }),
  },
  "POST /v1/auth/age-gate": {
    authz: "public",
    okStatus: 200,
    okKeys: ["status", "expires_at"],
    send: (c) =>
      c.h
        .http()
        .post("/v1/auth/age-gate")
        .set(attest("key-matrix-agegate"))
        .send({ dob: "1990-05-17", device_id_hash: createHash("sha256").update("device:key-matrix-agegate").digest("hex") }),
  },
  "POST /v1/auth/apple": {
    authz: "public",
    okStatus: 401,
    okKeys: PROBLEM_KEYS,
    send: (c) =>
      c.h
        .http()
        .post("/v1/auth/apple")
        .set(ENTRY_ATTEST)
        .send({ id_token: "x".repeat(40), nonce: "nonce-matrix-1", device: { platform: "ios", install_id: INSTALL_ID } }),
  },
  "POST /v1/auth/google": {
    authz: "public",
    okStatus: 200,
    okKeys: ["access_token", "access_expires_at", "refresh_token", "refresh_expires_at", "second_factor_required", "user"],
    send: (c) => {
      c.h.grantAgeGate("key-matrix-google");
      const nonce = `nonce-matrix-${Math.random().toString(36).slice(2)}`;
      const now = Math.floor(c.h.clock.nowMs() / 1000);
      const sub = `matrix-google-${nonce}`;
      return c.h
        .http()
        .post("/v1/auth/google")
        .set(attest("key-matrix-google"))
        .send({
          id_token: signJwt(googleKey, {
            iss: "https://accounts.google.com",
            aud: "outletnk-ios.apps.googleusercontent.com",
            sub,
            iat: now,
            exp: now + 3000,
            nonce,
            email: "m@example.com",
            email_verified: true,
          }),
          nonce,
          device: { platform: "ios", install_id: INSTALL_ID },
        });
    },
  },
  "POST /v1/auth/passkey/assert/options": {
    authz: "public",
    okStatus: 200,
    okKeys: ["challenge_id", "challenge", "rp_id", "expires_at"],
    send: (c) => c.h.http().post("/v1/auth/passkey/assert/options").send({}),
  },
  "POST /v1/auth/passkey/assert": {
    authz: "public",
    okStatus: 401,
    okKeys: PROBLEM_KEYS,
    send: (c) =>
      c.h
        .http()
        .post("/v1/auth/passkey/assert")
        .set(ENTRY_ATTEST)
        .send({
          challenge_id: MISSING_ID,
          credential: { id: "nope" },
          device: { platform: "ios", install_id: INSTALL_ID },
        }),
  },
  "POST /v1/auth/refresh": {
    authz: "public",
    okStatus: 401,
    okKeys: PROBLEM_KEYS,
    send: (c) => c.h.http().post("/v1/auth/refresh").send({ refresh_token: "r".repeat(32), device_install_id: INSTALL_ID }),
  },
  "POST /v1/auth/passkey/register/options": {
    authz: "self",
    okStatus: 200,
    okKeys: ["challenge_id", "challenge", "rp_id", "expires_at"],
    send: (c, t) => c.h.http().post("/v1/auth/passkey/register/options").set(auth(t)).send({}),
  },
  "POST /v1/auth/passkey/register": {
    authz: "self",
    okStatus: 422,
    okKeys: PROBLEM_KEYS,
    // A well-formed challenge id nobody issued: 422 for the caller, 401 without a token.
    send: (c, t) =>
      c.h.http().post("/v1/auth/passkey/register").set(auth(t)).send({ challenge_id: MISSING_ID, credential: { id: "cred-x" } }),
  },
  "POST /v1/auth/logout": {
    authz: "self",
    okStatus: 204,
    okKeys: [],
    send: (c, t) => c.h.http().post("/v1/auth/logout").set(auth(t)).send({}),
    consumesSession: true,
  },
  "GET /v1/me/sessions": {
    authz: "self",
    okStatus: 200,
    okKeys: ["items", "page"],
    send: (c, t) => c.h.http().get("/v1/me/sessions").set(auth(t)),
  },
  "GET /v1/me/sessions/:sessionId": {
    authz: "resource",
    objectId: true,
    okStatus: 200,
    okKeys: ["id", "platform", "created_at", "last_seen_at", "current"],
    send: (c, t, target = "own") =>
      c.h.http().get(`/v1/me/sessions/${pick(c, target)}`).set(auth(t)),
  },
  "DELETE /v1/me/sessions/:sessionId": {
    authz: "resource",
    objectId: true,
    consumesSession: true,
    okStatus: 204,
    okKeys: [],
    send: (c, t, target = "own") => c.h.http().delete(`/v1/me/sessions/${pick(c, target)}`).set(auth(t)),
  },
  "GET /v1/me/privacy/consents": {
    authz: "self",
    okStatus: 200,
    okKeys: ["consents"],
    send: (c, t) => c.h.http().get("/v1/me/privacy/consents").set(auth(t)),
  },
  "PATCH /v1/me/privacy/consents": {
    authz: "self",
    okStatus: 422,
    okKeys: PROBLEM_KEYS,
    send: (c, t) =>
      c.h
        .http()
        .patch("/v1/me/privacy/consents")
        .set(auth(t))
        .send({ changes: [{ purpose: "analytics", granted: true, policy_version: "1" }, { purpose: "analytics", granted: false, policy_version: "1" }] }),
  },
};

/** Session id to address: the caller's own, a different user's, or one that does not exist. */
function pick(c: Ctx, target: "own" | "foreign" | "missing"): string {
  return target === "own" ? c.a.sessionId : target === "foreign" ? c.b.sessionId : MISSING_ID;
}

// ---- Route discovery -----------------------------------------------------------------------

interface Discovered {
  readonly key: string;
  readonly meta: AuthzMeta | undefined;
}

const VERB: Record<number, string> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.OPTIONS]: "OPTIONS",
  [RequestMethod.HEAD]: "HEAD",
  [RequestMethod.ALL]: "ALL",
};

const asPaths = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [""]);
const joinPath = (...parts: string[]): string => "/" + parts.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");

function discoverRoutes(h: Harness): Discovered[] {
  const out: Discovered[] = [];
  const discovery = new DiscoveryService(h.app.get(ModulesContainer));
  for (const wrapper of discovery.getControllers()) {
    const type = wrapper.metatype;
    if (type === null || typeof type !== "function") continue;
    const proto = type.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const fn = proto[name];
      if (typeof fn !== "function") continue;
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, fn);
      if (typeof method !== "number") continue;
      const meta = (Reflect.getMetadata(AUTHZ_META, fn) ?? Reflect.getMetadata(AUTHZ_META, type)) as AuthzMeta | undefined;
      for (const cp of asPaths(Reflect.getMetadata(PATH_METADATA, type))) {
        for (const mp of asPaths(Reflect.getMetadata(PATH_METADATA, fn))) {
          out.push({ key: `${VERB[method] ?? String(method)} ${joinPath("v1", cp, mp)}`, meta });
        }
      }
    }
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

// ---- OpenAPI -------------------------------------------------------------------------------

function openApiOperations(): string[] {
  const text = readFileSync(resolve(REPO, "docs/api/openapi.yaml"), "utf8");
  const ops: string[] = [];
  let path = "";
  let inPaths = false;
  for (const line of text.split("\n")) {
    if (/^paths:\s*$/.test(line)) inPaths = true;
    else if (/^\S/.test(line)) inPaths = false;
    if (!inPaths) continue;
    const p = /^ {2}(\/\S*):\s*$/.exec(line);
    if (p?.[1] !== undefined) path = p[1];
    const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (m?.[1] !== undefined) ops.push(`${m[1].toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`);
  }
  return ops;
}

// ---- Suite ---------------------------------------------------------------------------------

describe("authorization matrix", () => {
  let h: Harness;
  let c: Ctx;
  let routes: Discovered[];

  beforeAll(async () => {
    h = await createHarness({ customise: (b) => b.overrideProvider(JWKS_KEY_FETCHER).useValue(jwks) });
    h.grantAgeGate("key-matrix-device");
    const mk = async (phone: string): Promise<Session> => {
      const l = await login(h, phone);
      return { token: l.accessToken, userId: l.userId, sessionId: l.sessionId, refresh: l.refreshToken };
    };
    c = { h, a: await mk("+201007770001"), b: await mk("+201007770002") };
    routes = discoverRoutes(h);
  });
  afterAll(async () => h.close());

  describe("route discovery", () => {
    it("finds the implemented routes", () => {
      expect(routes.length).toBeGreaterThan(0);
      expect(new Set(routes.map((r) => r.key)).size).toBe(routes.length);
    });

    it("every discovered route has a matrix entry", () => {
      const missing = routes.map((r) => r.key).filter((k) => MATRIX[k] === undefined);
      expect(missing, `routes without a matrix entry: ${missing.join(", ")}`).toEqual([]);
    });

    it("every matrix entry is a real route (no stale rows)", () => {
      const found = new Set(routes.map((r) => r.key));
      const stale = Object.keys(MATRIX).filter((k) => !found.has(k));
      expect(stale, `matrix rows without a route: ${stale.join(", ")}`).toEqual([]);
    });

    it("every route declares an authorization mode and it matches the matrix", () => {
      for (const r of routes) {
        expect(r.meta, `${r.key} has no @Public/@AuthenticatedSelf/@Authorize`).toBeDefined();
        expect(r.meta?.kind, r.key).toBe(MATRIX[r.key]?.authz);
      }
    });

    it("every implemented route is described by docs/api/openapi.yaml", () => {
      const ops = new Set(openApiOperations());
      const norm = (k: string): string => k.replace(/^(\w+) \/v1\/(health|ready)$/, "$1 /v1/$2");
      const notInSpec = routes.map((r) => norm(r.key)).filter((k) => !ops.has(k));
      // Health probes are operational endpoints, intentionally outside the product contract.
      expect(notInSpec.filter((k) => !/\/v1\/(health|ready)$/.test(k))).toEqual([]);
    });

    it("docs/security/authz-matrix.md lists every implemented route", () => {
      const doc = readFileSync(resolve(REPO, "docs/security/authz-matrix.md"), "utf8");
      const missing = routes.map((r) => r.key).filter((k) => !doc.includes(`\`${k}\``));
      expect(missing).toEqual([]);
    });
  });

  const entries = Object.entries(MATRIX);
  const protectedEntries = entries.filter(([, e]) => e.authz !== "public");
  const publicEntries = entries.filter(([, e]) => e.authz === "public");

  describe("(a) unauthenticated", () => {
    it.each(protectedEntries.map(([k]) => k))("%s -> 401 with a clean problem body", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      const r = await e.send(c, null);
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toContain("Bearer");
      expect(r.body.type).toBe("/problems/unauthenticated");
      expect(Object.keys(r.body).filter((k) => !PROBLEM_KEYS.includes(k))).toEqual([]);
    });

    it.each(protectedEntries.map(([k]) => k))("%s -> 401 for a malformed or unknown bearer token", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      for (const t of ["not-a-token", "dev_" + "0".repeat(64)]) {
        const r = await e.send(c, t);
        expect(r.status, `${key} with ${t.slice(0, 8)}`).toBe(401);
      }
    });

    it.each(publicEntries.map(([k]) => k))("%s is reachable without credentials (declared @Public)", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      const r = await e.send(c, null);
      expect(r.status, `${key} -> ${JSON.stringify(r.body)}`).toBe(e.okStatus);
    });
  });

  describe("(b) wrong audience / not active", () => {
    it.each(protectedEntries.map(([k]) => k))("%s -> 401 for a seller_api token, 403 for a suspended subject", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
      const issuer = authn as unknown as { issue(claims: unknown): Promise<string> };
      const claims = buildAccessClaims({
        issuer: h.config.tokenIssuer,
        userId: c.a.userId,
        audience: "seller_api",
        sessionId: c.a.sessionId,
        jti: `jti-matrix-${key}`,
        amr: ["otp_sms"],
        nowMs: h.clock.nowMs(),
      });
      const sellerToken = await issuer.issue(claims);
      const wrongAud = await e.send(c, sellerToken);
      expect(wrongAud.status).toBe(401);

      const original = authn.authenticate.bind(authn);
      authn.authenticate = async (t, n) => {
        const p = await original(t, n);
        return p === null ? null : { ...p, actor: { ...p.actor, status: "suspended" } };
      };
      try {
        const suspended = await e.send(c, c.a.token);
        expect(suspended.status).toBe(403);
        expect(suspended.body.code).toBe("account_not_active");
      } finally {
        authn.authenticate = original;
      }
    });
  });

  describe("(c) another user's object", () => {
    const objectEntries = entries.filter(([, e]) => e.objectId === true);
    it("the matrix has object-id routes to test", () => {
      expect(objectEntries.length).toBeGreaterThan(0);
    });

    it.each(objectEntries.map(([k]) => k))("%s -> 404 for a foreign object, same body as a missing one", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      const foreign = await e.send(c, c.a.token, "foreign");
      const missing = await e.send(c, c.a.token, "missing");
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      const strip = (b: Record<string, unknown>) => {
        const { request_id: _r, ...rest } = b;
        return rest;
      };
      expect(strip(foreign.body)).toEqual(strip(missing.body));
    });

    it("a foreign DELETE has no side effect: the owner's session still works", async () => {
      const del = await c.h.http().delete(`/v1/me/sessions/${c.b.sessionId}`).set(bearer(c.a.token));
      expect(del.status).toBe(404);
      const still = await c.h.http().get("/v1/me/sessions").set(bearer(c.b.token));
      expect(still.status).toBe(200);
    });

    it("sessions list never contains another user's sessions", async () => {
      const r = await c.h.http().get("/v1/me/sessions").set(bearer(c.a.token));
      const ids = (r.body.items as { id: string }[]).map((s) => s.id);
      expect(ids).toContain(c.a.sessionId);
      expect(ids).not.toContain(c.b.sessionId);
    });

    it("a passkey registration challenge issued to another user is a 404 and stays usable by its owner", async () => {
      const opts = await h.http().post("/v1/auth/passkey/register/options").set(bearer(c.b.token)).send({});
      expect(opts.status).toBe(200);
      const credential = (id: string) => ({ id, credentialId: id, publicKey: `pk-${id}`, signCount: 0, origin: "https://outletnk.invalid", challenge: opts.body.challenge });
      const stolen = await h
        .http()
        .post("/v1/auth/passkey/register")
        .set(bearer(c.a.token))
        .send({ challenge_id: opts.body.challenge_id, credential: credential("cred-stolen-1") });
      expect(stolen.status).toBe(404);
      const own = await h
        .http()
        .post("/v1/auth/passkey/register")
        .set(bearer(c.b.token))
        .send({ challenge_id: opts.body.challenge_id, credential: credential("cred-owner-matrix-1") });
      expect(own.status).toBe(204);
    });

    it("an owner-only read by a stranger token is refused after the owner signs out (revoked object is gone)", async () => {
      const l = await login(h, "+201007770003");
      const out = await h.http().post("/v1/auth/logout").set(bearer(l.accessToken));
      expect(out.status).toBe(204);
      const r = await h.http().get(`/v1/me/sessions/${l.sessionId}`).set(bearer(c.a.token));
      expect(r.status).toBe(404);
    });
  });

  describe("(d) response bodies carry only allow-listed fields", () => {
    const strictKeys = (body: unknown, allowed: readonly string[], where: string): void => {
      if (body === null || typeof body !== "object" || Array.isArray(body)) return;
      const extra = Object.keys(body).filter((k) => !allowed.includes(k));
      expect(extra, `${where} leaks fields ${extra.join(", ")}`).toEqual([]);
    };

    it.each(entries.map(([k]) => k))("%s", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      let ctx = c;
      if (e.consumesSession === true) {
        const l = await login(h, `+2010077${String(Math.floor(Math.random() * 90000) + 10000)}`);
        ctx = { ...c, a: { token: l.accessToken, userId: l.userId, sessionId: l.sessionId, refresh: l.refreshToken } };
      }
      const token = e.authz === "public" ? null : ctx.a.token;
      const r = await e.send(ctx, token);
      expect(r.status, `${key} -> ${JSON.stringify(r.body)}`).toBe(e.okStatus);
      if (e.okStatus === 204) {
        expect(r.text).toBe("");
        return;
      }
      strictKeys(r.body, e.okKeys, key);
      const text = JSON.stringify(r.body);
      for (const forbidden of ["password", "refresh_hash", "otp_hash", "pepper", "phone_e164", "dob", "device_id_hash", "stack"]) {
        expect(text.includes(`"${forbidden}"`), `${key} exposes ${forbidden}`).toBe(false);
      }
      if (key === "POST /v1/auth/google") {
        strictKeys((r.body as { user: unknown }).user, USER_KEYS, `${key} user`);
      }
      if (key === "GET /v1/me/sessions") {
        for (const s of (r.body as { items: unknown[] }).items) {
          strictKeys(s, ["id", "platform", "created_at", "last_seen_at", "current"], `${key} item`);
        }
      }
    });

    it("validation errors do not echo the submitted values", async () => {
      const secret = "SENSITIVE-VALUE-12345";
      const r = await h.http().patch("/v1/me/privacy/consents").set(bearer(c.a.token)).send({ changes: [{ purpose: secret, granted: "yes" }] });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toContain(secret);
      strictKeys(r.body, PROBLEM_KEYS, "validation problem");
    });

    it("an unknown route is a clean 404 problem, not a framework error page", async () => {
      const r = await h.http().get("/v1/definitely/not/here").set(bearer(c.a.token));
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/Cannot GET|stack|node_modules/);
    });
  });
});
