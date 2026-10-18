import { createHmac } from "node:crypto";

/**
 * Server-held-salt hashing for click ingest (phase-3 money review A-1). The salt never leaves the
 * server, so stored click hashes cannot be precomputed from a leaked or guessed device id and
 * cannot be correlated with hashes of the same id elsewhere in the platform.
 *
 * Click ingest now requires a server-issued signed install token (`install-token.ts`) for a click to
 * hash into this domain. A click without a valid token is stored under a separate, domain-separated
 * hash (`unsignedDeviceHash`) that can never equal a buyer's device hash, so it is counted and never
 * attributed. RESIDUAL RISK: a holder of a live session who knows another device's id can still mint
 * a token for that id; per-user issuance limits, per-device caps, dedupe, the protected window after
 * a first-party session start (selectLastClick) and the fraud gate bound the damage. Closing it
 * fully needs App Attest / Play Integrity on the issuing route (Unconfigured in production).
 */
export const clickDeviceHash = (salt: string, deviceId: string): string =>
  createHmac("sha256", salt).update(`creator-click-device:${deviceId}`).digest("hex");

/** IPv6 addresses collapse to their /64 so a rotating suffix does not mint new identities. */
export function normalizeIp(ip: string): string {
  if (!ip.includes(":") || ip.toLowerCase().startsWith("::ffff:")) return ip.toLowerCase().replace(/^::ffff:/, "");
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const h = head === "" ? [] : head.split(":");
  const t = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

export const clickIpHash = (salt: string, ip: string): string =>
  createHmac("sha256", salt).update(`creator-click-ip:${normalizeIp(ip)}`).digest("hex");
