import type { Actor } from "@outlet/policy";

/** Why the DPO console gate denies, or null when it allows: an unexpired `dpo` admin grant and a passkey session. */
export function dpoConsoleDenial(actor: Actor, nowMs: number): "missing_role" | "passkey_required" | null {
  const hasRole = actor.grants.some(
    (g) => g.kind === "admin" && g.role === "dpo" && (g.expiresAtMs === undefined || g.expiresAtMs > nowMs),
  );
  if (!hasRole) return "missing_role";
  return actor.assurance !== "passkey" ? "passkey_required" : null;
}

/** Pure predicate behind `DpoPrivacyController.requireDpo` (spec capability `privacy.read`). */
export const canReadPrivacyConsole = (actor: Actor, nowMs: number): boolean => dpoConsoleDenial(actor, nowMs) === null;
