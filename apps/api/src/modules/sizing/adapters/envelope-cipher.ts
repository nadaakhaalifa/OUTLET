import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { FieldCipherPort } from "../domain/ports";

/**
 * KMS port (spec T5, ADR-0002). The KMS never sees plaintext fields: it wraps and unwraps 32-byte
 * data keys under a master key it manages, and computes blind-index HMACs. `context` is the AAD of
 * the field (table:column:row id) and MUST be bound into the wrap as the KMS encryption context.
 * Production binds an UNCONFIGURED implementation until a KMS contract exists (every call 503s).
 */
export interface KmsPort {
  /** Wraps `dek` under the CURRENT master key. */
  wrapKey(dek: Uint8Array, context: string): Promise<{ readonly keyId: string; readonly keyVersion: number; readonly wrapped: Uint8Array }>;
  /** Unwraps under the exact (keyId, keyVersion) that wrapped it, so old versions still decrypt after rotation. */
  unwrapKey(input: { keyId: string; keyVersion: number; wrapped: Uint8Array; context: string }): Promise<Uint8Array>;
  /** HMAC-SHA-256 under a KMS-held key for blind indexes. `purpose` separates index domains. */
  hmac(purpose: string, data: Uint8Array): Promise<Uint8Array>;
}

const MAGIC = 0xe1;
/** Format/algorithm byte: 0x01 = AES-256-GCM, 12-byte IV, 16-byte tag. */
const FORMAT_AES256GCM = 0x01;
const enc = new TextEncoder();

/**
 * Per-record envelope encryption. Each call draws a fresh AES-256-GCM data key, encrypts the field
 * with AAD = `aad` (binds table, column and row id), and stores the KMS-wrapped data key plus
 * key id and version next to the ciphertext. Layout:
 * magic(1) | format(1) | keyIdLen(1) | keyId | keyVersion(u32) | wrappedLen(u16) | wrapped | iv(12) | tag(16) | body.
 */
export class EnvelopeFieldCipher implements FieldCipherPort {
  constructor(private readonly kms: KmsPort) {}

  async encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
    const dek = randomBytes(32);
    try {
      const w = await this.kms.wrapKey(dek, aad);
      const keyId = Buffer.from(w.keyId, "utf8");
      if (keyId.length === 0 || keyId.length > 255 || w.wrapped.length > 0xffff) throw new Error("bad_kms_response");
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", dek, iv);
      c.setAAD(Buffer.from(aad, "utf8"));
      const body = Buffer.concat([c.update(plaintext), c.final()]);
      const head = Buffer.alloc(3 + keyId.length + 4 + 2);
      head[0] = MAGIC;
      head[1] = FORMAT_AES256GCM;
      head[2] = keyId.length;
      keyId.copy(head, 3);
      head.writeUInt32BE(w.keyVersion, 3 + keyId.length);
      head.writeUInt16BE(w.wrapped.length, 7 + keyId.length);
      return new Uint8Array(Buffer.concat([head, w.wrapped, iv, c.getAuthTag(), body]));
    } finally {
      dek.fill(0);
    }
  }

  async decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array> {
    const b = Buffer.from(ciphertext);
    if (b.length < 3 || b[0] !== MAGIC || b[1] !== FORMAT_AES256GCM) throw new Error("bad_ciphertext");
    const idLen = b[2] ?? 0;
    // header after keyId: keyVersion(4) + wrappedLen(2)
    if (idLen === 0 || b.length < 3 + idLen + 6) throw new Error("bad_ciphertext");
    let o = 3;
    const keyId = b.subarray(o, o + idLen).toString("utf8");
    o += idLen;
    const keyVersion = b.readUInt32BE(o);
    o += 4;
    const wLen = b.readUInt16BE(o);
    o += 2;
    // wrapped + iv(12) + tag(16)
    if (b.length < o + wLen + 28) throw new Error("bad_ciphertext");
    const wrapped = new Uint8Array(b.subarray(o, o + wLen));
    o += wLen;
    const iv = b.subarray(o, o + 12);
    const tag = b.subarray(o + 12, o + 28);
    const body = b.subarray(o + 28);
    const unwrapped = await this.kms.unwrapKey({ keyId, keyVersion, wrapped, context: aad });
    const dek = Buffer.from(unwrapped);
    try {
      if (dek.length !== 32) throw new Error("bad_ciphertext");
      const d = createDecipheriv("aes-256-gcm", dek, iv, { authTagLength: 16 });
      d.setAAD(Buffer.from(aad, "utf8"));
      d.setAuthTag(tag);
      try {
        return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
      } catch {
        throw new Error("bad_ciphertext");
      }
    } finally {
      dek.fill(0);
      unwrapped.fill(0);
    }
  }

  /** Blind index for equality lookups; the HMAC key never leaves the KMS. */
  async blindIndex(purpose: string, value: string): Promise<string> {
    return Buffer.from(await this.kms.hmac(purpose, enc.encode(value))).toString("hex");
  }
}
