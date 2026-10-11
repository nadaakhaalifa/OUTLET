import { DomainError } from "../errors";
import { defineMachine } from "../state-machine/machine";
import { approvalCovers, type ApprovalRecord } from "./approval";
import { MS_PER_HOUR, MS_PER_MINUTE, isAdminReasonCode, type AdminRoleName } from "./roles";

/**
 * Just-in-time role elevation (spec 23 Admin security). An elevation never edits a user's standing
 * grants: it is a time-boxed, reason-coded, dual-approved overlay that the console consults.
 * Elevating to super_admin is a break-glass session and has the shorter cap.
 */
export const ELEVATION_STATES = ["PENDING_APPROVAL", "ACTIVE", "DENIED", "REVOKED", "EXPIRED"] as const;
export type ElevationState = (typeof ELEVATION_STATES)[number];
export const ELEVATION_EVENTS = ["ACTIVATE", "DENY", "REVOKE", "LAPSE"] as const;
export type ElevationEvent = (typeof ELEVATION_EVENTS)[number];

export const elevationMachine = defineMachine<ElevationState, ElevationEvent>({
  name: "AdminElevation",
  states: ELEVATION_STATES,
  events: ELEVATION_EVENTS,
  initial: "PENDING_APPROVAL",
  terminal: ["DENIED", "REVOKED", "EXPIRED"],
  transitions: {
    PENDING_APPROVAL: { ACTIVATE: { to: "ACTIVE" }, DENY: { to: "DENIED" }, LAPSE: { to: "EXPIRED" } },
    ACTIVE: { REVOKE: { to: "REVOKED" }, LAPSE: { to: "EXPIRED" } },
    DENIED: {},
    REVOKED: {},
    EXPIRED: {},
  },
});

export interface ElevationConfig {
  readonly defaultTtlMs: number;
  readonly maxTtlMs: number;
  readonly breakGlassMaxTtlMs: number;
}

export const DEFAULT_ELEVATION_CONFIG: ElevationConfig = {
  defaultTtlMs: MS_PER_HOUR,
  maxTtlMs: 4 * MS_PER_HOUR,
  breakGlassMaxTtlMs: 30 * MS_PER_MINUTE,
};

export class InvalidElevationError extends DomainError {}

export interface ElevationRecord {
  readonly id: string;
  readonly userId: string;
  readonly role: AdminRoleName;
  readonly reasonCode: string;
  readonly approvalId: string;
  readonly requestedTtlMs: number;
  readonly state: ElevationState;
  readonly requestedAtMs: number;
  readonly activatedAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly revokedBy: string | null;
}

export const isBreakGlassRole = (role: AdminRoleName): boolean => role === "super_admin";

export function ttlCapMs(role: AdminRoleName, cfg: ElevationConfig): number {
  return isBreakGlassRole(role) ? cfg.breakGlassMaxTtlMs : cfg.maxTtlMs;
}

export type NewElevationResult =
  | { readonly kind: "ok"; readonly record: ElevationRecord }
  | { readonly kind: "invalid"; readonly reason: "reason_code_required" | "ttl_out_of_range" | "already_holds_role" | "break_glass_requires_super_admin" };

export function newElevation(
  input: {
    readonly id: string;
    readonly userId: string;
    readonly role: AdminRoleName;
    readonly reasonCode: string;
    readonly approvalId: string;
    readonly ttlMs: number | null;
    readonly heldRoles: readonly AdminRoleName[];
    readonly nowMs: number;
  },
  cfg: ElevationConfig,
): NewElevationResult {
  if (!isAdminReasonCode(input.reasonCode)) return { kind: "invalid", reason: "reason_code_required" };
  const ttl = input.ttlMs ?? Math.min(cfg.defaultTtlMs, ttlCapMs(input.role, cfg));
  if (!Number.isSafeInteger(ttl) || ttl < MS_PER_MINUTE || ttl > ttlCapMs(input.role, cfg)) {
    return { kind: "invalid", reason: "ttl_out_of_range" };
  }
  if (input.heldRoles.includes(input.role)) return { kind: "invalid", reason: "already_holds_role" };
  // Break-glass is only for people who already hold super_admin standing. Since they do, the
  // "already holds role" rule above would reject them; break-glass is therefore keyed on the
  // standing grant instead, see newBreakGlass.
  if (isBreakGlassRole(input.role)) return { kind: "invalid", reason: "break_glass_requires_super_admin" };
  return {
    kind: "ok",
    record: baseRecord(input, ttl),
  };
}

