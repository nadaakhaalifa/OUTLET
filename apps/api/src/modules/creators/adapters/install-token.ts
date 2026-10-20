import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Server-issued install token for affiliate click ingest (phase-3 money review A-1, ADR-0037).
 *
 * `v1.<payload>.<mac>`: payload is base64url JSON `{ v, did, iat, exp, n }` where `did` is the
 * keyed click hash of the device id (never the raw id), and `mac` is HMAC-SHA-256 over the payload
 * under a key derived from the click salt (domain separated from the click hashes themselves).
 * Short lived (15 minutes). It is bound to ONE device: presenting it with another device id fails
 * `device_mismatch`. A replay inside the lifetime by the same device is harmless (it proves nothing
 * more than the first use, and clicks are deduped per device and link); after expiry it is refused.
 *
 * What this does and does not prove: the token is only ever minted for an authenticated session
 * (route `POST /v1/affiliate/install-tokens`), so a click that carries one came from a client that
 * held a live session on that device id. It does not prove the device id is genuine hardware
 * (App Attest / Play Integrity is the platform's attestation story, `attestation.app-attest` is
 * Unconfigured in production). Clicks without a valid token are stored but can never match a buyer.
 */
export const INSTALL_TOKEN_TTL_MS = 15 * 60_000;
const MAX_TOKEN_LENGTH = 512;
/** Tolerated clock skew for a token whose `iat` is slightly ahead of this node. */
const SKEW_MS = 30_000;

const b64u = (b: Buffer): string => b.toString("base64url");

const macKey = (salt: string): Buffer => createHmac("sha256", salt).update("creator-install-token-key:v1").digest();

/** Click device hash (the value stored for a signed click and matched against a buyer's devices). */
export const signedDeviceHash = (salt: string, deviceId: string): string =>
  createHmac("sha256", salt).update(`creator-click-device:${deviceId}`).digest("hex");

/**
 * Stored for a click with no valid token. Domain separated from `signedDeviceHash`, so it can never
 * equal a hash the identity port derives for a buyer's device: the click is counted (caps, analytics)
 * and is never eligible for attribution.
 */
export const unsignedDeviceHash = (salt: string, deviceId: string): string =>
  createHmac("sha256", salt).update(`creator-click-device-unsigned:${deviceId}`).digest("hex");

export function issueInstallToken(i: { readonly salt: string; readonly deviceId: string; readonly nowMs: number; readonly ttlMs?: number }): {
  readonly token: string;
  readonly expiresAtMs: number;
} {
  const ttl = i.ttlMs ?? INSTALL_TOKEN_TTL_MS;
  const exp = i.nowMs + ttl;
  const payload = b64u(
    Buffer.from(JSON.stringify({ v: 1, did: signedDeviceHash(i.salt, i.deviceId), iat: i.nowMs, exp, n: randomBytes(8).toString("hex") }), "utf8"),
  );
  const mac = b64u(createHmac("sha256", macKey(i.salt)).update(`v1.${payload}`).digest());
  return { token: `v1.${payload}.${mac}`, expiresAtMs: exp };
}

export type InstallTokenVerdict = "valid" | "absent" | "malformed" | "bad_signature" | "expired" | "not_yet_valid" | "device_mismatch";

export function verifyInstallToken(i: {
  readonly salt: string;
  readonly token: string | undefined;
  readonly deviceId: string;
  readonly nowMs: number;
}): InstallTokenVerdict {
  const t = i.token;
  if (t === undefined || t === "") return "absent";
  if (t.length > MAX_TOKEN_LENGTH) return "malformed";
  const parts = t.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return "malformed";
  const [, payload = "", mac = ""] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(mac)) return "malformed";
  const want = createHmac("sha256", macKey(i.salt)).update(`v1.${payload}`).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return "bad_signature";
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return "malformed";
  }
  if (typeof claims !== "object" || claims === null) return "malformed";
  const c = claims as Record<string, unknown>;
  if (c["v"] !== 1 || typeof c["did"] !== "string" || typeof c["iat"] !== "number" || typeof c["exp"] !== "number") return "malformed";
  if (i.nowMs >= c["exp"]) return "expired";
  if (c["iat"] > i.nowMs + SKEW_MS) return "not_yet_valid";
  const did = Buffer.from(c["did"], "utf8");
  const have = Buffer.from(signedDeviceHash(i.salt, i.deviceId), "utf8");
  if (did.length !== have.length || !timingSafeEqual(did, have)) return "device_mismatch";
  return "valid";
}
