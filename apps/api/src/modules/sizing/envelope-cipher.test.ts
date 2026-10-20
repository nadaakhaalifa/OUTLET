import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { EnvelopeFieldCipher } from "./adapters/envelope-cipher";
import { LocalTestKms } from "./test/local-test-kms";
import { CipherUnavailableError, CiphertextIntegrityError, ProfileCodec } from "./application/codec";
import { ProblemError } from "../../platform/problem";
import { unconfigured } from "../../production/unconfigured";
import type { KmsPort } from "./adapters/envelope-cipher";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("EnvelopeFieldCipher", () => {
  it("round-trips, uses a fresh data key and iv per record, and stores key id and version", async () => {
    const c = new EnvelopeFieldCipher(new LocalTestKms());
    const a = await c.encrypt(enc.encode("waist 70"), "size_profile:1:measurements");
    const b = await c.encrypt(enc.encode("waist 70"), "size_profile:1:measurements");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).includes(Buffer.from("local-test-key"))).toBe(true);
    expect(dec.decode(await c.decrypt(a, "size_profile:1:measurements"))).toBe("waist 70");
    expect(Buffer.from(a).includes(Buffer.from("waist 70"))).toBe(false);
  });

  it("AAD binds table, column and row: a copied ciphertext does not open elsewhere", async () => {
    const c = new EnvelopeFieldCipher(new LocalTestKms());
    const a = await c.encrypt(enc.encode("x"), "size_profile:1:measurements");
    await expect(c.decrypt(a, "size_profile:2:measurements")).rejects.toThrow();
    await expect(c.decrypt(a, "size_profile:1:label")).rejects.toThrow();
  });

  it("rotation: old versions still decrypt, new writes use the new version", async () => {
    const kms = new LocalTestKms();
    const c = new EnvelopeFieldCipher(kms);
    const old = await c.encrypt(enc.encode("old"), "a");
    expect(kms.rotate()).toBe(2);
    const fresh = await c.encrypt(enc.encode("new"), "a");
    expect(dec.decode(await c.decrypt(old, "a"))).toBe("old");
    expect(dec.decode(await c.decrypt(fresh, "a"))).toBe("new");
    // version u32 follows magic, len, id
    const v = (b: Uint8Array): number => Buffer.from(b).readUInt32BE(3 + "local-test-key".length);
    expect([v(old), v(fresh)]).toEqual([1, 2]);
  });

  it("tampering is detected", async () => {
    const c = new EnvelopeFieldCipher(new LocalTestKms());
    const a = Buffer.from(await c.encrypt(enc.encode("x"), "a"));
    a[a.length - 1] = (a[a.length - 1] ?? 0) ^ 1;
    await expect(c.decrypt(new Uint8Array(a), "a")).rejects.toThrow();
  });

  it("blind index is deterministic per purpose and differs across purposes", async () => {
    const c = new EnvelopeFieldCipher(new LocalTestKms());
    expect(await c.blindIndex("p", "v")).toBe(await c.blindIndex("p", "v"));
    expect(await c.blindIndex("p", "v")).not.toBe(await c.blindIndex("q", "v"));
  });

  it("an Unconfigured KMS fails closed through the codec as a 503 Problem, not a plaintext fallback", async () => {
    const codec = new ProfileCodec(new EnvelopeFieldCipher(unconfigured<KmsPort>("kms.envelope")));
    const err = await codec.seal("u1", "p1", { label: "me", measurements: null, usualSize: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect((err as ProblemError).status).toBe(503);
  });

  // Layout for keyId "local-test-key" (14 bytes): magic0 fmt1 idLen2 id3..16 ver17..20 wLen21..22 wrapped23..82 iv83..94 tag95..110 body111..
  const OFF = { fmt: 1, ver: 17, wrapped: 23, iv: 83, tag: 95 } as const;
  const sealed = async (): Promise<{ c: EnvelopeFieldCipher; ct: Buffer }> => {
    const c = new EnvelopeFieldCipher(new LocalTestKms());
    return { c, ct: Buffer.from(await c.encrypt(enc.encode("secret"), "a")) };
  };

  it("writes the format byte 0x01 after the magic", async () => {
    const { ct } = await sealed();
    expect([ct[0], ct[1]]).toEqual([0xe1, 0x01]);
  });

  it("truncated or garbage input throws bad_ciphertext at every prefix length", async () => {
    const { c, ct } = await sealed();
    for (let n = 0; n < 111; n++) {
      await expect(c.decrypt(new Uint8Array(ct.subarray(0, n)), "a")).rejects.toThrow("bad_ciphertext");
    }
    await expect(c.decrypt(new Uint8Array(), "a")).rejects.toThrow("bad_ciphertext");
    await expect(c.decrypt(new Uint8Array(64).fill(0xff), "a")).rejects.toThrow("bad_ciphertext");
    const badFmt = Buffer.from(ct);
    badFmt[OFF.fmt] = 0x02;
    await expect(c.decrypt(new Uint8Array(badFmt), "a")).rejects.toThrow("bad_ciphertext");
  });

  it("a huge declared wrapped length does not read out of bounds", async () => {
    const { c, ct } = await sealed();
    ct.writeUInt16BE(0xffff, 21);
    await expect(c.decrypt(new Uint8Array(ct), "a")).rejects.toThrow("bad_ciphertext");
  });

  it("unknown keyId and unknown keyVersion are rejected", async () => {
    const { c, ct } = await sealed();
    const v = Buffer.from(ct);
    v.writeUInt32BE(99, OFF.ver);
    await expect(c.decrypt(new Uint8Array(v), "a")).rejects.toThrow();
    const k = Buffer.from(ct);
    k[3] = (k[3] ?? 0) ^ 1; // keyId first byte
    await expect(c.decrypt(new Uint8Array(k), "a")).rejects.toThrow();
  });

  it.each([
    ["tag", OFF.tag],
    ["iv", OFF.iv],
    ["wrapped key", OFF.wrapped + 40],
    ["keyVersion", OFF.ver + 3],
  ])("tampering with the %s is detected", async (_n, at) => {
    const { c, ct } = await sealed();
    ct[at] = (ct[at] ?? 0) ^ 1;
    await expect(c.decrypt(new Uint8Array(ct), "a")).rejects.toThrow();
  });

  it("a GCM authentication failure surfaces as bad_ciphertext", async () => {
    const { c, ct } = await sealed();
    ct[OFF.tag] = (ct[OFF.tag] ?? 0) ^ 1;
    await expect(c.decrypt(new Uint8Array(ct), "a")).rejects.toThrow("bad_ciphertext");
  });

  it("decrypt with an Unconfigured KMS fails closed with a 503 Problem", async () => {
    const { ct } = await sealed();
    const c = new EnvelopeFieldCipher(unconfigured<KmsPort>("kms.envelope"));
    const err = await c.decrypt(new Uint8Array(ct), "a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect((err as ProblemError).status).toBe(503);
  });

  it("blind index of the empty value is deterministic, non-empty and distinct from a non-empty value", async () => {
    const c = new EnvelopeFieldCipher(new LocalTestKms());
    const e = await c.blindIndex("p", "");
    expect(e).toMatch(/^[0-9a-f]{64}$/);
    expect(e).toBe(await c.blindIndex("p", ""));
    expect(e).not.toBe(await c.blindIndex("p", " "));
  });

  it("property: round-trips random bytes under random AAD; a different AAD never opens", async () => {
    const c = new EnvelopeFieldCipher(new LocalTestKms());
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), fc.string(), fc.string(), async (pt, aad, other) => {
        const ct = await c.encrypt(pt, aad);
        expect(Buffer.from(await c.decrypt(ct, aad)).equals(Buffer.from(pt))).toBe(true);
        if (other !== aad) await expect(c.decrypt(ct, other)).rejects.toThrow();
      }),
      { numRuns: 60 },
    );
  });

  it("codec: AAD binds the owner, so another userId cannot open the record; corrupt bytes are an integrity error, not 503", async () => {
    const codec = new ProfileCodec(new EnvelopeFieldCipher(new LocalTestKms()));
    const s = await codec.seal("u1", "p1", { label: "me", measurements: { waist_cm: 70 }, usualSize: null });
    const base = {
      id: "p1", kind: "me" as const, fitPreference: "regular" as const, modestFit: false, version: 1, createdAtMs: 0, updatedAtMs: 0, ...s,
    };
    expect((await codec.open({ ...base, userId: "u1" })).label).toBe("me");
    // fails at the KMS unwrap (context bound there): indistinguishable from an outage, still closed
    await expect(codec.open({ ...base, userId: "u2" })).rejects.toBeInstanceOf(CipherUnavailableError);
    await expect(codec.open({ ...base, userId: "u1", labelEnc: new Uint8Array([0xe1, 1]) })).rejects.toBeInstanceOf(CiphertextIntegrityError);
  });
});
