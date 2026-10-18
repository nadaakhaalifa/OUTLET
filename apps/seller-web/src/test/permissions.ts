import { SELLER_PERMISSION_KEYS, type SellerPermissionKey, type SellerPermissions } from "../api/schemas-access";
import type { SellerRole } from "../api/schemas-onboarding";

/** Mirror of the server role matrix (packages/policy seller-permissions.test.ts snapshot), for view-model tests only. */
const TRUE: Record<SellerRole, readonly SellerPermissionKey[] | "all"> = {
  owner: "all",
  manager: [
    "store_product.read", "store_product.create", "store_product.update", "store_product.delete",
    "store_inventory.read", "store_inventory.create", "store_inventory.update",
    "store_order.read", "store_order.update", "store_return.read", "store_return.update",
    "store_payout.read", "store_settings.read", "store_staff.read", "analytics.read", "analytics.export",
  ],
  catalog: ["store_product.read", "store_product.create", "store_product.update", "store_product.delete", "store_inventory.read"],
  warehouse: [
    "store_product.read", "store_inventory.read", "store_inventory.create", "store_inventory.update",
    "store_order.read", "store_order.update", "store_return.read", "store_return.update", "analytics.read",
  ],
  finance: ["store_product.read", "store_order.read", "store_payout.read", "analytics.read"],
  support: ["store_product.read", "store_order.read", "store_return.read", "store_return.update", "analytics.read"],
};

export const permissionsFor = (role: SellerRole, off: readonly SellerPermissionKey[] = []): SellerPermissions => {
  const on = TRUE[role];
  return Object.fromEntries(
    SELLER_PERMISSION_KEYS.map((k) => [k, (on === "all" || on.includes(k)) && !off.includes(k)]),
  ) as SellerPermissions;
};
export const NO_PERMISSIONS = Object.fromEntries(SELLER_PERMISSION_KEYS.map((k) => [k, false])) as SellerPermissions;
