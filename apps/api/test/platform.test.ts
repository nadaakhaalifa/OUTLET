import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RateLimiterPort } from "../src/platform/rate-limit/port.js";
import { DEVICE, T0, bearer, createTestApp, idemKey, v7At } from "./harness.js";
import type { TestApp } from "./harness.js";
import { ProbeController, probeState } from "./probe.controller.js";

const body = (r: { body: string }): Record<string, unknown> => JSON.parse(r.body) as Record<string, unknown>;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ extraControllers: [ProbeController] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  probeState.calls = 0;
  probeState.slowMs = 0;
});

describe("bootstrap: request id, market, security headers", () => {
  it("sets a request id (UUIDv7) and echoes a well-formed incoming one, never a malformed one", async () => {
    const a = await t.inject({ method: "GET", url: "/v1/health/live" });
    expect(a.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const b = await t.inject({ method: "GET", url: "/v1/health/live", headers: { "x-request-id": "edge-req-12345678" } });
    expect(b.headers["x-request-id"]).toBe("edge-req-12345678");
    const c = await t.inject({ method: "GET", url: "/v1/health/live", headers: { "x-request-id": "bad id with spaces" } });
    expect(c.headers["x-request-id"]).not.toBe("bad id with spaces");
  });

  it("sends helmet-style headers on success and on errors", async () => {
    for (const url of ["/v1/health/live", "/v1/eg/nothing-here"]) {
      const r = await t.inject({ method: "GET", url });
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(r.headers["strict-transport-security"]).toContain("max-age=");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["x-powered-by"]).toBeUndefined();
    }
  });

  it("binds the market from the path; unknown market → 404; X-Market must agree with the path", async () => {
    const tok = await t.mint();
    const ok = await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: bearer(tok) });
    expect(body(ok)).toMatchObject({ market_id: "EG", db: "user" });
    const unknown = await t.inject({ method: "GET", url: "/v1/zz/probe/me", headers: bearer(tok) });
    expect(unknown.statusCode).toBe(404);
    expect(body(unknown)).toMatchObject({ code: "unknown-market", type: "urn:outlex:problem:unknown-market" });
    const mismatch = await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: { ...bearer(tok), "x-market": "sa" } });
    expect(mismatch.statusCode).toBe(400);
    const agree = await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: { ...bearer(tok), "x-market": "EG" } });
    expect(agree.statusCode).toBe(200);
    const headerOnly = await t.inject({ method: "GET", url: "/v1/health/live", headers: { "x-market": "eg" } });
    expect(headerOnly.statusCode).toBe(200);
  });

  it("logs with requestId and marketId and never the query string", async () => {
    t.logs.length = 0;
    await t.inject({ method: "GET", url: `/v1/eg/stores/${t.seed.slugA}/products?limit=3`, headers: { "x-device-id": DEVICE } });
    const line = t.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "request");
    expect(line).toMatchObject({ marketId: "EG", route: "/v1/:market/stores/:store_slug/products", status: 200 });
    expect(JSON.stringify(t.logs)).not.toContain("limit=3");
  });
});

