import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { FieldCipher } from "../domain/ports";

/**
 * AES-256-GCM field encryption plus HMAC-SHA-256 blind indexes, keyed from ONE 32 byte master key
 * delivered by the secret manager / KMS adapter (never from source or from a default). Sub-keys are
 * derived with HMAC and domain separation, so the encryption key and every blind-index key differ.
 *
 * Layout: 0x01 | iv(12) | tag(16) | ciphertext. The AAD (column name) is authenticated, so a value
 * copied into another column fails to decrypt. A per-record data key from a real KMS replaces this
 * class behind the same port (`kms.envelope`, ADR-0002); production boots with that port
 * Unconfigured (503) until then.
 */
export class LocalKeyFieldCipher implements FieldCipher {
  private readonly encKey: Buffer;

  constructor(private readonly master: Uint8Array) {
    // One master key held in process memory is acceptable only for synthetic data. Real personal
    // data (phone, DOB, email) needs the KMS-backed cipher; refuse to run this class in production
    // unless an operator explicitly acknowledges that the data is synthetic.
    if (process.env["NODE_ENV"] === "production" && process.env["ALLOW_SYNTHETIC_DATA_KEYS"] !== "true") {
      throw new Error("LocalKeyFieldCipher is for synthetic data only: configure the kms.envelope provider (or set ALLOW_SYNTHETIC_DATA_KEYS=true for a synthetic-data environment)");
    }
    if (master.length !== 32) throw new RangeError("field cipher master key must be 32 bytes");
    this.encKey = this.derive("enc:v1");
  }

  private derive(label: string): Buffer {
    return createHmac("sha256", this.master).update(`outlet-nk/field-cipher/${label}`).digest();
  }

  async encrypt(plaintext: string, aad: string): Promise<Uint8Array> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encKey, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
  }

  async decrypt(ciphertext: Uint8Array, aad: string): Promise<string> {
    const buf = Buffer.from(ciphertext);
    if (buf.length < 1 + 12 + 16 || buf[0] !== 1) throw new Error("unsupported ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", this.encKey, buf.subarray(1, 13), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(buf.subarray(13, 29));
    return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString("utf8");
  }

  async blindIndex(purpose: string, value: string): Promise<Uint8Array> {
    return createHmac("sha256", this.derive(`idx:${purpose}`)).update(value, "utf8").digest();
  }
}
