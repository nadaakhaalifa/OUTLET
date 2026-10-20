import { describe, expect, it } from "vitest";
import {
  FRESH_LOCK_STATE,
  TOTP,
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  hmacSha1,
  isLocked,
  isRecentStrongFactor,
  otpauthUri,
  registerTotpFailure,
  registerTotpSuccess,
  RECOVERY_CODE_FORMAT,
  sha1,
  toHex,
  totpCode,
  utf8,
  verifyTotp,
} from "./index";

const rng = (seed: number) => ({
  randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      out[i] = x & 255;
    }
    seed = x;
    return out;
  },
});

describe("sha1 / hmac-sha1 vectors", () => {
  it("matches FIPS 180 and RFC 2202 vectors", () => {
    expect(toHex(sha1(utf8("abc")))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(toHex(sha1(utf8("")))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(toHex(sha1(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe("84983e441c3bd26ebaae4aa1f95129e5e54670f1");
    expect(toHex(hmacSha1(new Uint8Array(20).fill(0x0b), utf8("Hi There")))).toBe("b617318655057264e28bc0b6fb378c8ef146be00");
    expect(toHex(hmacSha1(utf8("Jefe"), utf8("what do ya want for nothing?")))).toBe("effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
  });
});

describe("TOTP RFC 6238", () => {
  const secret = base32Encode(utf8("12345678901234567890"));
  it("matches the RFC 6238 SHA-1 vectors (6-digit tail of the 8-digit values)", () => {
    const cases: [number, string][] = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ];
    for (const [t, code] of cases) expect(totpCode(secret, Math.floor(t / 30))).toBe(code);
  });
  it("base32 round trips", () => {
    expect(base32Encode(utf8("foobar"))).toBe("MZXW6YTBOI");
    expect(new TextDecoder().decode(base32Decode("MZXW6YTBOI"))).toBe("foobar");
  });
  it("accepts +-1 step, rejects +-2, rejects replays", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    for (const d of [-1, 0, 1]) expect(verifyTotp({ secretBase32: secret, code: totpCode(secret, step + d), nowMs: now, lastUsedStep: null })).toEqual({ ok: true, step: step + d });
    for (const d of [-2, 2]) expect(verifyTotp({ secretBase32: secret, code: totpCode(secret, step + d), nowMs: now, lastUsedStep: null })).toEqual({ ok: false, reason: "invalid" });
    expect(verifyTotp({ secretBase32: secret, code: totpCode(secret, step), nowMs: now, lastUsedStep: step })).toEqual({ ok: false, reason: "replayed" });
    expect(verifyTotp({ secretBase32: secret, code: totpCode(secret, step - 1), nowMs: now, lastUsedStep: step })).toEqual({ ok: false, reason: "replayed" });
    expect(verifyTotp({ secretBase32: secret, code: "12345", nowMs: now, lastUsedStep: null }).ok).toBe(false);
  });
  it("builds an otpauth uri", () => {
    expect(otpauthUri({ issuer: "Z-OUTLET", account: "a@b.c", secretBase32: "ABC" })).toBe(
      "otpauth://totp/Z-OUTLET:a%40b.c?secret=ABC&issuer=Z-OUTLET&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("lockout and recovery codes", () => {
  it("locks on the 5th failure, with doubling backoff, reset on success", () => {
    let s = FRESH_LOCK_STATE;
    for (let i = 0; i < TOTP.maxFailures - 1; i++) s = registerTotpFailure(s, 0);
    expect(isLocked(s, 0)).toBe(false);
    s = registerTotpFailure(s, 1000);
    expect(s.lockedUntilMs).toBe(1000 + 15 * 60_000);
    expect(isLocked(s, 1000)).toBe(true);
    expect(isLocked(s, 1000 + 15 * 60_000)).toBe(false);
    for (let i = 0; i < 5; i++) s = registerTotpFailure(s, 2_000_000);
    expect(s.lockedUntilMs).toBe(2_000_000 + 30 * 60_000);
    expect(registerTotpSuccess()).toEqual(FRESH_LOCK_STATE);
  });
  it("recovery codes are distinct, well formed, peppered and seller bound", () => {
    const codes = generateRecoveryCodes(rng(7));
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(RECOVERY_CODE_FORMAT);
    const pepper = utf8("pepper");
    const first = codes[0] ?? "";
    expect(hashRecoveryCode(first, "s1", pepper)).toBe(hashRecoveryCode(first.toLowerCase(), "s1", pepper));
    expect(hashRecoveryCode(first, "s1", pepper)).not.toBe(hashRecoveryCode(first, "s2", pepper));
  });
  it("step-up freshness", () => {
    expect(isRecentStrongFactor(1000, 1500, 1)).toBe(true);
    expect(isRecentStrongFactor(1000, 2001, 1)).toBe(false);
    expect(isRecentStrongFactor(null, 0, 100)).toBe(false);
    expect(isRecentStrongFactor(5000, 1000, 100)).toBe(false);
  });
});
