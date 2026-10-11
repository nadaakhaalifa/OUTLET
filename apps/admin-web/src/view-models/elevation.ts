import { admin } from "@outlet/domain";
import type { ElevationWire } from "../api/schemas";
import type { MessageKey } from "../i18n";
import { isReasonCode, type Role } from "./common";

export interface ElevationRow {
  readonly id: string;
  readonly role: Role;
  readonly breakGlass: boolean;
  readonly state: admin.ElevationState;
  /** LIVE means active and unexpired against the server clock; an expired ACTIVE row is shown as lapsed. */
  readonly live: boolean;
  readonly lapsed: boolean;
  readonly remainingMs: number | null;
  readonly canActivate: boolean;
  readonly canRevoke: boolean;
  readonly mine: boolean;
}

export function elevationRow(e: ElevationWire, selfId: string, nowMs: number): ElevationRow {
  const expires = e.expires_at === null ? null : Date.parse(e.expires_at);
  const live = e.state === "ACTIVE" && expires !== null && nowMs < expires;
  const mine = e.user_id === selfId;
  return {
    id: e.id,
    role: e.role,
    breakGlass: admin.isBreakGlassRole(e.role),
    state: e.state,
    live,
    lapsed: e.state === "ACTIVE" && !live,
    remainingMs: live && expires !== null ? expires - nowMs : null,
    // Activation is for the requester only, once the approval is APPROVED (server checks the approval).
    canActivate: mine && e.state === "PENDING_APPROVAL",
    canRevoke: live,
    mine,
  };
}

export interface ElevationForm {
  readonly role: string;
  readonly reasonCode: string;
  /** Empty string means "use the default window". */
  readonly ttlMinutes: string;
}

export type ElevationFormResult =
  | { readonly ok: true; readonly request: { role: Role; reason_code: admin.AdminReasonCode; ttl_minutes?: number } }
  | { readonly ok: false; readonly errors: readonly { field: "role" | "reasonCode" | "ttlMinutes"; key: MessageKey }[] };

const REASON_ERROR: Readonly<Record<string, { field: "role" | "reasonCode" | "ttlMinutes"; key: MessageKey }>> = {
  reason_code_required: { field: "reasonCode", key: "elevation.error.reasonRequired" },
  ttl_out_of_range: { field: "ttlMinutes", key: "elevation.error.ttl" },
  already_holds_role: { field: "role", key: "elevation.error.alreadyHolds" },
  break_glass_requires_super_admin: { field: "role", key: "elevation.error.breakGlassStanding" },
};

/**
 * Client-side pre-check using the domain constructors (newElevation / newBreakGlass), so a mandatory reason
 * code and TTL caps are enforced identically on both sides. The API re-validates; this only saves a round trip.
 */
export function validateElevationForm(f: ElevationForm, standingRoles: readonly Role[]): ElevationFormResult {
  const role = admin.ADMIN_ROLE_NAMES.find((r) => r === f.role);
  const errors: { field: "role" | "reasonCode" | "ttlMinutes"; key: MessageKey }[] = [];
  if (role === undefined) errors.push({ field: "role", key: "elevation.error.role" });
  if (!isReasonCode(f.reasonCode)) errors.push({ field: "reasonCode", key: "elevation.error.reasonRequired" });
  let ttlMinutes: number | null = null;
  if (f.ttlMinutes.trim() !== "") {
    if (!/^\d{1,3}$/.test(f.ttlMinutes.trim())) errors.push({ field: "ttlMinutes", key: "elevation.error.ttl" });
    else ttlMinutes = Number(f.ttlMinutes.trim());
  }
  if (errors.length > 0 || role === undefined || !isReasonCode(f.reasonCode)) return { ok: false, errors };

  const cfg = admin.DEFAULT_ELEVATION_CONFIG;
  const input = {
    id: "preview",
    userId: "preview",
    approvalId: "preview",
    reasonCode: f.reasonCode,
    ttlMs: ttlMinutes === null ? null : ttlMinutes * admin.MS_PER_MINUTE,
    heldRoles: standingRoles,
    nowMs: 0,
  };
  const r = admin.isBreakGlassRole(role)
    ? admin.newBreakGlass(input, cfg)
    : admin.newElevation({ ...input, role }, cfg);
  if (r.kind === "ok") {
    return { ok: true, request: { role, reason_code: f.reasonCode, ...(ttlMinutes === null ? {} : { ttl_minutes: ttlMinutes }) } };
  }
  const mapped = REASON_ERROR[r.reason];
  return { ok: false, errors: [mapped ?? { field: "role", key: "elevation.error.role" }] };
}
