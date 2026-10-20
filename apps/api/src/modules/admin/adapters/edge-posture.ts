import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { IpAllowlistSource } from "../domain/me";

/** Single-use replay set for `(kid, request_id)`; production is Redis `SET NX EX 180`. Throwing means unavailable (fail closed). */
export interface EdgeReplayStore {
  claim(kid: string, requestId: string, ttlSeconds: number): Promise<boolean>;
}

/** Fail closed default: nothing can be claimed, so every header is `invalid`. */
export class UnconfiguredEdgeReplayStore implements EdgeReplayStore {
  claim(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

export class InMemoryEdgeReplayStore implements EdgeReplayStore {
  private readonly seen = new Set<string>();
  claim(kid: string, requestId: string): Promise<boolean> {
    const k = `${kid}\u0000${requestId}`;
    if (this.seen.has(k)) return Promise.resolve(false);
    this.seen.add(k);
    return Promise.resolve(true);
  }
}

/** `ADMIN_EDGE_POSTURE_KEYS`: kid -> key bytes; at most two active kids so a rotation overlaps. */
export type EdgePostureKeys = ReadonlyMap<string, Uint8Array>;
export const MAX_ACTIVE_EDGE_KIDS = 2;
export const MIN_EDGE_KEY_BYTES = 32;
export const EDGE_POSTURE_MAX_SKEW_MS = 60_000;
export const EDGE_POSTURE_REPLAY_TTL_S = 180;

const Payload = z
  .strictObject({
    v: z.literal(1),
    kid: z.string().min(1).max(64),
    ip_allowlisted: z.boolean(),
    /** Epoch milliseconds at the edge. */
    ts: z.number().int().nonnegative(),
    request_id: z.string().min(1).max(128),
  });

const B64URL = /^[A-Za-z0-9_-]+$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;

export interface EdgePostureResult {
  readonly allowlisted: boolean;
  readonly source: IpAllowlistSource;
}
const NOT_CONFIGURED: EdgePostureResult = { allowlisted: false, source: "not_configured" };
const INVALID: EdgePostureResult = { allowlisted: false, source: "invalid" };

export async function verifyEdgePosture(i: {
  readonly header: string | undefined;
  readonly keys: EdgePostureKeys;
  readonly requestId: string;
  readonly nowMs: number;
  readonly replay: EdgeReplayStore;
}): Promise<EdgePostureResult> {
  if (i.keys.size === 0 || i.header === undefined || i.header === "") return NOT_CONFIGURED;
  const parts = i.header.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return INVALID;
  const [, kid, payloadB64, macB64] = parts as [string, string, string, string];
  if (!KID.test(kid) || !B64URL.test(payloadB64) || !B64URL.test(macB64)) return INVALID;
  const key = i.keys.get(kid);
  if (key === undefined) return INVALID;
  const payloadBytes = Buffer.from(payloadB64, "base64url");
  const given = Buffer.from(macB64, "base64url");
  const expected = createHmac("sha256", key).update(payloadBytes).digest();
  // Length mismatch is rejected without comparing (timingSafeEqual would throw).
  if (given.length !== expected.length) return INVALID;
  if (!timingSafeEqual(given, expected)) return INVALID;
  let json: unknown;
  try {
    json = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return INVALID;
  }
  const p = Payload.safeParse(json);
  if (!p.success) return INVALID;
  if (p.data.kid !== kid) return INVALID;
  if (Math.abs(i.nowMs - p.data.ts) > EDGE_POSTURE_MAX_SKEW_MS) return INVALID;
  if (p.data.request_id !== i.requestId) return INVALID;
  let fresh: boolean;
  try {
    fresh = await i.replay.claim(kid, p.data.request_id, EDGE_POSTURE_REPLAY_TTL_S);
  } catch {
    return INVALID;
  }
  if (!fresh) return INVALID;
  return { allowlisted: p.data.ip_allowlisted, source: "edge_attested" };
}

/** Test and edge helper: builds a header the verifier accepts. */
export function signEdgePosture(key: Uint8Array, payload: { kid: string; ip_allowlisted: boolean; ts: number; request_id: string }): string {
  const bytes = Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8");
  const mac = createHmac("sha256", key).update(bytes).digest();
  return `v1.${payload.kid}.${bytes.toString("base64url")}.${mac.toString("base64url")}`;
}
