import type { Actor } from "@outlet/policy";

/** Roles that may read the admin tax console, and roles that may change it (unchanged from the controller). */
export const TAX_READER_ROLES = ["finance", "ops", "super_admin"] as const;
export const TAX_WRITER_ROLES = ["finance", "super_admin"] as const;

/** An unexpired admin grant in one of `roles`. Standing `super_admin` counts here (no break-glass rule), as built. */
export function holdsAdminRole(actor: Actor, roles: readonly string[], nowMs: number): boolean {
  return actor.grants.some(
    (g) => g.kind === "admin" && roles.includes(g.role) && (g.expiresAtMs === undefined || g.expiresAtMs > nowMs),
  );
}

/** Why the tax admin gate denies, or null when it allows. Same order as the controller: role first, then passkey. */
export function taxAdminDenial(actor: Actor, roles: readonly string[], nowMs: number): "missing_role" | "passkey_required" | null {
  if (!holdsAdminRole(actor, roles, nowMs)) return "missing_role";
  return actor.assurance !== "passkey" ? "passkey_required" : null;
}

/** Pure predicates behind `requireAdmin(READERS)` and `requireAdmin(WRITERS)` (spec capability `tax.read`). */
export const canReadTax = (actor: Actor, nowMs: number): boolean => taxAdminDenial(actor, TAX_READER_ROLES, nowMs) === null;
export const canWriteTax = (actor: Actor, nowMs: number): boolean => taxAdminDenial(actor, TAX_WRITER_ROLES, nowMs) === null;
