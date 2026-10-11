import { z } from "zod";

/**
 * Client port for the server age gate: POST /v1/auth/age-gate {dob, device_id_hash}
 *   -> 200 {allowed:true} | 403 {blocked_until}.
 * The server is the authority: a reinstall wipes local state, so the local soft block is only a
 * fast path. No network adapter exists yet; the screens use `FakeAgeGate` in development.
 */
export interface AgeGateRequest {
  /** Civil date components as typed. Sent once, never persisted on the device. */
  readonly dob: { readonly year: number; readonly month: number; readonly day: number };
  /** SHA-256 hex of the install id. The raw install id never leaves the device. */
  readonly deviceIdHash: string;
}

export type AgeGateFailure = "network" | "unavailable" | "rate_limited";

export type AgeGateResponse =
  | { readonly ok: true; readonly allowed: true }
  | { readonly ok: true; readonly allowed: false; readonly blockedUntil: string }
  | { readonly ok: false; readonly error: AgeGateFailure };

export interface AgeGatePort {
  check(request: AgeGateRequest): Promise<AgeGateResponse>;
}

const AllowedBody = z.object({ allowed: z.literal(true) }).strict();
const BlockedBody = z.object({ blocked_until: z.iso.datetime() }).strict();

/** Boundary parser for the wire contract. Anything unexpected fails closed as `unavailable`. */
export function parseAgeGateResponse(status: number, body: unknown): AgeGateResponse {
  if (status === 200) {
    return AllowedBody.safeParse(body).success ? { ok: true, allowed: true } : { ok: false, error: "unavailable" };
  }
  if (status === 403) {
    const parsed = BlockedBody.safeParse(body);
    return parsed.success
      ? { ok: true, allowed: false, blockedUntil: parsed.data.blocked_until }
      : { ok: false, error: "unavailable" };
  }
  if (status === 429) return { ok: false, error: "rate_limited" };
  return { ok: false, error: "unavailable" };
}

export interface FakeAgeGateOptions {
  readonly clock: { now(): Date };
  readonly offline?: boolean;
  readonly blockDays?: number;
}

/**
 * Typed development fake that mimics the server rule (under 18 on the given date => 403) and
 * remembers blocked device hashes in memory like the server would. Not for release builds.
 */
export class FakeAgeGate implements AgeGatePort {
  readonly requests: AgeGateRequest[] = [];
  private readonly blocked = new Map<string, string>();

  constructor(private readonly options: FakeAgeGateOptions) {}

  async check(request: AgeGateRequest): Promise<AgeGateResponse> {
    if (this.options.offline === true) return { ok: false, error: "network" };
    this.requests.push(request);
    const now = this.options.clock.now();
    const existing = this.blocked.get(request.deviceIdHash);
    if (existing !== undefined && Date.parse(existing) > now.getTime()) {
      return { ok: true, allowed: false, blockedUntil: existing };
    }
    const { year, month, day } = request.dob;
    const eighteenth = Date.UTC(year + 18, month - 1, day);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (eighteenth > today) {
      const until = new Date(now.getTime() + (this.options.blockDays ?? 30) * 86_400_000).toISOString();
      this.blocked.set(request.deviceIdHash, until);
      return { ok: true, allowed: false, blockedUntil: until };
    }
    return { ok: true, allowed: true };
  }
}
