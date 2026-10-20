import { describe, expect, it } from "vitest";
import { buildCsp, imageOriginsOf, newNonce } from "../csp";

describe("csp", () => {
  const csp = buildCsp({ nonce: "abc123", isDev: false, imageOrigins: ["https://img.example.test"] });
  it("nonce + strict-dynamic, no unsafe-inline/eval in production", () => {
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });
  it("locks framing, objects, base, forms; connect is same-origin only", () => {
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "connect-src 'self';", "frame-src 'none'", "upgrade-insecure-requests"]) expect(csp).toContain(d);
    expect(csp).toContain("img-src 'self' data: https://img.example.test");
  });
  it("allows eval only in dev; upgrade can be disabled for http loopback", () => {
    expect(buildCsp({ nonce: "n", isDev: true, imageOrigins: [] })).toContain("'unsafe-eval'");
    expect(buildCsp({ nonce: "n", isDev: false, imageOrigins: [], upgradeInsecure: false })).not.toContain("upgrade-insecure-requests");
  });
  it("nonce is 16 random bytes in base64 and differs per call", () => {
    const rnd = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
    const a = newNonce(rnd);
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce(rnd)).not.toBe(a);
  });
  it("keeps only https image origins", () => {
    expect(imageOriginsOf("https://a.test, http://b.test, nonsense, https://a.test/x")).toEqual(["https://a.test"]);
    expect(imageOriginsOf(undefined)).toEqual([]);
  });
});
