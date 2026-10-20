import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProviderNotConfiguredError, unconfigured } from "../../../production/unconfigured";
import type { FieldCipher } from "../domain/ports";
import { LocalKeyFieldCipher } from "./field-cipher";
import { UnconfiguredOtpSender } from "./otp-senders";

const c = new LocalKeyFieldCipher(new Uint8Array(randomBytes(32)));

describe("LocalKeyFieldCipher", () => {
  it("round trips, uses a fresh IV, and binds the ciphertext to its column", async () => {
    const a = await c.encrypt("+201001234567", "identities.subject");
    const b = await c.encrypt("+201001234567", "identities.subject");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).toString("latin1")).not.toContain("1001234567");
    expect(await c.decrypt(a, "identities.subject")).toBe("+201001234567");
    await expect(c.decrypt(a, "users.dob")).rejects.toThrow();
  });

  it("rejects tampered or truncated ciphertext and unsupported versions", async () => {
    const a = Buffer.from(await c.encrypt("1990-01-01", "users.dob"));
    const flipped = Buffer.from(a);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    await expect(c.decrypt(flipped, "users.dob")).rejects.toThrow();
    await expect(c.decrypt(a.subarray(0, 20), "users.dob")).rejects.toThrow();
    const v2 = Buffer.from(a);
    v2[0] = 2;
    await expect(c.decrypt(v2, "users.dob")).rejects.toThrow();
    await expect(new LocalKeyFieldCipher(new Uint8Array(randomBytes(32))).decrypt(a, "users.dob")).rejects.toThrow();
  });

  it("blind indexes are deterministic, keyed and domain separated", async () => {
    const x = await c.blindIndex("phone", "+201001234567");
    expect(Buffer.from(x).equals(Buffer.from(await c.blindIndex("phone", "+201001234567")))).toBe(true);
    expect(Buffer.from(x).equals(Buffer.from(await c.blindIndex("otp-device", "+201001234567")))).toBe(false);
    expect(Buffer.from(x).equals(Buffer.from(await new LocalKeyFieldCipher(new Uint8Array(randomBytes(32))).blindIndex("phone", "+201001234567")))).toBe(false);
    expect(x).toHaveLength(32);
  });

  it("requires a 32 byte master key", () => {
    expect(() => new LocalKeyFieldCipher(new Uint8Array(16))).toThrow(RangeError);
  });
});

describe("Unconfigured providers fail closed", () => {
  it("the KMS port throws provider_not_configured on every operation", async () => {
    const k = unconfigured<FieldCipher>("kms.envelope");
    // The Unconfigured proxy throws at call time; inside the async store methods that is a rejection.
    expect(() => k.encrypt("x", "a")).toThrow(ProviderNotConfiguredError);
    expect(() => k.decrypt(new Uint8Array(1), "a")).toThrow(ProviderNotConfiguredError);
    expect(() => k.blindIndex("p", "v")).toThrow(ProviderNotConfiguredError);
  });

  it("the unconfigured SMS sender sends nothing and says why", async () => {
    expect(await new UnconfiguredOtpSender("sms").send()).toEqual({ ok: false, retryable: false, reason: "provider_not_configured" });
  });
});
