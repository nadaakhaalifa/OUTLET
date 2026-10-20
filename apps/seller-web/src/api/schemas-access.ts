import { z } from "zod";
import { sellerRole } from "./schemas-onboarding";

/**
 * Store-scoped `me` (dashboard foundations track 2). Permissions are the server's `decide()` outcomes;
 * the web only renders them, it never derives access from a role name.
 */
export const SELLER_PERMISSION_KEYS = [
  "store_product.read", "store_product.create", "store_product.update", "store_product.delete",
  "store_inventory.read", "store_inventory.create", "store_inventory.update",
  "store_order.read", "store_order.update", "store_return.read", "store_return.update",
  "store_payout.read", "store_settings.read", "store_settings.update",
  "store_staff.read", "store_staff.create", "store_staff.update", "store_staff.delete",
  "analytics.read", "analytics.export",
] as const;
export type SellerPermissionKey = (typeof SELLER_PERMISSION_KEYS)[number];

export const sellerPermissions = z.strictObject(
  Object.fromEntries(SELLER_PERMISSION_KEYS.map((k) => [k, z.boolean()])) as Record<SellerPermissionKey, z.ZodBoolean>,
);
export type SellerPermissions = z.infer<typeof sellerPermissions>;

export const storeStatus = z.enum(["draft", "active", "paused", "suspended"]);
export type SellerStoreStatus = z.infer<typeof storeStatus>;

export const sellerMembership = z.object({
  store_id: z.uuid(),
  role: sellerRole,
  store_status: storeStatus,
  permissions: sellerPermissions,
});
export type SellerMembership = z.infer<typeof sellerMembership>;

export const sellerStoreMe = z.object({
  user_id: z.uuid(),
  membership: sellerMembership,
  server_time: z.string(),
});
export type SellerStoreMe = z.infer<typeof sellerStoreMe>;
