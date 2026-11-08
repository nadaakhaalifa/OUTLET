// @vitest-environment node
import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COOKIE_ACCESS, COOKIE_DEVICE, COOKIE_INSTALL, COOKIE_REFRESH, handleAuth, handleProxy, type BffDeps, type BffRequest, type BffResult, type CookieOp } from "../src/server/bff";
// Read-only import of the real API test app (NestJS + Fastify on PGlite): the BFF must speak the SERVED API, not docs/api/openapi.yaml.
import { createTestApp, idemKey, type TestApp } from "../../api/test/harness";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const MIN = 60_000;
const phone = (): string => `+2010${String(randomInt(10_000_000, 99_999_999))}`;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the expected shape
const parse = <T = Record<string, unknown>>(body: string | null): T => JSON.parse(body ?? "null") as T;

/** The BFF's upstream fetch, served by the real API app (clock injected so tokens and Idempotency-Keys agree). */
const upstream: BffDeps["fetch"] = async (url, init) => {
  const u = new URL(url);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k] = v;
  const res = await t.inject({ method: init.method as "GET", url: `${u.pathname}${u.search}`, headers, ...(init.body === undefined ? {} : { payload: init.body as string }) });
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") out.set(k, v);
  return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: out });
};
const calls: { method: string; path: string; headers: Record<string, string> }[] = [];
const deps = (): BffDeps => ({
  apiUrl: "http://api.internal",
  now: () => t.clock.now,
  fetch: (url, init) => {
    calls.push({ method: init.method ?? "GET", path: new URL(url).pathname, headers: { ...((init.headers ?? {}) as Record<string, string>) } });
    return upstream(url, init);
  },
});

/** A browser: a cookie jar fed by the BFF's Set-Cookie operations. */
class Browser {
  readonly jar = new Map<string, string>();
  private apply(ops: readonly CookieOp[]): void {
    for (const c of ops) {
      if (c.maxAge === 0) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
  }
  private request(method: string, over: Partial<BffRequest>): BffRequest {
    return {
      method, host: "shop.test", origin: method === "GET" ? null : "https://shop.test", secFetchSite: "same-origin", contentType: "application/json", acceptLanguage: "ar-EG",
      idempotencyKey: null, userAgent: "contract-test", cookies: Object.fromEntries(this.jar), search: "", body: "", ...over,
    };
  }
  async auth(action: string, method: string, body?: unknown): Promise<BffResult> {
    const r = await handleAuth(this.request(method, body === undefined ? {} : { body: JSON.stringify(body) }), "eg", action, deps());
    this.apply(r.cookies);
    return r;
  }
  async proxy(method: string, path: string[], o: { body?: unknown; search?: string; idempotencyKey?: string } = {}): Promise<BffResult> {
    const r = await handleProxy(
      this.request(method, { ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }), ...(o.search === undefined ? {} : { search: o.search }), ...(o.idempotencyKey === undefined ? {} : { idempotencyKey: o.idempotencyKey }) }),
      "eg", path, deps(),
    );
    this.apply(r.cookies);
    return r;
  }
  /** OTP request + verify through the BFF; returns the verify result. */
  async signIn(p: string, dob: string | undefined): Promise<BffResult> {
    const req = await this.auth("otp-request", "POST", { phone_e164: p, purpose: "register", channel: "sms" });
    expect(req.status).toBe(201);
    const { challenge_id } = parse<{ challenge_id: string }>(req.body);
    return this.auth("otp-verify", "POST", { challenge_id, phone_e164: p, code: t.sms.last(), ...(dob === undefined ? {} : { dob }) });
  }
}

/** Calls the API directly (no BFF) to prove what the server thinks of a token. */
const apiRefresh = async (refreshToken: string, deviceId: string) =>
  t.inject({ method: "POST", url: "/v1/eg/auth/refresh", headers: { "x-device-id": deviceId, "idempotency-key": idemKey(t) }, payload: { refresh_token: refreshToken } });

