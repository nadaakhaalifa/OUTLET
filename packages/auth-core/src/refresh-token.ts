import { sha256Hex, toHex } from "./crypto";
import { InvalidStateError } from "./errors";
import { MS, type Csprng } from "./ports";

export const REFRESH_TTL_MS = 30 * MS.day;

export type RefreshRecord = {
  readonly id: string;
  readonly tokenHash: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly status: "active" | "rotated" | "revoked";
};

/** All tokens issued from one login on one device. Stored as sessions.family_id rows. */
export type RefreshFamily = {
  readonly familyId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly records: readonly RefreshRecord[];
  readonly revokedAtMs: number | null;
  readonly revokeReason: "reuse_detected" | "device_mismatch" | "logout" | "admin" | null;
};

export function newOpaqueToken(rng: Csprng): string {
  return toHex(rng.randomBytes(32));
}

/** Only the hash is persisted (sessions.refresh_hash). */
export function hashRefreshToken(token: string): string {
  return sha256Hex(`refresh:v1:${token}`);
}

export function issueFamily(input: {
  familyId: string;
  userId: string;
  deviceId: string;
  recordId: string;
  rng: Csprng;
  nowMs: number;
}): { family: RefreshFamily; token: string } {
  const token = newOpaqueToken(input.rng);
  return {
    token,
    family: {
      familyId: input.familyId,
      userId: input.userId,
      deviceId: input.deviceId,
      revokedAtMs: null,
      revokeReason: null,
      records: [
        { id: input.recordId, tokenHash: hashRefreshToken(token), issuedAtMs: input.nowMs, expiresAtMs: input.nowMs + REFRESH_TTL_MS, status: "active" },
      ],
    },
  };
}

export type RotationResult =
  | { readonly outcome: "rotated"; readonly family: RefreshFamily; readonly token: string }
  | { readonly outcome: "reuse_detected"; readonly family: RefreshFamily; readonly notifyUser: true }
  | { readonly outcome: "device_mismatch"; readonly family: RefreshFamily; readonly notifyUser: true }
  | { readonly outcome: "expired" | "revoked" | "unknown_token"; readonly family: RefreshFamily };

export function revokeFamily(family: RefreshFamily, nowMs: number, reason: NonNullable<RefreshFamily["revokeReason"]>): RefreshFamily {
  if (family.revokedAtMs !== null) return family;
  return {
    ...family,
    revokedAtMs: nowMs,
    revokeReason: reason,
    records: family.records.map((r) => ({ ...r, status: "revoked" as const })),
  };
}

/**
 * Rotate on every use. A token that was already rotated is a reuse: the whole family is
 * revoked (the legitimate client and the thief both lose access) and the user is notified.
 * Pure: the caller loads the family by token hash, persists the result, emits `session.revoked`.
 */
export function rotateRefreshToken(input: {
  family: RefreshFamily;
  presentedToken: string;
  presentingDeviceId: string;
  newRecordId: string;
  rng: Csprng;
  nowMs: number;
}): RotationResult {
  const { family, nowMs } = input;
  if (family.revokedAtMs !== null) return { outcome: "revoked", family };

  const presentedHash = hashRefreshToken(input.presentedToken);
  const rec = family.records.find((r) => r.tokenHash === presentedHash);
  if (!rec) return { outcome: "unknown_token", family };

  if (rec.status === "rotated" || rec.status === "revoked") {
    return { outcome: "reuse_detected", family: revokeFamily(family, nowMs, "reuse_detected"), notifyUser: true };
  }
  if (input.presentingDeviceId !== family.deviceId) {
    return { outcome: "device_mismatch", family: revokeFamily(family, nowMs, "device_mismatch"), notifyUser: true };
  }
  if (nowMs >= rec.expiresAtMs) return { outcome: "expired", family };

  if (family.records.some((r) => r.id === input.newRecordId)) throw new InvalidStateError("record id already used");
  const token = newOpaqueToken(input.rng);
  const next: RefreshRecord = {
    id: input.newRecordId,
    tokenHash: hashRefreshToken(token),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + REFRESH_TTL_MS,
    status: "active",
  };
  return {
    outcome: "rotated",
    token,
    family: {
      ...family,
      records: [...family.records.map((r) => (r.id === rec.id ? { ...r, status: "rotated" as const } : r)), next],
    },
  };
}