describe("Problem+JSON (RFC 9457)", () => {
  it("unknown errors are a bare 500: no message, no stack, request_id present", async () => {
    const r = await t.inject({ method: "GET", url: "/v1/eg/probe/boom?kind=unknown", headers: { "x-device-id": DEVICE } });
    expect(r.statusCode).toBe(500);
    expect(r.headers["content-type"]).toContain("application/problem+json");
    const p = body(r);
    expect(p).toMatchObject({ type: "urn:outlex:problem:internal-error", title: "Internal server error", status: 500, code: "internal-error" });
    expect(p.request_id).toBe(r.headers["x-request-id"]);
    expect(r.body).not.toContain("secret");
    expect(r.body).not.toContain("at ");
    expect(JSON.stringify(t.logs)).not.toContain("201001234567");
  });

  it.each([
    ["catalog-not_found", 404, "not-found"],
    ["catalog-forbidden", 403, "forbidden"],
    ["catalog-conflict", 409, "version-conflict"],
    ["catalog-invalid_transition", 409, "invalid-transition"],
    ["catalog-validation", 422, "validation-rule"],
    ["catalog-activation_blocked", 422, "activation-blocked"],
    ["zod", 400, "validation-failed"],
    ["bad-response", 500, "response-contract-violation"],
  ])("maps %s → %i %s", async (kind, status, code) => {
    const r = await t.inject({ method: "GET", url: `/v1/eg/probe/boom?kind=${kind}`, headers: { "x-device-id": DEVICE } });
    expect(r.statusCode).toBe(status);
    expect(body(r).code).toBe(code);
    expect(r.body).not.toContain("01001234567");
  });

  it("strict DTOs: unknown query fields, bad params and bad bodies are 400 with JSON pointers", async () => {
    const q = await t.inject({ method: "GET", url: `/v1/eg/stores/${t.seed.slugA}/products?offset=10`, headers: { "x-device-id": DEVICE } });
    expect(q.statusCode).toBe(400);
    expect(body(q).errors).toEqual([{ path: "/query", code: "unrecognized_keys" }]);
    const p = await t.inject({ method: "GET", url: "/v1/eg/stores/AB/products", headers: { "x-device-id": DEVICE } });
    expect(body(p).errors).toEqual([{ path: "/params/store_slug", code: "invalid_format" }]);
    const b = await t.inject({ method: "POST", url: "/v1/eg/probe/quote", headers: { "x-device-id": DEVICE }, payload: { n: "x", extra: 1 } });
    expect(b.statusCode).toBe(400);
    expect((body(b).errors as { path: string }[]).map((e) => e.path).sort()).toEqual(["/body", "/body/n"]);
  });

  it("malformed JSON → 400, wrong media type → 415, body over 1 MiB → 413", async () => {
    const bad = await t.inject({ method: "POST", url: "/v1/eg/probe/quote", headers: { "x-device-id": DEVICE, "content-type": "application/json" }, payload: "{nope" });
    expect([bad.statusCode, body(bad).code]).toEqual([400, "malformed-request"]);
    const xml = await t.inject({ method: "POST", url: "/v1/eg/probe/quote", headers: { "x-device-id": DEVICE, "content-type": "application/xml" }, payload: "<n/>" });
    expect([xml.statusCode, body(xml).code]).toEqual([415, "unsupported-media-type"]);
    const big = await t.inject({ method: "POST", url: "/v1/eg/probe/echo", headers: { "x-device-id": DEVICE }, payload: { text: "x".repeat(1024 * 1024 + 10) } });
    expect([big.statusCode, body(big).code]).toEqual([413, "payload-too-large"]);
    const fine = await t.inject({ method: "POST", url: "/v1/eg/probe/echo", headers: { "x-device-id": DEVICE }, payload: { text: "x".repeat(900 * 1024) } });
    expect(fine.statusCode).toBe(200);
  });

  it("unknown route → 404 route-not-found; wrong method → 404", async () => {
    const r = await t.inject({ method: "DELETE", url: "/v1/health/live" });
    expect([r.statusCode, body(r).code]).toEqual([404, "route-not-found"]);
  });
});

