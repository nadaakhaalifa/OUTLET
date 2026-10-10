import { z } from "zod";
import type { Amr } from "./access-token";

export const attestStatusSchema = z.enum(["unknown", "verified", "failed"]);

export const deviceSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  platform: z.enum(["ios", "android"]),
  attestStatus: attestStatusSchema,
  lastSeenMs: z.number().int().nonnegative(),
});
export type Device = z.infer<typeof deviceSchema>;

export type Session = {
  readonly id: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly familyId: string;
  readonly amr: readonly Amr[];
  readonly createdAtMs: number;
  readonly lastUsedAtMs: number;
  readonly revokedAtMs: number | null;
};

export function isSessionActive(s: Session): boolean {
  return s.revokedAtMs === null;
}

export function touchSession(s: Session, nowMs: number): Session {
  return isSessionActive(s) ? { ...s, lastUsedAtMs: Math.max(s.lastUsedAtMs, nowMs) } : s;
}

export function revokeSession(s: Session, nowMs: number): Session {
  return s.revokedAtMs === null ? { ...s, revokedAtMs: nowMs } : s;
}

/** Revoking by family (reuse detection) or by user ("log out everywhere"). */
export function revokeSessions(sessions: readonly Session[], nowMs: number, predicate: (s: Session) => boolean): Session[] {
  return sessions.map((s) => (predicate(s) ? revokeSession(s, nowMs) : s));
}

/** A device may perform OTP requests only when attested (spec 1: App Attest/Play Integrity required). */
export function canRequestOtp(device: Pick<Device, "attestStatus">): boolean {
  return device.attestStatus === "verified";
}
