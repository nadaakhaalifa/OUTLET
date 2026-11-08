import { generateKeyPair } from "jose";
import type { SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { AesGcmFieldCipher, Hasher, SessionService, createAuthDeps, registerDevice, type SmsSender } from "../src/index.js";

export const hasher = new Hasher(new Uint8Array(32).fill(7));
export const deps = createAuthDeps({ hmacKey: new Uint8Array(32).fill(7), cipherKey: new Uint8Array(32).fill(9), cipher: new AesGcmFieldCipher(new Uint8Array(32).fill(9)) });
export const T0 = new Date("2026-11-08T10:00:00.000Z");
export const at = (ms: number): Date => new Date(T0.getTime() + ms);

export class FakeSms implements SmsSender {
  readonly provider = "fake";
  readonly sent: { phoneE164: string; code: string }[] = [];
  fail = false;
  send(m: { phoneE164: string; code: string }): Promise<void> {
    if (this.fail) return Promise.reject(new Error("down"));
    this.sent.push({ phoneE164: m.phoneE164, code: m.code });
    return Promise.resolve();
  }
  last(): string {
    const l = this.sent[this.sent.length - 1];
    if (!l) throw new Error("no sms");
    return l.code;
  }
}

export const makeSessions = async (db: SqlClient): Promise<SessionService> => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  return new SessionService(db, { issuer: "https://api.outlet.test", audience: "outlet-app", kid: "k1", privateKey, publicKey });
};

export const makeUserAndDevice = async (db: SqlClient, n = 1): Promise<{ userId: string; deviceId: string }> => {
  const deviceId = await registerDevice(db, hasher, { marketId: "EG", platform: "ios", installId: `inst-${String(n)}-${uuidv7()}`, now: T0 });
  const userId = uuidv7();
  await db.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [userId, T0.toISOString()]);
  return { userId, deviceId };
};
