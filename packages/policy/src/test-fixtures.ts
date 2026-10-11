import { createDefaultRules } from "./rules";
import type { Actor, AuthzRequest, Grant, Resource, ResourceType, Action } from "./types";

export const NOW = 1_800_000_000_000;
export const RULES = createDefaultRules({
  refundDualApprovalAtOrAboveMinor: 500_000n,
  payoutDualApprovalAtOrAboveMinor: 2_000_000n,
});

export function actor(id: string, grants: readonly Grant[], over: Partial<Actor> = {}): Actor {
  const admin = grants.some((g) => g.kind === "admin");
  return {
    id,
    status: "active",
    assurance: admin ? "passkey" : "basic",
    grants,
    tokenScopes: ["seller:read", "seller:write", "admin:access"],
    ...over,
  };
}

export function resource(type: ResourceType, over: Partial<Resource> = {}): Resource {
  return { type, id: `${type}-1`, state: "active", ...over };
}

export function req(
  a: Actor | null,
  action: Action,
  r: Resource | null,
  over: Partial<AuthzRequest> = {},
): AuthzRequest {
  return { actor: a, action, resourceType: r?.type ?? "order", resource: r, nowMs: NOW, ...over };
}

export const shopperA = actor("user-a", [{ kind: "shopper" }]);
export const shopperB = actor("user-b", [{ kind: "shopper" }]);
export const plusA = actor("user-p", [{ kind: "plus" }]);
export const sellerA = actor("staff-a", [{ kind: "brand", storeId: "store-a", role: "manager" }]);
export const sellerB = actor("staff-b", [{ kind: "brand", storeId: "store-b", role: "manager" }]);
export const financeAdmin = actor("adm-fin", [{ kind: "admin", role: "finance" }]);
export const financeAdmin2 = actor("adm-fin2", [{ kind: "admin", role: "finance" }]);
export const superAdmin = actor("adm-super", [{ kind: "admin", role: "super_admin" }]);
export const superAdmin2 = actor("adm-super2", [{ kind: "admin", role: "super_admin" }]);
