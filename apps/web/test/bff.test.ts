import { describe, expect, it, vi } from "vitest";
import { COOKIE_ACCESS, COOKIE_DEVICE, COOKIE_INSTALL, MAX_SEARCH_LENGTH, COOKIE_REFRESH, csrfOk, handleAuth, handleProxy, type BffDeps, type BffRequest } from "../src/server/bff";

const NOW = Date.parse("2026-11-08T10:00:00Z");
const pair = (over: Record<string, unknown> = {}) => ({
  access_token: "AT-secret", access_expires_at: "2026-11-08T10:10:00Z", refresh_token: "RT-secret", refresh_expires_at: "2026-12-08T10:00:00Z", token_type: "Bearer", amr: ["otp"], user_id: "u1", is_new_user: true, ...over,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const IID = "11111111-1111-4111-8111-111111111111";
const DID = "22222222-2222-4222-8222-222222222222";
const req = (over: Partial<BffRequest> = {}): BffRequest => ({
  method: "POST", host: "shop.test", origin: "https://shop.test", contentType: "application/json", acceptLanguage: "ar-EG", idempotencyKey: null, userAgent: "UA", search: "", body: "", ...over,
  cookies: { [COOKIE_INSTALL]: IID, [COOKIE_DEVICE]: DID, ...over.cookies },
});
const deps = (f: (url: string, init: RequestInit) => Promise<Response>): BffDeps => ({ apiUrl: "http://api.test", fetch: f, now: () => NOW });
const lastInit = (f: ReturnType<typeof vi.fn>, i = -1) => (f.mock.calls.at(i) as [string, RequestInit])[1];

describe("csrfOk", () => {
  it("requires a same-host Origin and a JSON body on mutations", () => {
    expect(csrfOk(req())).toBe(true);
    expect(csrfOk(req({ origin: null }))).toBe(false);
    expect(csrfOk(req({ origin: null, secFetchSite: "cross-site" }))).toBe(false);
    expect(csrfOk(req({ origin: null, secFetchSite: "same-origin" }))).toBe(true);
    expect(csrfOk(req({ origin: null, secFetchSite: "same-origin", body: "a=1", contentType: "text/plain" }))).toBe(false);
    expect(csrfOk(req({ origin: "https://evil.test", secFetchSite: "same-origin" }))).toBe(false);
    expect(csrfOk(req({ origin: "https://evil.test" }))).toBe(false);
    expect(csrfOk(req({ origin: "not a url" }))).toBe(false);
    expect(csrfOk(req({ body: "a=1", contentType: "text/plain" }))).toBe(false);
    expect(csrfOk(req({ method: "GET", origin: null }))).toBe(true);
  });
});

describe("handleAuth", () => {
  it("otp-verify sends the served DTO (phone_e164, dob, no device object, X-Device-Id), sets HttpOnly cookies and never returns a token", async () => {
    const f = vi.fn().mockResolvedValue(json(200, pair()));
    const r = await handleAuth(req({ idempotencyKey: "client-key", body: JSON.stringify({ challenge_id: "c1", phone_e164: "+201012345678", code: "123456", dob: "1990-01-01" }) }), "eg", "otp-verify", deps(f));
    expect(r.status).toBe(200);
    expect(r.body).not.toContain("secret");
    expect(JSON.parse(r.body ?? "{}")).toEqual({ user_id: "u1", is_new_user: true });
    expect(r.cookies.find((c) => c.name === COOKIE_ACCESS)).toMatchObject({ value: "AT-secret", maxAge: 600 });
    expect(r.cookies.find((c) => c.name === COOKIE_REFRESH)?.value).toBe("RT-secret");
    expect(JSON.parse(lastInit(f).body as string)).toEqual({ challenge_id: "c1", phone_e164: "+201012345678", code: "123456", dob: "1990-01-01" });
    const h = lastInit(f).headers as Record<string, string>;
    expect(h["x-device-id"]).toBe(DID);
    expect(h["idempotency-key"]).toBe("client-key");
  });
  it("first contact registers the install, stores the device id cookie and sends it as X-Device-Id on every call", async () => {
    const f = vi.fn((url: string) => Promise.resolve(url.endsWith("/auth/devices") ? json(201, { device_id: DID }) : json(201, { challenge_id: "c", expires_at: "x", resend_after_s: 30, channel: "sms" })));
    const r = await handleAuth(req({ cookies: { [COOKIE_INSTALL]: "", [COOKIE_DEVICE]: "" }, body: JSON.stringify({ phone_e164: "+201012345678", purpose: "sign_in" }) }), "eg", "otp-request", deps(f));
    expect(r.status).toBe(201);
    expect(f.mock.calls[0]?.[0]).toBe("http://api.test/v1/eg/auth/devices");
    const reg = JSON.parse(lastInit(f, 0).body as string) as { install_id: string; platform: string };
    expect(reg).toEqual({ install_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string, platform: "web" });
    expect((lastInit(f, 0).headers as Record<string, string>)["idempotency-key"]).toBeUndefined();
    expect((lastInit(f, 1).headers as Record<string, string>)["x-device-id"]).toBe(DID);
    expect(JSON.parse(lastInit(f, 1).body as string)).toEqual({ phone_e164: "+201012345678", purpose: "sign_in", channel: "sms" });
    expect(r.cookies.find((c) => c.name === COOKIE_INSTALL)?.value).toBe(reg.install_id);
    expect(r.cookies.find((c) => c.name === COOKIE_DEVICE)?.value).toBe(DID);
  });
  it("a device cookie without a valid install cookie is re-registered; a registration failure is passed through (or 502)", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(429, { type: "urn:outlex:problem:rate-limited" }, { "retry-after": "9" }));
    const r = await handleAuth(req({ cookies: { [COOKIE_INSTALL]: "", [COOKIE_DEVICE]: DID }, body: JSON.stringify({ phone_e164: "+201012345678", purpose: "sign_in" }) }), "eg", "otp-request", deps(f));
    expect(r).toMatchObject({ status: 429, retryAfter: "9" });
    expect(f).toHaveBeenCalledTimes(1);
    const bad = vi.fn().mockResolvedValue(json(201, { device_id: "nope" }));
    expect((await handleAuth(req({ cookies: { [COOKIE_DEVICE]: "" }, body: JSON.stringify({ phone_e164: "+201012345678", purpose: "sign_in" }) }), "eg", "otp-request", deps(bad))).status).toBe(502);
    const down = vi.fn().mockRejectedValue(new Error("down"));
    expect((await handleAuth(req({ cookies: { [COOKIE_DEVICE]: "" }, body: JSON.stringify({ phone_e164: "+201012345678", purpose: "sign_in" }) }), "eg", "otp-request", deps(down))).status).toBe(502);
  });
  it("passes upstream errors and Retry-After through, without cookies", async () => {
    const f = vi.fn().mockResolvedValue(json(429, { type: "https://x/too-many-requests" }, { "retry-after": "42" }));
    const r = await handleAuth(req({ body: JSON.stringify({ phone_e164: "+201012345678", purpose: "sign_in" }) }), "eg", "otp-request", deps(f));
    expect(r.status).toBe(429);
    expect(r.retryAfter).toBe("42");
    expect(r.cookies.filter((c) => c.name !== COOKIE_INSTALL)).toEqual([]);
  });
  it("age-gate is no longer a BFF action (the API enforces UNDER_AGE through dob on verify) and bodies are strict", async () => {
    const f = vi.fn();
    expect((await handleAuth(req({ body: JSON.stringify({ dob: "1990-01-01", attested_18: true }) }), "eg", "age-gate", deps(f))).status).toBe(404);
    expect((await handleAuth(req({ body: JSON.stringify({ challenge_id: "c", phone_e164: "+201012345678", code: "123456", device: { platform: "web" } }) }), "eg", "otp-verify", deps(f))).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });
  it("API problems (under-age, age-blocked, otp-locked, rate-limited) pass through with their type, status and Retry-After", async () => {
    for (const [status, code, ra] of [[403, "under-age", null], [403, "age-blocked", null], [429, "otp-locked", "300"], [429, "rate-limited", "7"]] as const) {
      const f = vi.fn().mockResolvedValue(json(status, { type: `urn:outlex:problem:${code}`, status }, ra === null ? {} : { "retry-after": ra }));
      const r = await handleAuth(req({ body: JSON.stringify({ challenge_id: "c", phone_e164: "+201012345678", code: "123456", dob: "2015-01-01" }) }), "eg", "otp-verify", deps(f));
      expect(r.status).toBe(status);
      expect(r.retryAfter).toBe(ra);
      expect((JSON.parse(r.body ?? "") as { type: string }).type).toBe(`urn:outlex:problem:${code}`);
      expect(r.cookies.filter((c) => c.name === COOKIE_ACCESS || c.name === COOKIE_REFRESH)).toEqual([]);
    }
  });
  describe("logout", () => {
    const cleared = (r: { cookies: readonly { name: string; maxAge: number }[] }) => r.cookies.filter((c) => c.maxAge === 0).map((c) => c.name).sort();
    const both = [COOKIE_ACCESS, COOKIE_REFRESH].sort();
    it("revokes with the access cookie and mints a fresh Idempotency-Key (never the browser's)", async () => {
      const f = vi.fn().mockResolvedValue(json(204, null));
      const r = await handleAuth(req({ idempotencyKey: "browser-key", cookies: { [COOKIE_ACCESS]: "AT", [COOKIE_REFRESH]: "RT" } }), "eg", "logout", deps(f));
      expect(r.status).toBe(204);
      expect(cleared(r)).toEqual(both);
      const h = lastInit(f).headers as Record<string, string>;
      expect(h.authorization).toBe("Bearer AT");
      expect(h["idempotency-key"]).toMatch(/-7[0-9a-f]{3}-/);
      expect(h["x-device-id"]).toBe(DID);
    });
    it("with no access cookie it refreshes first (fresh key), then revokes with the new token", async () => {
      const f = vi.fn((url: string) => Promise.resolve(url.endsWith("/auth/refresh") ? json(200, pair({ access_token: "AT2" })) : json(204, null)));
      const r = await handleAuth(req({ idempotencyKey: "browser-key", cookies: { [COOKIE_REFRESH]: "RT-lo1" } }), "eg", "logout", deps(f));
      expect(r.status).toBe(204);
      expect(f.mock.calls.map((c) => c[0])).toEqual(["http://api.test/v1/eg/auth/refresh", "http://api.test/v1/eg/auth/logout"]);
      expect((lastInit(f, 0).headers as Record<string, string>)["idempotency-key"]).not.toBe("browser-key");
      expect(JSON.parse(lastInit(f, 0).body as string)).toEqual({ refresh_token: "RT-lo1" });
      expect((lastInit(f, 1).headers as Record<string, string>).authorization).toBe("Bearer AT2");
      expect(cleared(r)).toEqual(both);
    });
    it("an expired access token (401) is refreshed once and the revoke retried", async () => {
      let logouts = 0;
      const f = vi.fn((url: string) => {
        if (url.endsWith("/auth/refresh")) return Promise.resolve(json(200, pair({ access_token: "AT3" })));
        logouts += 1;
        return Promise.resolve(logouts === 1 ? json(401, {}) : json(204, null));
      });
      const r = await handleAuth(req({ cookies: { [COOKIE_ACCESS]: "old", [COOKIE_REFRESH]: "RT-lo2" } }), "eg", "logout", deps(f));
      expect(r.status).toBe(204);
      expect(f).toHaveBeenCalledTimes(3);
      expect((lastInit(f).headers as Record<string, string>).authorization).toBe("Bearer AT3");
    });
    it("a failed revocation is a 502 (not 204) and the cookies are still cleared", async () => {
      for (const f of [vi.fn().mockRejectedValue(new Error("down")), vi.fn().mockResolvedValue(json(500, {}))]) {
        const r = await handleAuth(req({ cookies: { [COOKIE_ACCESS]: "a", [COOKIE_REFRESH]: "r" } }), "eg", "logout", deps(f));
        expect(r.status).toBe(502);
        expect(cleared(r)).toEqual(both);
      }
      const g = vi.fn().mockResolvedValue(json(503, {}));
      const r = await handleAuth(req({ cookies: { [COOKIE_REFRESH]: "RT-lo3" } }), "eg", "logout", deps(g));
      expect(r.status).toBe(502);
      expect(cleared(r)).toEqual(both);
    });
    it("a dead refresh token means there is nothing to revoke: 204 with cleared cookies; no cookies at all is 204 without calls", async () => {
      const f = vi.fn().mockResolvedValue(json(401, {}));
      const r = await handleAuth(req({ cookies: { [COOKIE_REFRESH]: "RT-dead2" } }), "eg", "logout", deps(f));
      expect(r.status).toBe(204);
      expect(cleared(r)).toEqual(both);
      const none = vi.fn();
      expect((await handleAuth(req(), "eg", "logout", deps(none))).status).toBe(204);
      expect(none).not.toHaveBeenCalled();
    });
  });
  it("session is verified upstream: 200 means authenticated, 401 means not (cookies cleared), outages are 502; no cookies means no call", async () => {
    const f = vi.fn().mockResolvedValue(json(200, { items: [] }));
    const ok = await handleAuth(req({ method: "GET", origin: null, cookies: { [COOKIE_ACCESS]: "a" } }), "eg", "session", deps(f));
    expect(JSON.parse(ok.body ?? "")).toEqual({ authenticated: true });
    expect(f.mock.calls[0]?.[0]).toBe("http://api.test/v1/eg/me/sessions?limit=1");
    const dead = vi.fn().mockResolvedValue(json(401, {}));
    const no = await handleAuth(req({ method: "GET", cookies: { [COOKIE_ACCESS]: "stale" } }), "eg", "session", deps(dead));
    expect(no.status).toBe(200);
    expect(JSON.parse(no.body ?? "")).toEqual({ authenticated: false });
    expect(no.cookies.some((c) => c.maxAge === 0)).toBe(true);
    const down = vi.fn().mockResolvedValue(json(503, {}));
    expect((await handleAuth(req({ method: "GET", cookies: { [COOKIE_ACCESS]: "a" } }), "eg", "session", deps(down))).status).toBe(503);
    const none = vi.fn();
    expect(JSON.parse((await handleAuth(req({ method: "GET" }), "eg", "session", deps(none))).body ?? "")).toEqual({ authenticated: false });
    expect(none).not.toHaveBeenCalled();
  });
  it("csrf, method, market and config are enforced before anything is parsed or sent", async () => {
    const f = vi.fn();
    expect((await handleAuth(req({ origin: "https://evil.test" }), "eg", "otp-request", deps(f))).status).toBe(403);
    expect((await handleAuth(req({ origin: null, secFetchSite: "cross-site", body: "{}" }), "eg", "logout", deps(f))).status).toBe(403);
    expect((await handleAuth(req({ origin: null, secFetchSite: "same-origin", body: "{}" }), "eg", "logout", deps(f))).status).toBe(204);
    expect((await handleAuth(req({ method: "GET" }), "eg", "otp-request", deps(f))).status).toBe(405);
    expect((await handleAuth(req({ method: "POST" }), "eg", "session", deps(f))).status).toBe(405);
    expect((await handleAuth(req(), "EG!", "otp-request", deps(f))).status).toBe(404);
    expect((await handleAuth(req(), "eg", "nope", deps(f))).status).toBe(404);
    expect((await handleAuth(req({ body: "{" }), "eg", "otp-request", deps(f))).status).toBe(400);
    expect((await handleAuth(req({ body: "{}" }), "eg", "otp-request", { apiUrl: undefined, fetch: f })).status).toBe(503);
    expect(f).not.toHaveBeenCalled();
  });
  it("passkey options come from the API and verify sets cookies", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(200, { challenge_id: "c", public_key: {}, expires_at: "x" })).mockResolvedValueOnce(json(200, pair({ is_new_user: false })));
    const o = await handleAuth(req(), "eg", "passkey-options", deps(f));
    expect((JSON.parse(o.body ?? "") as { challenge_id: string }).challenge_id).toBe("c");
    const v = await handleAuth(req({ body: JSON.stringify({ challenge_id: "c", credential: { id: "x" } }) }), "eg", "passkey-verify", deps(f));
    expect(v.cookies.some((c) => c.name === COOKIE_ACCESS)).toBe(true);
  });
  it("a malformed token response is a 502 without cookies", async () => {
    const f = vi.fn().mockResolvedValue(json(200, { access_token: "x" }));
    const r = await handleAuth(req({ body: JSON.stringify({ challenge_id: "c", phone_e164: "+201012345678", code: "123456" }) }), "eg", "otp-verify", deps(f));
    expect(r.status).toBe(502);
    expect(r.cookies).toEqual([]);
  });
});

