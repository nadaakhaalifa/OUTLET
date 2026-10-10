export type IdentityProvider = "phone" | "apple" | "google" | "passkey";

export type MergeParty = {
  readonly userId: string;
  readonly status: "active" | "blocked" | "pending_deletion" | "deleted";
  readonly verifiedIdentities: readonly IdentityProvider[];
  /** Identities present but not yet verified. */
  readonly unverifiedIdentities: readonly IdentityProvider[];
  readonly dobHash: string | null;
  /** Proved control in this request (fresh authentication). */
  readonly freshlyAuthenticated: boolean;
};

export type MergeViolation =
  | "same_user"
  | "user_not_active"
  | "identity_not_verified"
  | "not_freshly_authenticated"
  | "provider_conflict"
  | "dob_mismatch";

/**
 * Preconditions only (spec 1: merge Apple and phone identities only after both are verified).
 * Moving orders, wallet and consents is application logic outside this package.
 */
export function checkMergePreconditions(source: MergeParty, target: MergeParty): { ok: true } | { ok: false; violations: MergeViolation[] } {
  const v: MergeViolation[] = [];
  if (source.userId === target.userId) v.push("same_user");
  if (source.status !== "active" || target.status !== "active") v.push("user_not_active");
  if (
    source.verifiedIdentities.length === 0 || target.verifiedIdentities.length === 0 ||
    source.unverifiedIdentities.length > 0 || target.unverifiedIdentities.length > 0
  ) v.push("identity_not_verified");
  if (!source.freshlyAuthenticated || !target.freshlyAuthenticated) v.push("not_freshly_authenticated");
  const overlap = source.verifiedIdentities.some((p) => target.verifiedIdentities.includes(p));
  if (overlap) v.push("provider_conflict");
  if (source.dobHash !== null && target.dobHash !== null && source.dobHash !== target.dobHash) v.push("dob_mismatch");
  return v.length === 0 ? { ok: true } : { ok: false, violations: v };
}
