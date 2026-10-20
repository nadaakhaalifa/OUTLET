import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PriceLockSnapshot } from "../domain/bridge";

const Payload = z
  .object({
    u: z.string(),
    e: z.number().int(),
    t: z.string().regex(/^\d+$/),
    p: z.record(z.string(), z.string().regex(/^\d+$/)),
  })
  .strict();

const mac = (secret: string, body: string): string => createHmac("sha256", secret).update(body).digest("base64url");

/** Stateless price lock (spec 7): HMAC-signed over user, expiry, unit prices and total. */
export function signPriceLock(secret: string, lock: PriceLockSnapshot): string {
  const body = Buffer.from(
    JSON.stringify({
      u: lock.userId,
      e: lock.expiresAtMs,
      t: lock.total.toString(),
      p: Object.fromEntries([...lock.unitPrices].map(([k, v]) => [k, v.toString()])),
    }),
  ).toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

/** Null for anything malformed, forged or foreign. Expiry is judged by the domain (`lockActive`). */
export function verifyPriceLock(secret: string, token: string | null | undefined): PriceLockSnapshot | null {
  if (token === null || token === undefined || token.length > 4096) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(secret, body));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const p = Payload.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    return {
      userId: p.u,
      expiresAtMs: p.e,
      total: BigInt(p.t),
      unitPrices: new Map(Object.entries(p.p).map(([k, v]) => [k, BigInt(v)])),
    };
  } catch {
    return null;
  }
}
