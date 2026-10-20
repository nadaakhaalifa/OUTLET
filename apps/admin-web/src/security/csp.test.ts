import { describe, expect, it } from "vitest";
import { buildCsp, isValidNonce, mintNonce } from "./csp";

const fixed = (b: Uint8Array): Uint8Array => b.map((_, i) => i + 1);

describe("csp", () => {
  const nonce = mintNonce(fixed);
  it("mints a valid 128-bit base64 nonce", () => {
    expect(nonce).toBe("AQIDBAUGBwgJCgsMDQ4PEA==");
    expect(isValidNonce(nonce)).toBe(true);
    expect(isValidNonce("short")).toBe(false);
    expect(isValidNonce("a'; script-src *; x='aaaaaaaaaaaaaaaa")).toBe(false);
  });
  it("is strict: nonce scripts, no inline or eval, no framing, locked-down base", () => {
    const csp = buildCsp({ nonce, apiOrigin: "https://api.example.test", development: false });
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("connect-src 'self' https://api.example.test");
    expect(csp).toContain("upgrade-insecure-requests");
  });
  it("allows eval only in development", () => {
    expect(buildCsp({ nonce, apiOrigin: null, development: true })).toContain("'unsafe-eval'");
  });
  it("refuses a malformed nonce (header injection)", () => {
    expect(() => buildCsp({ nonce: "x; script-src *", apiOrigin: null, development: false })).toThrow();
  });
});
