import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { KmsPort } from "../adapters/envelope-cipher";

/**
 * TEST/DEV ONLY in-process KMS with versioned master keys, to exercise rotation. Never composed in
 * production (see production-cipher.test.ts).
 */
export class LocalTestKms implements KmsPort {
  private readonly keys = new Map<number, Buffer>([[1, randomBytes(32)]]);
  private current = 1;
  readonly keyId = "local-test-key";
  rotate(): number {
    this.current += 1;
    this.keys.set(this.current, randomBytes(32));
    return this.current;
  }
  async wrapKey(dek: Uint8Array, context: string) {
    const k = this.keys.get(this.current);
    if (k === undefined) throw new Error("no key");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", k, iv);
    c.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([c.update(dek), c.final()]);
    return { keyId: this.keyId, keyVersion: this.current, wrapped: new Uint8Array(Buffer.concat([iv, c.getAuthTag(), body])) };
  }
  async unwrapKey(i: { keyId: string; keyVersion: number; wrapped: Uint8Array; context: string }) {
    const k = this.keys.get(i.keyVersion);
    if (k === undefined || i.keyId !== this.keyId) throw new Error("unknown key");
    const b = Buffer.from(i.wrapped);
    const d = createDecipheriv("aes-256-gcm", k, b.subarray(0, 12));
    d.setAAD(Buffer.from(i.context, "utf8"));
    d.setAuthTag(b.subarray(12, 28));
    return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()]));
  }
  async hmac(purpose: string, data: Uint8Array) {
    const k = this.keys.get(1);
    if (k === undefined) throw new Error("no key");
    return new Uint8Array(createHmac("sha256", k).update(purpose).update("\0").update(data).digest());
  }
}