describe("BFF against the served API", () => {
  it("device registration, OTP request, verify with dob, authenticated cart via the proxy", async () => {
    const b = new Browser();
    calls.length = 0;
    const verified = await b.signIn(phone(), "1990-01-01");
    expect(verified.status).toBe(200);
    expect(parse(verified.body)).toEqual({ user_id: expect.any(String) as string, is_new_user: true });
    expect(verified.body).not.toMatch(/eyJ/); // no token reaches the page
    for (const name of [COOKIE_INSTALL, COOKIE_DEVICE, COOKIE_ACCESS, COOKIE_REFRESH]) expect(b.jar.has(name), name).toBe(true);

    // First contact registered the install exactly once, before anything else; every later upstream call carries X-Device-Id.
    expect(calls.map((c) => c.path)).toEqual(["/v1/eg/auth/devices", "/v1/eg/auth/otp/request", "/v1/eg/auth/otp/verify"]);
    expect(calls[0]?.headers["x-device-id"]).toBeUndefined();
    for (const c of calls.slice(1)) expect(c.headers["x-device-id"]).toBe(b.jar.get(COOKIE_DEVICE));

    const cart = await b.proxy("GET", ["cart"]);
    expect(cart.status).toBe(200);
    expect(parse(cart.body)).toHaveProperty("groups");
    const add = await b.proxy("POST", ["cart", "lines"], { body: { sku_id: t.seed.skuA, qty: 1 }, idempotencyKey: idemKey(t) });
    expect(add.status).toBe(201);
    const after = await b.auth("session", "GET");
    expect(parse(after.body)).toEqual({ authenticated: true });
  });

  it("under-age and age-blocked are API problems mapped by type; otp-locked and rate-limited carry Retry-After", async () => {
    const b = new Browser();
    const minor = await b.signIn(phone(), "2015-01-01");
    expect(minor.status).toBe(403);
    expect(parse<{ type: string }>(minor.body).type).toBe("urn:outlex:problem:under-age");
    expect(b.jar.has(COOKIE_ACCESS)).toBe(false);
    // Same device, adult dob: soft-blocked for 30 days.
    const retry = await b.signIn(phone(), "1990-01-01");
    expect(retry.status).toBe(403);
    expect(parse<{ type: string }>(retry.body).type).toBe("urn:outlex:problem:age-blocked");

    const c = new Browser();
    const p = phone();
    const req = await c.auth("otp-request", "POST", { phone_e164: p, purpose: "register", channel: "sms" });
    const { challenge_id } = parse<{ challenge_id: string }>(req.body);
    const code = t.sms.last();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) expect((await c.auth("otp-verify", "POST", { challenge_id, phone_e164: p, code: wrong, dob: "1990-01-01" })).status).toBe(400);
    const locked = await c.auth("otp-verify", "POST", { challenge_id, phone_e164: p, code, dob: "1990-01-01" });
    expect(locked.status).toBe(429);
    expect(parse<{ type: string }>(locked.body).type).toBe("urn:outlex:problem:otp-locked");
    expect(Number(locked.retryAfter)).toBeGreaterThan(0);

    const q = phone();
    let last: BffResult | undefined;
    for (let i = 0; i < 4; i += 1) last = await c.auth("otp-request", "POST", { phone_e164: q, purpose: "sign_in", channel: "sms" });
    expect(last?.status).toBe(429);
    expect(parse<{ type: string }>(last?.body ?? null).type).toBe("urn:outlex:problem:rate-limited");
    expect(Number(last?.retryAfter)).toBeGreaterThan(0);
  });

  it("an expired access token is refreshed once on the next proxied call and the refresh token rotates (the old one is dead)", async () => {
    const b = new Browser();
    expect((await b.signIn(phone(), "1990-01-01")).status).toBe(200);
    const oldRt = b.jar.get(COOKIE_REFRESH) ?? "";
    const oldAt = b.jar.get(COOKIE_ACCESS) ?? "";
    const did = b.jar.get(COOKIE_DEVICE) ?? "";
    t.clock.now += 11 * MIN; // access tokens live 10 minutes
    calls.length = 0;
    const cart = await b.proxy("GET", ["cart"]);
    expect(cart.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/eg/cart", "POST /v1/eg/auth/refresh", "GET /v1/eg/cart"]);
    expect(b.jar.get(COOKIE_REFRESH)).not.toBe(oldRt);
    expect(b.jar.get(COOKIE_ACCESS)).not.toBe(oldAt);
    const refreshCall = calls[1];
    expect(refreshCall?.headers["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    calls.length = 0;
    expect((await b.proxy("GET", ["cart"])).status).toBe(200);
    expect(calls).toHaveLength(1); // no second refresh
    // Presenting the rotated-out token is reuse: the API answers 401 (and revokes the family).
    expect((await apiRefresh(oldRt, did)).statusCode).toBe(401);
  });

  it("logout revokes upstream; with an expired access token it refreshes first, then revokes", async () => {
    const b = new Browser();
    expect((await b.signIn(phone(), "1990-01-01")).status).toBe(200);
    const rt = b.jar.get(COOKIE_REFRESH) ?? "";
    const did = b.jar.get(COOKIE_DEVICE) ?? "";
    const out = await b.auth("logout", "POST");
    expect(out.status).toBe(204);
    expect(b.jar.has(COOKIE_ACCESS) || b.jar.has(COOKIE_REFRESH)).toBe(false);
    expect((await apiRefresh(rt, did)).statusCode).toBe(401); // the family is revoked
    expect(parse((await b.auth("session", "GET")).body)).toEqual({ authenticated: false });

    const c = new Browser();
    expect((await c.signIn(phone(), "1990-01-01")).status).toBe(200);
    const crt = c.jar.get(COOKIE_REFRESH) ?? "";
    const cdid = c.jar.get(COOKIE_DEVICE) ?? "";
    t.clock.now += 11 * MIN;
    c.jar.delete(COOKIE_ACCESS); // the browser dropped the expired cookie
    calls.length = 0;
    const out2 = await c.auth("logout", "POST");
    expect(out2.status).toBe(204);
    expect(calls.map((x) => x.path)).toEqual(["/v1/eg/auth/refresh", "/v1/eg/auth/logout"]);
    expect(c.jar.size).toBe(2); // only the install and device cookies remain
    // The rotated token the BFF obtained for the revoke is dead too, and so is the one the browser held.
    expect((await apiRefresh(crt, cdid)).statusCode).toBe(401);
  });

  it("a stale session cookie is not 'authenticated' once the API rejects it", async () => {
    const b = new Browser();
    expect((await b.signIn(phone(), "1990-01-01")).status).toBe(200);
    const stale = new Map(b.jar);
    await b.auth("logout", "POST");
    const ghost = new Browser();
    for (const [k, v] of stale) ghost.jar.set(k, v);
    t.clock.now += 11 * MIN;
    const s = await ghost.auth("session", "GET");
    expect(s.status).toBe(200);
    expect(parse(s.body)).toEqual({ authenticated: false });
    expect(ghost.jar.has(COOKIE_REFRESH)).toBe(false);
  });
});
