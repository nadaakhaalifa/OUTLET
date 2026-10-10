import type { Actor } from "@outlet/policy";
import { ADMIN_ROLE_NAMES, isAdminRoleName, isElevationLive, type AdminRoleName, type ElevationRecord } from "./bridge";

export interface AdminAccess {
  readonly actorId: string;
  /** Unexpired admin grants on the actor. */
  readonly standing: readonly AdminRoleName[];
  /**
   * Roles that open routes: standing roles except super_admin, plus live elevations. super_admin
   * counts only while a break-glass session (dual approved, <= 30 min) is live, so standing
   * super_admin alone grants nothing on the admin API except opening that session.
   */
  readonly effective: readonly AdminRoleName[];
  readonly breakGlassLive: boolean;
  readonly passkey: boolean;
}

export function computeAccess(actor: Actor, elevations: readonly ElevationRecord[], nowMs: number): AdminAccess {
  const standing = new Set<AdminRoleName>();
  for (const g of actor.grants) {
    if (g.kind !== "admin") continue;
    if (g.expiresAtMs !== undefined && g.expiresAtMs <= nowMs) continue;
    if (isAdminRoleName(g.role)) standing.add(g.role);
  }
  const effective = new Set<AdminRoleName>([...standing].filter((r) => r !== "super_admin"));
  let breakGlassLive = false;
  for (const e of elevations) {
    if (e.userId !== actor.id || !isElevationLive(e, nowMs)) continue;
    if (e.role === "super_admin") {
      // Break-glass only counts for a user who also holds the standing grant.
      if (standing.has("super_admin")) {
        breakGlassLive = true;
        effective.add("super_admin");
      }
    } else {
      effective.add(e.role);
    }
  }
  return {
    actorId: actor.id,
    standing: ADMIN_ROLE_NAMES.filter((r) => standing.has(r)),
    effective: ADMIN_ROLE_NAMES.filter((r) => effective.has(r)),
    breakGlassLive,
    passkey: actor.assurance === "passkey",
  };
}

export const hasAnyRole = (held: readonly AdminRoleName[], allowed: readonly AdminRoleName[]): boolean =>
  held.some((r) => allowed.includes(r));

/** Route role table. Explicit allow-lists; a role not listed is refused (deny by default). */
export const ROUTE_ROLES = {
  flagsRead: ["ops", "security", "super_admin"],
  flagsWrite: ["ops"],
  piiView: ["support", "trust_safety", "dpo"],
  kycRead: ["ops", "trust_safety", "support"],
  kycWrite: ["ops", "trust_safety"],
  kycReviewRead: ["ops", "trust_safety", "security"],
  elevationsAdmin: ["security", "super_admin"],
} as const satisfies Readonly<Record<string, readonly AdminRoleName[]>>;
