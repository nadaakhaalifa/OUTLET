import { describe, expect, it } from "vitest";
import { apiOriginOf, buildCsp, newNonce } from "../csp";

describe("csp", () => {
  const csp = buildCsp({ nonce: "abc123", isDev: false, apiOrigin: "https://api.example.test" });
  it("has a nonce, strict-dynamic and no unsafe-inline or unsafe-eval in production", () => {
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });
  it("locks framing, objects, base and forms; allows only the API for connect", () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self' https://api.example.test");
    expect(csp).toContain("upgrade-insecure-requests");
  });
  it("allows eval only in dev and omits connect origin when unconfigured", () => {
    const dev = buildCsp({ nonce: "n", isDev: true, apiOrigin: null });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("connect-src 'self';");
  });
  it("nonces are 16 random bytes in base64 and differ per call", () => {
    const rnd = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
    const a = newNonce(rnd);
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce(rnd)).not.toBe(a);
  });
  it("extracts the origin", () => {
    expect(apiOriginOf("https://api.example.test/base/")).toBe("https://api.example.test");
    expect(apiOriginOf(null)).toBeNull();
  });
});