describe("AccessTokenGuard + PolicyGuard", () => {
  it("authenticated user route: 200 with a valid token, user db context", async () => {
    const r = await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: bearer(await t.mint({ userId: "0f6f1d2e-3c4b-4a59-8e7f-000000000001" })) });
    expect(body(r)).toEqual({ user_id: "0f6f1d2e-3c4b-4a59-8e7f-000000000001", db: "user", market_id: "EG" });
    expect(r.headers["cache-control"]).toBe("private, no-store");
  });

  it.each([
    ["no header", {}, "unauthenticated"],
    ["basic auth", { authorization: "Basic dXNlcjpwYXNz" }, "unauthenticated"],
    ["not a jwt", { authorization: "Bearer abc" }, "invalid-token"],
  ])("401 for %s, with WWW-Authenticate", async (_n, headers, code) => {
    const r = await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers });
    expect(r.statusCode).toBe(401);
    expect(r.headers["www-authenticate"]).toContain("Bearer");
    expect(body(r).code).toBe(code === "unauthenticated" && "authorization" in headers ? "invalid-token" : code);
  });

  it("rejects wrong issuer, wrong audience, expired and alg=none tokens", async () => {
    for (const tok of [await t.mint({ issuer: "https://evil.test" }), await t.mint({ audience: "outlet:zz" }), await t.mint({ expiresInS: -1 })]) {
      expect((await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: bearer(tok) })).statusCode).toBe(401);
    }
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "test-es256-1" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: DEVICE, sid: DEVICE, amr: ["otp"], exp: T0 / 1000 + 600, aud: "outlet:eg", iss: "https://auth.outlex.test" })).toString("base64url")}.x`;
    expect((await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: bearer(none) })).statusCode).toBe(401);
  });

  it("reason code: required for REQUIRES_REASON_CODE actions (403 without, recorded with)", async () => {
    const tok = await t.mint();
    const without = await t.inject({ method: "GET", url: "/v1/eg/probe/export", headers: bearer(tok) });
    expect([without.statusCode, body(without).code]).toEqual([403, "reason-code-required"]);
    const malformed = await t.inject({ method: "GET", url: "/v1/eg/probe/export", headers: { ...bearer(tok), "x-reason-code": "DROP TABLE" } });
    expect(malformed.statusCode).toBe(403);
    const ok = await t.inject({ method: "GET", url: "/v1/eg/probe/export", headers: { ...bearer(tok), "x-reason-code": "dsar_request:T-1234" } });
    expect(body(ok)).toEqual({ reason: "dsar_request:T-1234" });
  });

  it("store tenant: principal scoped to the X-Store-Id store and its roles; store db context", async () => {
    const userId = "0f6f1d2e-3c4b-4a59-8e7f-000000000002";
    t.memberships.grant("EG", userId, t.seed.storeA, ["owner"]);
    t.memberships.grant("EG", userId, t.seed.storeB, ["support"]);
    const tok = await t.mint({ userId, amr: ["otp", "passkey"] });
    const a = await t.inject({ method: "GET", url: "/v1/eg/probe/store", headers: { ...bearer(tok), "x-store-id": t.seed.storeA } });
    expect(body(a)).toEqual({ store_id: t.seed.storeA, db: "store", roles: ["owner"] });
    // support in B may not read listings: owner rights in A must not leak into B.
    const b = await t.inject({ method: "GET", url: "/v1/eg/probe/store", headers: { ...bearer(tok), "x-store-id": t.seed.storeB } });
    expect([b.statusCode, body(b).code]).toEqual([403, "forbidden"]);
    const upper = await t.inject({ method: "GET", url: "/v1/eg/probe/store", headers: { ...bearer(tok), "x-store-id": t.seed.storeA.toUpperCase() } });
    expect(body(upper).store_id).toBe(t.seed.storeA);
    const bad = await t.inject({ method: "GET", url: "/v1/eg/probe/store", headers: { ...bearer(tok), "x-store-id": "store-a" } });
    expect([bad.statusCode, body(bad).code]).toEqual([400, "store-scope-required"]);
  });
});

describe("IdempotencyInterceptor", () => {
  const post = async (key: string | undefined, payload: unknown, tok: string): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> =>
    t.inject({ method: "POST", url: "/v1/eg/probe/cart", headers: { ...bearer(tok), ...(key === undefined ? {} : { "idempotency-key": key }) }, payload: payload as Record<string, unknown> });

  it("fresh → stored; replay → same response, handler not re-run, Idempotent-Replayed: true", async () => {
    const tok = await t.mint();
    const key = idemKey(t);
    const a = await post(key, { n: 1 }, tok);
    expect([a.statusCode, body(a)]).toEqual([201, { n: 1, calls: 1 }]);
    const b = await post(key, { n: 1 }, tok);
    expect([b.statusCode, body(b)]).toEqual([201, { n: 1, calls: 1 }]);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(probeState.calls).toBe(1);
  });

  it("same key + different body → 422; the key is scoped per user", async () => {
    const tok = await t.mint();
    const key = idemKey(t);
    await post(key, { n: 1 }, tok);
    const r = await post(key, { n: 2 }, tok);
    expect([r.statusCode, body(r).code]).toEqual([422, "idempotency-key-reuse"]);
    const other = await post(key, { n: 2 }, await t.mint());
    expect(other.statusCode).toBe(201);
  });

  it.each([
    ["missing", undefined],
    ["not a uuid", "abc"],
    ["uuid v4", "0f6f1d2e-3c4b-4a59-8e7f-1a2b3c4d5e6f"],
    ["v7 older than 24 h", v7At(T0 - 24 * 3600 * 1000 - 1000)],
    ["v7 more than 24 h ahead", v7At(T0 + 24 * 3600 * 1000 + 1000)],
  ])("Idempotency-Key %s → 400", async (_n, key) => {
    const r = await post(key, { n: 1 }, await t.mint());
    expect([r.statusCode, body(r).code]).toEqual([400, "idempotency-key-invalid"]);
    expect(probeState.calls).toBe(0);
  });

  it("a key inside ±24 h is accepted", async () => {
    const r = await post(idemKey(t, -23 * 3600 * 1000), { n: 1 }, await t.mint());
    expect(r.statusCode).toBe(201);
  });

  it("a failed handler abandons the key: the retry runs again", async () => {
    const tok = await t.mint();
    const key = idemKey(t);
    expect((await post(key, { n: -1 }, tok)).statusCode).toBe(409);
    expect((await post(key, { n: -1 }, tok)).statusCode).toBe(409);
    expect(probeState.calls).toBe(2);
  });

  it("guards run before replay: an expired token cannot replay a stored response", async () => {
    const userId = "0f6f1d2e-3c4b-4a59-8e7f-000000000003";
    const key = idemKey(t);
    await post(key, { n: 5 }, await t.mint({ userId }));
    const r = await post(key, { n: 5 }, await t.mint({ userId, expiresInS: -1 }));
    expect(r.statusCode).toBe(401);
  });

  it("anonymous mutations use X-Device-Id as the actor (required)", async () => {
    const key = idemKey(t);
    const noDevice = await t.inject({ method: "POST", url: "/v1/eg/probe/public-write", headers: { "idempotency-key": key }, payload: { n: 1 } });
    expect(noDevice.statusCode).toBe(400);
    const a = await t.inject({ method: "POST", url: "/v1/eg/probe/public-write", headers: { "idempotency-key": key, "x-device-id": DEVICE }, payload: { n: 1 } });
    const b = await t.inject({ method: "POST", url: "/v1/eg/probe/public-write", headers: { "idempotency-key": key, "x-device-id": DEVICE }, payload: { n: 1 } });
    expect([a.statusCode, b.headers["idempotent-replayed"], probeState.calls]).toEqual([201, "true", 1]);
  });

  it("@NoIdempotency pure POSTs need no key", async () => {
    const r = await t.inject({ method: "POST", url: "/v1/eg/probe/quote", headers: { "x-device-id": DEVICE }, payload: { n: 3 } });
    expect([r.statusCode, body(r)]).toEqual([200, { n: 3 }]);
  });
});

describe("RateLimitGuard", () => {
  it("GCRA per user: burst of `limit`, then 429 with Retry-After and retry_after_s", async () => {
    const tok = await t.mint();
    expect((await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: bearer(tok) })).statusCode).toBe(200);
    expect((await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: bearer(tok) })).statusCode).toBe(200);
    const r = await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: bearer(tok) });
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBe("30");
    expect(body(r)).toMatchObject({ code: "rate-limited", retry_after_s: 30 });
    // another user is unaffected; after the emission interval one more request is allowed
    expect((await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: bearer(await t.mint()) })).statusCode).toBe(200);
    t.clock.now += 30_000;
    expect((await t.inject({ method: "GET", url: "/v1/eg/probe/me", headers: bearer(tok) })).statusCode).toBe(200);
    t.clock.now -= 30_000;
  });

  it("device-keyed budgets require X-Device-Id; IP is multiplied for CGNAT and never blocks alone", async () => {
    const no = await t.inject({ method: "GET", url: "/v1/eg/probe/killable" });
    expect([no.statusCode, body(no).code]).toEqual([400, "device-id-required"]);
    const d1 = "11111111-1111-4111-8111-111111111111";
    expect((await t.inject({ method: "GET", url: "/v1/eg/probe/killable", headers: { "x-device-id": d1 } })).statusCode).toBe(200);
    expect((await t.inject({ method: "GET", url: "/v1/eg/probe/killable", headers: { "x-device-id": d1 } })).statusCode).toBe(200);
    expect((await t.inject({ method: "GET", url: "/v1/eg/probe/killable", headers: { "x-device-id": d1 } })).statusCode).toBe(429);
    // same IP (inject uses 127.0.0.1), other devices: the IP bucket is 10x, so 9 more devices pass
    for (let i = 0; i < 9; i++) {
      const d = `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`;
      expect((await t.inject({ method: "GET", url: "/v1/eg/probe/killable", headers: { "x-device-id": d } })).statusCode).toBe(200);
    }
  });

  it("limiter outage: fail-closed budgets answer 503, fail-open budgets pass", async () => {
    const broken: RateLimiterPort = { hit: () => Promise.reject(new Error("redis down")) };
    const b = await createTestApp({ extraControllers: [ProbeController], rateLimiter: broken });
    try {
      const closed = await b.inject({ method: "GET", url: "/v1/eg/probe/me", headers: bearer(await b.mint()) });
      expect([closed.statusCode, body(closed).code]).toEqual([503, "rate-limiter-unavailable"]);
      const open = await b.inject({ method: "GET", url: "/v1/eg/probe/killable", headers: { "x-device-id": DEVICE } });
      expect(open.statusCode).toBe(200);
    } finally {
      await b.close();
    }
  });

  it("store-keyed budgets run after membership: a forged X-Store-Id cannot consume another store's budget", async () => {
    const attacker = await t.mint({ amr: ["otp", "passkey"] });
    for (let i = 0; i < 5; i++) {
      const r = await t.inject({ method: "GET", url: "/v1/eg/probe/store", headers: { ...bearer(attacker), "x-store-id": t.seed.storeB } });
      expect(r.statusCode).toBe(404);
    }
    const member = await t.seller(t.seed.storeB, ["owner"]);
    expect((await t.inject({ method: "GET", url: "/v1/eg/probe/store", headers: { ...bearer(member.token), "x-store-id": t.seed.storeB } })).statusCode).toBe(200);
  });
});

describe("KillSwitchGuard, timeout, deprecation, ETag, pagination", () => {
  it("a killed feature answers 503 feature-disabled", async () => {
    const d = "33333333-3333-4333-8333-333333333333";
    await t.flags.put({ key: "drops.enabled", marketId: null, enabled: false, updatedBy: "test", updatedAt: new Date(T0) });
    t.clock.now += 61_000; // past the flag cache's stale window (60 s)
    const r = await t.inject({ method: "GET", url: "/v1/eg/probe/killable", headers: { "x-device-id": d } });
    expect([r.statusCode, body(r).code]).toEqual([503, "feature-disabled"]);
    await t.flags.put({ key: "drops.enabled", marketId: null, enabled: true, updatedBy: "test", updatedAt: new Date(T0) });
    t.clock.now += 61_000;
    expect((await t.inject({ method: "GET", url: "/v1/eg/probe/killable", headers: { "x-device-id": d } })).statusCode).toBe(200);
    t.clock.now -= 122_000;
  });

  it("a kill-switch store failure fails closed", async () => {
    const b = await createTestApp({ extraControllers: [ProbeController], killSwitches: { isKilled: () => Promise.reject(new Error("down")) } });
    try {
      expect((await b.inject({ method: "GET", url: "/v1/eg/probe/killable", headers: { "x-device-id": DEVICE } })).statusCode).toBe(503);
    } finally {
      await b.close();
    }
  });

  it("a handler slower than the request timeout → 503 timeout", async () => {
    const b = await createTestApp({ extraControllers: [ProbeController], http: { requestTimeoutMs: 50 } });
    try {
      probeState.slowMs = 200;
      const r = await b.inject({ method: "GET", url: "/v1/eg/probe/slow", headers: { "x-device-id": DEVICE } });
      expect([r.statusCode, body(r).code]).toEqual([503, "timeout"]);
    } finally {
      await b.close();
    }
  });

  it("deprecated routes carry Deprecation, Sunset and Link", async () => {
    const r = await t.inject({ method: "GET", url: "/v1/eg/probe/old", headers: { "x-device-id": DEVICE } });
    expect(r.headers.deprecation).toBe(`@${String(Date.parse("2030-01-01T00:00:00Z") / 1000)}`);
    expect(r.headers.sunset).toBe("Sun, 01 Sep 2030 00:00:00 GMT");
    expect(r.headers.link).toContain('rel="deprecation"');
    expect(r.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("GET 200 carries a weak ETag; If-None-Match → 304 without body", async () => {
    const url = `/v1/eg/stores/${t.seed.slugA}`;
    const a = await t.inject({ method: "GET", url, headers: { "x-device-id": DEVICE } });
    const tag = String(a.headers.etag);
    expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    expect(a.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=120");
    const b = await t.inject({ method: "GET", url, headers: { "x-device-id": DEVICE, "if-none-match": `"other", ${tag}` } });
    expect([b.statusCode, b.body]).toEqual([304, ""]);
  });

  it("CursorQuery: limit 1-50 (default 20), opaque cursor, envelope { items, next_cursor }", async () => {
    const h = { "x-device-id": "44444444-4444-4444-8444-444444444444" };
    const d = await t.inject({ method: "GET", url: "/v1/eg/probe/list", headers: h });
    expect((body(d).items as unknown[]).length).toBe(20);
    expect(body(d).next_cursor).toBeNull();
    const c = await t.inject({ method: "GET", url: "/v1/eg/probe/list?limit=50&cursor=abc_-1", headers: h });
    expect(body(c).next_cursor).toBe("abc_-1");
    for (const q of ["limit=51", "limit=0", "limit=2.5", "cursor=a%2Fb", `cursor=${"a".repeat(513)}`]) {
      expect((await t.inject({ method: "GET", url: `/v1/eg/probe/list?${q}`, headers: h })).statusCode, q).toBe(400);
    }
  });
});

describe("degraded dependencies", () => {
  it("idempotency store: complete() failure still answers the side effect; abandon() failure keeps the original error", async () => {
    const b = await createTestApp({
      extraControllers: [ProbeController],
      idempotency: { begin: () => Promise.resolve({ kind: "fresh" }), complete: () => Promise.reject(new Error("db")), abandon: () => Promise.reject(new Error("db")) },
    });
    try {
      const tok = await b.mint();
      const ok = await b.inject({ method: "POST", url: "/v1/eg/probe/cart", headers: { ...bearer(tok), "idempotency-key": idemKey(b) }, payload: { n: 1 } });
      expect(ok.statusCode).toBe(201);
      const failed = await b.inject({ method: "POST", url: "/v1/eg/probe/cart", headers: { ...bearer(tok), "idempotency-key": idemKey(b) }, payload: { n: -1 } });
      expect(failed.statusCode).toBe(409);
      expect(b.logs.some((l) => l.includes("idempotency complete failed"))).toBe(true);
      expect(b.logs.some((l) => l.includes("idempotency abandon failed"))).toBe(true);
    } finally {
      await b.close();
    }
  });

  it("an in-flight key answers 409 with Retry-After", async () => {
    const b = await createTestApp({
      extraControllers: [ProbeController],
      idempotency: { begin: () => Promise.resolve({ kind: "in_progress" }), complete: () => Promise.resolve(), abandon: () => Promise.resolve() },
    });
    try {
      const r = await b.inject({ method: "POST", url: "/v1/eg/probe/cart", headers: { ...bearer(await b.mint()), "idempotency-key": idemKey(b) }, payload: { n: 1 } });
      expect([r.statusCode, body(r).code, r.headers["retry-after"]]).toEqual([409, "idempotency-in-flight", "1"]);
    } finally {
      await b.close();
    }
  });

  it("ASN is ignored unless the edge header is trusted", async () => {
    const hits: string[] = [];
    const spy: RateLimiterPort = { hit: (k) => (hits.push(k.split(":")[1] ?? ""), Promise.resolve({ allowed: true, retryAfterMs: 0, remaining: 1 })) };
    const b = await createTestApp({ extraControllers: [ProbeController], rateLimiter: spy });
    try {
      await b.inject({ method: "GET", url: "/v1/eg/probe/asn", headers: { "x-device-id": DEVICE, "x-client-asn": "24835" } });
      expect(hits).toEqual(["device"]);
    } finally {
      await b.close();
    }
  });

  it("ASN is a rate-limit key only when the edge header is trusted", async () => {
    const hits: string[] = [];
    const spy: RateLimiterPort = { hit: (k) => (hits.push(k.split(":")[1] ?? ""), Promise.resolve({ allowed: true, retryAfterMs: 0, remaining: 1 })) };
    const b = await createTestApp({ extraControllers: [ProbeController], rateLimiter: spy, http: { trustAsnHeader: true } });
    try {
      await b.inject({ method: "GET", url: "/v1/eg/probe/asn", headers: { "x-device-id": DEVICE, "x-client-asn": "24835" } });
      expect(hits.sort()).toEqual(["asn", "device"]);
      hits.length = 0;
      await b.inject({ method: "GET", url: "/v1/eg/probe/asn", headers: { "x-device-id": DEVICE, "x-client-asn": "AS-bad" } });
      expect(hits).toEqual(["device"]);
    } finally {
      await b.close();
    }
  });
});
