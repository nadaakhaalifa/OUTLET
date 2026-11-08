import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { liveDeps, toBffRequest, toNextResponse } from "../src/server/bff-next";
import { COOKIE_ACCESS, COOKIE_DEVICE, COOKIE_INSTALL, COOKIE_REFRESH } from "../src/server/bff";

const mk = (method: string, init: { headers?: Record<string, string>; body?: string } = {}) =>
  new NextRequest("https://shop.test/api/bff/eg/cart?limit=5", { method, headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("toBffRequest", () => {
  it("copies method, host, headers, query string, body and only the three BFF cookies", async () => {
    const r = await toBffRequest(mk("POST", { body: '{"a":1}', headers: {
      origin: "https://shop.test", "content-type": "application/json", "accept-language": "ar-EG", "idempotency-key": "K", "user-agent": "UA",
      cookie: `${COOKIE_ACCESS}=at; ${COOKIE_REFRESH}=rt; other=zzz`,
    } }));
    expect(r).toMatchObject({ method: "POST", host: "shop.test", origin: "https://shop.test", contentType: "application/json", acceptLanguage: "ar-EG", idempotencyKey: "K", userAgent: "UA", search: "?limit=5", body: '{"a":1}' });
    expect(r.cookies).toEqual({ [COOKIE_ACCESS]: "at", [COOKIE_REFRESH]: "rt", [COOKIE_INSTALL]: undefined, [COOKIE_DEVICE]: undefined });
    expect(Object.keys(r.cookies)).not.toContain("other");
  });
  it("does not read a body for GET or HEAD and reports absent headers as null", async () => {
    for (const method of ["GET", "HEAD"]) {
      const r = await toBffRequest(mk(method));
      expect(r.body).toBe("");
      expect(r).toMatchObject({ origin: null, contentType: null, idempotencyKey: null, userAgent: null });
    }
  });
  it("reads the body for DELETE and PATCH", async () => {
    expect((await toBffRequest(mk("PATCH", { body: "x" }))).body).toBe("x");
    expect((await toBffRequest(mk("DELETE", { body: "y" }))).body).toBe("y");
  });
});

describe("toNextResponse", () => {
  it("emits JSON no-store with status and body, no retry-after when null", async () => {
    const res = toNextResponse({ status: 409, body: '{"type":"x/price-changed"}', retryAfter: null, cookies: [] });
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBeNull();
    expect(await res.text()).toBe('{"type":"x/price-changed"}');
  });
  it("passes Retry-After through and sets HttpOnly Lax /api cookies, Secure only in production", () => {
    const cookies = [{ name: COOKIE_ACCESS, value: "at", maxAge: 600 }, { name: COOKIE_REFRESH, value: "rt", maxAge: 0 }];
    vi.stubEnv("NODE_ENV", "production");
    const prod = toNextResponse({ status: 429, body: null, retryAfter: "30", cookies });
    expect(prod.headers.get("retry-after")).toBe("30");
    const at = prod.cookies.get(COOKIE_ACCESS);
    expect(at).toMatchObject({ value: "at", httpOnly: true, sameSite: "lax", secure: true, path: "/api", maxAge: 600 });
    expect(prod.cookies.get(COOKIE_REFRESH)?.maxAge).toBe(0);
    vi.stubEnv("NODE_ENV", "development");
    expect(toNextResponse({ status: 200, body: "{}", retryAfter: null, cookies }).cookies.get(COOKIE_ACCESS)?.secure).toBe(false);
  });
});

describe("liveDeps", () => {
  it("fails closed with an undefined apiUrl when API_URL is unset or empty", () => {
    vi.stubEnv("API_URL", "");
    expect(liveDeps().apiUrl).toBeUndefined();
  });
  it("uses API_URL and delegates fetch to the global fetch", async () => {
    vi.stubEnv("API_URL", "http://api.test");
    const f = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", f);
    const d = liveDeps();
    expect(d.apiUrl).toBe("http://api.test");
    await d.fetch("http://api.test/x", { method: "GET" });
    expect(f).toHaveBeenCalledWith("http://api.test/x", { method: "GET" });
  });
});