describe("handleProxy", () => {
  it("adds the bearer from the cookie and a UUIDv7 idempotency key to mutations; honours a client key", async () => {
    const f = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(json(200, { ok: true })));
    await handleProxy(req({ method: "PATCH", cookies: { [COOKIE_ACCESS]: "AT" }, body: '{"qty":2}' }), "eg", ["cart", "lines", "abc"], deps(f));
    expect(f.mock.calls[0]?.[0]).toBe("http://api.test/v1/eg/cart/lines/abc");
    const h = lastInit(f).headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer AT");
    expect(h["idempotency-key"]).toMatch(/-7[0-9a-f]{3}-/);
    await handleProxy(req({ cookies: { [COOKIE_ACCESS]: "AT" }, idempotencyKey: "fixed-key", body: "{}" }), "eg", ["checkout"], deps(f));
    expect((lastInit(f).headers as Record<string, string>)["idempotency-key"]).toBe("fixed-key");
  });
  it("refreshes once on 401, retries with the new token and sets new cookies", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(401, { title: "x" }))
      .mockResolvedValueOnce(json(200, pair({ access_token: "AT2", refresh_token: "RT2" })))
      .mockResolvedValueOnce(json(200, { items: [] }));
    const r = await handleProxy(req({ method: "GET", cookies: { [COOKIE_ACCESS]: "old", [COOKIE_REFRESH]: "RT-1" } }), "eg", ["cart"], deps(f));
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
    expect((lastInit(f).headers as Record<string, string>).authorization).toBe("Bearer AT2");
    expect(r.cookies.find((c) => c.name === COOKIE_REFRESH)?.value).toBe("RT2");
  });
  it("an expired access cookie refreshes first, and parallel calls share one refresh (rotation reuse would revoke the family)", async () => {
    let refreshes = 0;
    const f = vi.fn((url: string) => {
      if (url.endsWith("/auth/refresh")) { refreshes += 1; return Promise.resolve(json(200, pair({ refresh_token: "RT-new" }))); }
      return Promise.resolve(json(200, {}));
    });
    const cookies = { [COOKIE_REFRESH]: "RT-shared" };
    await Promise.all([handleProxy(req({ method: "GET", cookies }), "eg", ["cart"], deps(f)), handleProxy(req({ method: "GET", cookies }), "eg", ["me"], deps(f))]);
    expect(refreshes).toBe(1);
  });
  it("a dead refresh token clears the cookies and answers 401", async () => {
    const f = vi.fn().mockResolvedValue(json(401, { title: "x" }));
    const r = await handleProxy(req({ method: "GET", cookies: { [COOKIE_REFRESH]: "RT-dead" } }), "eg", ["cart"], deps(f));
    expect(r.status).toBe(401);
    expect(r.cookies.filter((c) => c.maxAge === 0).map((c) => c.name).sort()).toEqual([COOKIE_ACCESS, COOKIE_REFRESH].sort());
  });
  it("no session at all is 401 without calling the API", async () => {
    const f = vi.fn();
    expect((await handleProxy(req({ method: "GET" }), "eg", ["cart"], deps(f))).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });
  it("only allow-listed roots and safe segments are proxied; products are public and read-only", async () => {
    const f = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(json(200, {})));
    for (const path of [["admin", "x"], ["cart", ".."], ["me", "a%2Fb"], []]) expect((await handleProxy(req({ method: "GET", cookies: { [COOKIE_ACCESS]: "a" } }), "eg", path, deps(f))).status).toBe(404);
    expect((await handleProxy(req({ method: "GET" }), "eg", ["products", "p1"], deps(f))).status).toBe(200);
    expect((lastInit(f).headers as Record<string, string>).authorization).toBeUndefined();
    expect((await handleProxy(req({ cookies: { [COOKIE_ACCESS]: "a" } }), "eg", ["products", "p1"], deps(f))).status).toBe(405);
    expect((await handleProxy(req({ method: "PUT", cookies: { [COOKIE_ACCESS]: "a" } }), "eg", ["cart"], deps(f))).status).toBe(405);
    expect((await handleProxy(req({ origin: null, cookies: { [COOKIE_ACCESS]: "a" } }), "eg", ["cart"], deps(f))).status).toBe(403);
    expect((await handleProxy(req({ method: "POST", body: "{", cookies: { [COOKIE_ACCESS]: "a" } }), "eg", ["cart"], deps(f))).status).toBe(400);
  });
  it("GET-only roots (products, geo-areas) reject mutations; the query string is capped at 2 KB", async () => {
    const f = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(json(200, {})));
    expect((await handleProxy(req({ cookies: { [COOKIE_ACCESS]: "a" } }), "eg", ["geo-areas"], deps(f))).status).toBe(405);
    expect((await handleProxy(req({ method: "GET" }), "eg", ["geo-areas"], deps(f))).status).toBe(200);
    expect((await handleProxy(req({ method: "GET", search: `?q=${"a".repeat(MAX_SEARCH_LENGTH)}` }), "eg", ["geo-areas"], deps(f))).status).toBe(414);
    expect((await handleProxy(req({ method: "GET", search: "q=1" }), "eg", ["geo-areas"], deps(f))).status).toBe(400);
    expect((await handleProxy(req({ method: "GET", search: `?${"a".repeat(MAX_SEARCH_LENGTH - 1)}` }), "eg", ["geo-areas"], deps(f))).status).toBe(200);
  });
  it("the browser's Idempotency-Key goes only to the proxied mutation, never to the internal refresh", async () => {
    const f = vi.fn((url: string) => Promise.resolve(url.endsWith("/auth/refresh") ? json(200, pair({ access_token: "AT9" })) : json(200, {})));
    await handleProxy(req({ idempotencyKey: "client-key", body: "{}", cookies: { [COOKIE_REFRESH]: "RT-idem" } }), "eg", ["cart", "lines"], deps(f));
    const keyOf = (i: number) => (lastInit(f, i).headers as Record<string, string>)["idempotency-key"];
    expect(f.mock.calls[0]?.[0]).toMatch(/auth\/refresh$/);
    expect(keyOf(0)).toMatch(/-7[0-9a-f]{3}-/);
    expect(keyOf(0)).not.toBe("client-key");
    expect(keyOf(1)).toBe("client-key");
    expect((lastInit(f, 0).headers as Record<string, string>)["x-device-id"]).toBe(DID);
  });
  it("an upstream network failure is a 502", async () => {
    const f = vi.fn().mockRejectedValue(new Error("down"));
    expect((await handleProxy(req({ method: "GET", cookies: { [COOKIE_ACCESS]: "a" } }), "eg", ["cart"], deps(f))).status).toBe(502);
  });
  it("forwards the query string, a 409 body and Retry-After; 204 has no body", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(409, { type: "x/price-changed" }, { "retry-after": "3" })).mockResolvedValueOnce(json(204, null));
    const r = await handleProxy(req({ method: "GET", search: "?limit=50", cookies: { [COOKIE_ACCESS]: "a" } }), "eg", ["me", "sessions"], deps(f));
    expect(f.mock.calls[0]?.[0]).toBe("http://api.test/v1/eg/me/sessions?limit=50");
    expect(r).toMatchObject({ status: 409, retryAfter: "3" });
    const d = await handleProxy(req({ method: "DELETE", cookies: { [COOKIE_ACCESS]: "a" } }), "eg", ["me", "sessions", "s1"], deps(f));
    expect(d).toMatchObject({ status: 204, body: null });
  });
});
