import { describe, expect, it } from "vitest";
import { buildCsp, generateNonce } from "../src/security/csp";
import { staticSecurityHeaders } from "../src/security/headers";
import { sanitizeRequestHeaders } from "../src/security/request-headers";

describe("buildCsp", () => {
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  it("embeds the nonce in script-src and style-src and never allows unsafe-inline", () => {
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });
  it("locks framing, base and forms", () => {
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "connect-src 'self'", "object-src 'none'"]) expect(csp).toContain(d);
  });
  it("adds Trusted Types only behind the flag", () => {
    expect(csp).not.toContain("require-trusted-types-for");
    expect(buildCsp(nonce, { trustedTypes: true })).toContain("require-trusted-types-for 'script'");
  });
  it("allows eval only in dev", () => {
    expect(buildCsp(nonce, { dev: true })).toContain("'unsafe-eval'");
  });
  it("mints a fresh 16-byte nonce each time", () => {
    expect(generateNonce()).not.toBe(generateNonce());
    expect(atob(nonce)).toHaveLength(16);
  });
});

describe("staticSecurityHeaders", () => {
  it("sets HSTS preload, nosniff, referrer policy and COOP", () => {
    const h = Object.fromEntries(staticSecurityHeaders().map((e) => [e.key, e.value]));
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=\d+; includeSubDomains; preload/);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });
});

describe("sanitizeRequestHeaders", () => {
  it("strips x-middleware-*, x-nonce and a client-supplied CSP but keeps the rest", () => {
    const out = sanitizeRequestHeaders(new Headers({ "x-middleware-subrequest": "middleware", "X-Middleware-Next": "1", "x-nonce": "evil", "content-security-policy": "x", accept: "text/html" }));
    expect([...out.keys()]).toEqual(["accept"]);
  });
});
