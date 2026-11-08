import { describe, expect, it, vi } from "vitest";
import { COOKIE_ACCESS, COOKIE_INSTALL, COOKIE_REFRESH, csrfOk, handleAuth, handleProxy, type BffDeps, type BffRequest } from "../src/server/bff";

const NOW = Date.parse("2026-11-08T10:00:00Z");
const pair = (over: Record<string, unknown> = {}) => ({
  access_token: "AT-secret", access_expires_at: "2026-11-08T10:10:00Z", refresh_token: "RT-secret", refresh_expires_at: "2026-12-08T10:00:00Z", token_type: "Bearer", amr: ["otp"], user_id: "u1", is_new_user: true, ...over,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const req = (over: Partial<BffRequest> = {}): BffRequest => ({
  method: "POST", host: "shop.test", origin: "https://shop.test", contentType: "application/json", acceptLanguage: "ar-EG", idempotencyKey: null, userAgent: "UA", cookies: {}, search: "", body: "", ...over,
});
const deps = (f: (url: string, init: RequestInit) => Promise<Response>): BffDeps => ({ apiUrl: "http://api.test", fetch: f, now: () => NOW });
const lastInit = (f: ReturnType<typeof vi.fn>, i = -1) => (f.mock.calls.at(i) as [string, RequestInit])[1];

describe("csrfOk", () => {
  it("requires a same-host Origin and a JSON body on mutations", () => {
    expect(csrfOk(req())).toBe(true);
    expect(csrfOk(req({ origin: null }))).toBe(false);
    expect(csrfOk(req({ origin: "https://evil.test" }))).toBe(false);
    expect(csrfOk(req({ origin: "not a url" }))).toBe(false);
    expect(csrfOk(req({ body: "a=1", contentType: "text/plain" }))).toBe(false);
    expect(csrfOk(req({ method: "GET", origin: null }))).toBe(true);
  });
});

describe("handleAuth", () => {
  it("otp-verify sets HttpOnly token cookies and never returns a token to the page", async () => {
    const f = vi.fn().mockResolvedValue(json(200, pair()));
    const r = await handleAuth(req({ body: JSON.stringify({ challenge_id: "c1", code: "123456", age_gate_token: "g" }) }), "eg", "otp-verify", deps(f));
    expect(r.status).toBe(200);
    expect(r.body).not.toContain("secret");
    expect(JSON.parse(r.body ?? "{}")).toEqual({ user_id: "u1", is_new_user: true });
    const at = r.cookies.find((c) => c.name === COOKIE_ACCESS);
    const rt = r.cookies.find((c) => c.name === COOKIE_REFRESH);
    expect(at).toMatchObject({ value: "AT-secret", maxAge: 600 });
    expect(rt?.value).toBe("RT-secret");
    expect(r.cookies.some((c) => c.name === COOKIE_INSTALL)).toBe(true);
    const sent = JSON.parse(lastInit(f).body as string) as { device: { platform: string; install_id: string }; code: string };
    expect(sent.device.platform).toBe("web");
    expect(sent.code).toBe("123456");
    expect((lastInit(f).headers as Record<string, string>)["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("passes upstream errors and Retry-After through, without cookies", async () => {
    const f = vi.fn().mockResolvedValue(json(429, { type: "https://x/too-many-requests" }, { "retry-after": "42" }));
    const r = await handleAuth(req({ body: JSON.stringify({ phone_e164: "+201012345678", purpose: "sign_in" }) }), "eg", "otp-request", deps(f));
    expect(r.status).toBe(429);
    expect(r.retryAfter).toBe("42");
    expect(r.cookies.filter((c) => c.name !== COOKIE_INSTALL)).toEqual([]);
  });
  it("injects the age policy version and rejects unknown body fields", async () => {
    const f = vi.fn().mockResolvedValue(json(200, { age_gate_token: "g", expires_at: "x", age_band: "21_plus" }));
    await handleAuth(req({ body: JSON.stringify({ dob: "1990-01-01", attested_18: true }) }), "eg", "age-gate", deps(f));
    expect(JSON.parse(lastInit(f).body as string)).toMatchObject({ policy_version: 1, attested_18: true });
    const bad = await handleAuth(req({ body: JSON.stringify({ dob: "1990-01-01", attested_18: true, extra: 1 }) }), "eg", "age-gate", deps(f));
    expect(bad.status).toBe(400);
  });
  it("logout clears cookies even when the API fails", async () => {
    const f = vi.fn().mockRejectedValue(new Error("down"));
    const r = await handleAuth(req({ cookies: { [COOKIE_ACCESS]: "a" } }), "eg", "logout", deps(f));
    expect(r.status).toBe(204);
    expect(r.cookies.map((c) => [c.name, c.maxAge])).toEqual([[COOKIE_ACCESS, 0], [COOKIE_REFRESH, 0]]);
  });
  it("session reports presence of cookies; csrf, method, market and config are enforced", async () => {
    const f = vi.fn();
    expect(JSON.parse((await handleAuth(req({ method: "GET", cookies: { [COOKIE_REFRESH]: "r" } }), "eg", "session", deps(f))).body ?? "")).toEqual({ authenticated: true });
    expect(JSON.parse((await handleAuth(req({ method: "GET" }), "eg", "session", deps(f))).body ?? "")).toEqual({ authenticated: false });
    expect((await handleAuth(req({ origin: "https://evil.test" }), "eg", "otp-request", deps(f))).status).toBe(403);
    expect((await handleAuth(req({ method: "GET" }), "eg", "otp-request", deps(f))).status).toBe(405);
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
    const r = await handleAuth(req({ body: JSON.stringify({ challenge_id: "c", code: "123456" }) }), "eg", "otp-verify", deps(f));
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
  it("forwards the query string, a 409 body and Retry-After; 204 has no body", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(409, { type: "x/price-changed" }, { "retry-after": "3" })).mockResolvedValueOnce(json(204, null));
    const r = await handleProxy(req({ method: "GET", search: "?limit=50", cookies: { [COOKIE_ACCESS]: "a" } }), "eg", ["me", "sessions"], deps(f));
    expect(f.mock.calls[0]?.[0]).toBe("http://api.test/v1/eg/me/sessions?limit=50");
    expect(r).toMatchObject({ status: 409, retryAfter: "3" });
    const d = await handleProxy(req({ method: "DELETE", cookies: { [COOKIE_ACCESS]: "a" } }), "eg", ["me", "sessions", "s1"], deps(f));
    expect(d).toMatchObject({ status: 204, body: null });
  });
});
