import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FieldCipher } from "./ports.js";

/** HMAC-SHA256 keyed by purpose, so equal inputs in different roles never collide. */
export class Hasher {
  constructor(private readonly key: Uint8Array) {
    if (key.length < 32) throw new RangeError("hmac key must be at least 32 bytes");
  }
  hmac(purpose: string, value: string): Buffer {
    return createHmac("sha256", this.key).update(`${purpose}\u0000${value}`).digest();
  }
}

export const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

export const safeEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b);

/**
 * TEST/DEV ONLY AES-256-GCM cipher: iv(12) || tag(16) || ciphertext, with the column name as AAD.
 * Refuses to construct unless OUTLET_LOCAL_CIPHER=1, so a raw in-process key can never reach production.
 * Replace with KMS envelope encryption.
 */
export class AesGcmFieldCipher implements FieldCipher {
  constructor(private readonly key: Uint8Array) {
    if (process.env.OUTLET_LOCAL_CIPHER !== "1") {
      throw new Error("AesGcmFieldCipher is local/test only: set OUTLET_LOCAL_CIPHER=1 or use the KMS-backed cipher");
    }
    if (key.length !== 32) throw new RangeError("AES-256 key must be 32 bytes");
  }
  encrypt(plaintext: string, aad: string): Promise<Uint8Array> {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Promise.resolve(Buffer.concat([iv, c.getAuthTag(), ct]));
  }
  decrypt(ciphertext: Uint8Array, aad: string): Promise<string> {
    try {
      const buf = Buffer.from(ciphertext);
      const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
      d.setAAD(Buffer.from(aad, "utf8"));
      d.setAuthTag(buf.subarray(12, 28));
      return Promise.resolve(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error("decrypt failed"));
    }
  }
}
