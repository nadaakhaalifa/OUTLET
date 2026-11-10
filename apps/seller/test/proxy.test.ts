import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "../src/proxy";

const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { headers });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy", () => {
  it("redirects / to eg-ar by default and eg-en for English Accept-Language", () => {
    const ar = proxy(req("/"));
    expect(ar.status).toBe(307);
    expect(new URL(ar.headers.get("location") ?? "").pathname).toBe("/eg-ar");
    const en = proxy(req("/", { "accept-language": "en-US,en;q=0.9" }));
    expect(new URL(en.headers.get("location") ?? "").pathname).toBe("/eg-en");
    const other = proxy(req("/", { "accept-language": "fr" }));
    expect(new URL(other.headers.get("location") ?? "").pathname).toBe("/eg-ar");
  });

  it("passes an invalid segment through (the page 404s) with a CSP set", () => {
    const res = proxy(req("/xx-zz/deals"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("script-src");
  });

  it("mints a fresh nonce per request, in the CSP and forwarded as x-nonce", () => {
    const a = proxy(req("/eg-ar"));
    const b = proxy(req("/eg-ar"));
    const nonceA = /'nonce-([^']+)'/.exec(a.headers.get("content-security-policy") ?? "")?.[1];
    const nonceB = /'nonce-([^']+)'/.exec(b.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonceA).toBeTruthy();
    expect(nonceA).not.toBe(nonceB);
    expect(a.headers.get("x-middleware-override-headers")).toContain("x-nonce");
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonceA);
  });

  it("strips client-supplied x-middleware-* and x-nonce before forwarding", () => {
    const res = proxy(req("/eg-ar", { "x-middleware-subrequest": "middleware", "x-nonce": "attacker" }));
    expect(res.headers.get("x-middleware-override-headers") ?? "").not.toContain("x-middleware-subrequest");
    expect(res.headers.get("x-middleware-request-x-middleware-subrequest")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-nonce")).not.toBe("attacker");
  });

  it("honours the trusted-types switch and dev/prod mode", () => {
    vi.stubEnv("CSP_TRUSTED_TYPES", "on");
    vi.stubEnv("NODE_ENV", "production");
    const csp = proxy(req("/eg-ar")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("require-trusted-types-for");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("exports a matcher that excludes static assets", () => {
    expect(config.matcher[0]?.source).toContain("_next/static");
  });
});
