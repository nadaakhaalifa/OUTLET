import { decide } from "./decide";
import type { Action, Actor, ResourceState, ResourceType, Rule } from "./types";

/**
 * Seller Center permission keys (version 1), each the result of evaluating one brand rule with
 * `decide()`. No grant is created here: a key is true only when the policy engine allows that
 * (resource, action) for this actor, the presented token scopes and the real store state.
 * `analytics.read` and `analytics.export` mirror the seller-analytics authorization exactly
 * (store_order read, store_settings read; ADR-0049 item 4).
 */
export const SELLER_PERMISSION_CHECKS = [
  ["store_product.read", "store_product", "read"],
  ["store_product.create", "store_product", "create"],
  ["store_product.update", "store_product", "update"],
  ["store_product.delete", "store_product", "delete"],
  ["store_inventory.read", "store_inventory", "read"],
  ["store_inventory.create", "store_inventory", "create"],
  ["store_inventory.update", "store_inventory", "update"],
  ["store_order.read", "store_order", "read"],
  ["store_order.update", "store_order", "update"],
  ["store_return.read", "store_return", "read"],
  ["store_return.update", "store_return", "update"],
  ["store_payout.read", "store_payout", "read"],
  ["store_settings.read", "store_settings", "read"],
  ["store_settings.update", "store_settings", "update"],
  ["store_staff.read", "store_staff", "read"],
  ["store_staff.create", "store_staff", "create"],
  ["store_staff.update", "store_staff", "update"],
  ["store_staff.delete", "store_staff", "delete"],
  ["analytics.read", "store_order", "read"],
  ["analytics.export", "store_settings", "read"],
] as const satisfies readonly (readonly [string, ResourceType, Action])[];

export type SellerPermissionKey = (typeof SELLER_PERMISSION_CHECKS)[number][0];
export type SellerPermissions = Readonly<Record<SellerPermissionKey, boolean>>;

/** Evaluates every key with `decide()` for one store. Deny by default: a missing grant yields all false. */
export function evaluateSellerPermissions(input: {
  readonly actor: Actor;
  readonly storeId: string;
  readonly state: ResourceState;
  readonly nowMs: number;
  readonly rules: readonly Rule[];
}): SellerPermissions {
  const out = {} as Record<SellerPermissionKey, boolean>;
  for (const [key, resourceType, action] of SELLER_PERMISSION_CHECKS) {
    out[key] =
      decide(
        {
          actor: input.actor,
          action,
          resourceType,
          resource: { type: resourceType, id: input.storeId, storeId: input.storeId, state: input.state },
          nowMs: input.nowMs,
        },
        input.rules,
      ).effect === "allow";
  }
  return out;
}