/** Break-glass: a super_admin (standing grant) opens a short, dual-approved emergency session. */
export function newBreakGlass(
  input: {
    readonly id: string;
    readonly userId: string;
    readonly reasonCode: string;
    readonly approvalId: string;
    readonly ttlMs: number | null;
    readonly heldRoles: readonly AdminRoleName[];
    readonly nowMs: number;
  },
  cfg: ElevationConfig,
): NewElevationResult {
  if (!isAdminReasonCode(input.reasonCode)) return { kind: "invalid", reason: "reason_code_required" };
  if (!input.heldRoles.includes("super_admin")) return { kind: "invalid", reason: "break_glass_requires_super_admin" };
  const ttl = input.ttlMs ?? cfg.breakGlassMaxTtlMs;
  if (!Number.isSafeInteger(ttl) || ttl < MS_PER_MINUTE || ttl > cfg.breakGlassMaxTtlMs) {
    return { kind: "invalid", reason: "ttl_out_of_range" };
  }
  return { kind: "ok", record: baseRecord({ ...input, role: "super_admin" }, ttl) };
}

function baseRecord(
  input: { id: string; userId: string; role: AdminRoleName; reasonCode: string; approvalId: string; nowMs: number },
  ttl: number,
): ElevationRecord {
  return {
    id: input.id,
    userId: input.userId,
    role: input.role,
    reasonCode: input.reasonCode,
    approvalId: input.approvalId,
    requestedTtlMs: ttl,
    state: elevationMachine.initial,
    requestedAtMs: input.nowMs,
    activatedAtMs: null,
    expiresAtMs: null,
    revokedAtMs: null,
    revokedBy: null,
  };
}

export type ActivateResult =
  | { readonly kind: "activated"; readonly record: ElevationRecord }
  | { readonly kind: "denied"; readonly reason: "not_pending" | "not_requester" | "approval_missing" | "approval_not_approved" | "approval_expired" };

/**
 * Only the requester can activate, and only against an APPROVED, unexpired approval of the right
 * kind for this very elevation. The elevation window starts now, not at approval time.
 */
export function activateElevation(
  e: ElevationRecord,
  approval: ApprovalRecord | null,
  actorId: string,
  nowMs: number,
): ActivateResult {
  if (e.state !== "PENDING_APPROVAL") return { kind: "denied", reason: "not_pending" };
  if (actorId !== e.userId) return { kind: "denied", reason: "not_requester" };
  if (approval === null || approval.id !== e.approvalId) return { kind: "denied", reason: "approval_missing" };
  if (nowMs >= approval.expiresAtMs) return { kind: "denied", reason: "approval_expired" };
  const kind = isBreakGlassRole(e.role) ? "break_glass" : "role_elevation";
  if (
    !approvalCovers(
      approval,
      { kind, subjectType: "elevation", subjectId: e.id, amountMinor: null },
      nowMs,
    ) ||
    approval.requesterId !== e.userId
  ) {
    return { kind: "denied", reason: "approval_not_approved" };
  }
  return {
    kind: "activated",
    record: {
      ...e,
      state: elevationMachine.transition(e.state, "ACTIVATE"),
      activatedAtMs: nowMs,
      expiresAtMs: nowMs + e.requestedTtlMs,
    },
  };
}

export function revokeElevation(e: ElevationRecord, byUserId: string, nowMs: number): ElevationRecord {
  return {
    ...e,
    state: elevationMachine.transition(e.state, "REVOKE"),
    revokedAtMs: nowMs,
    revokedBy: byUserId,
  };
}

/** Withdraws a not-yet-activated elevation (PENDING_APPROVAL -> DENIED). Activation is refused afterwards. */
export function withdrawElevation(e: ElevationRecord, byUserId: string, nowMs: number): ElevationRecord {
  return {
    ...e,
    state: elevationMachine.transition(e.state, "DENY"),
    revokedAtMs: nowMs,
    revokedBy: byUserId,
  };
}

/** True while the overlay grants its role. Expiry is exclusive and checked on every use. */
export function isElevationLive(e: ElevationRecord, nowMs: number): boolean {
  return e.state === "ACTIVE" && e.expiresAtMs !== null && nowMs < e.expiresAtMs;
}

export function effectiveRoles(
  standing: readonly AdminRoleName[],
  elevations: readonly ElevationRecord[],
  nowMs: number,
): readonly AdminRoleName[] {
  const out = new Set<AdminRoleName>(standing);
  for (const e of elevations) if (isElevationLive(e, nowMs)) out.add(e.role);
  return [...out];
}
