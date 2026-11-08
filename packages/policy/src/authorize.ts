import { ADMIN_POLICY, ALWAYS_DUAL_APPROVAL, AMOUNT_DUAL_APPROVAL, PUBLIC_ACTIONS, SELLER_POLICY, SHOPPER_ACTIONS, SUPER_ADMIN_ACTIONS } from "./policies.js";
import type { Action, Decision, Principal, Resource } from "./types.js";

const ALLOW: Decision = { effect: "allow" };
const NOT_FOUND: Decision = { effect: "deny", reason: "not_found" };
const FORBIDDEN: Decision = { effect: "deny", reason: "forbidden" };

const grants = (table: Readonly<Record<string, readonly Action[]>>, roles: readonly string[], action: Action): boolean =>
  roles.some((r) => Object.hasOwn(table, r) && (table[r] ?? []).includes(action));

const kindCanEver = (kind: Principal["kind"], action: Action): boolean => {
  switch (kind) {
    case "anonymous":
      return PUBLIC_ACTIONS.includes(action);
    case "shopper":
      return SHOPPER_ACTIONS.includes(action);
    case "seller_staff":
      return Object.values(SELLER_POLICY).some((a) => a.includes(action));
    case "admin":
      return Object.values(ADMIN_POLICY).some((a) => a.includes(action));
    case "system":
      return true;
  }
};

/**
 * Pure, deny-by-default authorization.
 * Order: market -> (BFLA) action is possible for this kind -> tenant/ownership -> role.
 * A foreign or missing object is `not_found` (404) so existence never leaks;
 * the right tenant with the wrong role is `forbidden` (403).
 * System principals need the exact action in `scopes` (scopes do not narrow other kinds).
 */
export const authorize = (principal: Principal, action: Action, resource: Resource): Decision => {
  if (principal.marketId !== resource.marketId) return NOT_FOUND;

  if (principal.kind === "anonymous") {
    return PUBLIC_ACTIONS.includes(action) && resource.ownerUserId === undefined ? ALLOW : NOT_FOUND;
  }
  if (!kindCanEver(principal.kind, action)) return FORBIDDEN;

  switch (principal.kind) {
    case "system":
      return principal.scopes.includes(action) ? ALLOW : FORBIDDEN;
    case "shopper":
      if (PUBLIC_ACTIONS.includes(action) && resource.ownerUserId === undefined) return ALLOW;
      return principal.userId !== undefined && resource.ownerUserId === principal.userId ? ALLOW : NOT_FOUND;
    case "seller_staff":
      if (resource.storeId === undefined || !(principal.storeIds ?? []).includes(resource.storeId)) return NOT_FOUND;
      return grants(SELLER_POLICY, principal.roles, action) ? ALLOW : FORBIDDEN;
    case "admin":
      // super_admin is break-glass only: without breakGlass === true the role grants nothing.
      return grants(ADMIN_POLICY, principal.breakGlass === true ? principal.roles : principal.roles.filter((r) => r !== "super_admin"), action)
        ? ALLOW
        : FORBIDDEN;
  }
};

export interface DualApprovalConfig {
  /** Piastres; payout/refund approvals at or above this need a second approver. */
  readonly thresholdMinor: bigint;
}

/**
 * Missing or negative amount on an amount-gated action fails safe (dual approval required).
 * When the acting principal holds super_admin, every super_admin action needs dual approval regardless of amount.
 */
export const dualApprovalRequired = (
  action: Action,
  config: DualApprovalConfig,
  amountMinor?: bigint,
  principal?: Pick<Principal, "roles">,
): boolean => {
  if (ALWAYS_DUAL_APPROVAL.includes(action)) return true;
  if (principal?.roles.includes("super_admin") === true && SUPER_ADMIN_ACTIONS.includes(action)) return true;
  if (AMOUNT_DUAL_APPROVAL.includes(action)) return amountMinor === undefined || amountMinor < 0n || amountMinor >= config.thresholdMinor;
  return false;
};
