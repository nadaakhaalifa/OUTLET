import { SELLER_POLICY, SELLER_ROLES } from "@outlet/policy";
import type { Action } from "@outlet/policy";

export type SellerRole = (typeof SELLER_ROLES)[number];

/**
 * Master prompt 19 Seller Center features mapped to the @outlet/policy action that guards them. The role matrix itself
 * lives only in @outlet/policy (SELLER_POLICY); nothing here grants anything.
 */
export const SELLER_FEATURES = {
  storefront: "store.write",
  team: "team.manage",
  catalog: "listing.write",
  orders: "order.read",
  fulfilment: "order.fulfill",
  returns: "return.inspect",
  promotions: "promotion.write",
  payouts: "payout.read",
  statements: "statement.read",
  customer_messages: "customer_message.write",
} as const satisfies Record<string, Action>;
export type SellerFeature = keyof typeof SELLER_FEATURES;

/** Roles that may perform the action, in SELLER_ROLES order (owner first). Unknown action: empty. */
export const requiredRoleFor = (action: Action): readonly SellerRole[] => SELLER_ROLES.filter((r) => SELLER_POLICY[r].includes(action));

export const requiredRoleForFeature = (feature: SellerFeature): readonly SellerRole[] => requiredRoleFor(SELLER_FEATURES[feature]);

export const roleCan = (role: SellerRole, action: Action): boolean => SELLER_POLICY[role].includes(action);

export const isSellerRole = (v: string): v is SellerRole => (SELLER_ROLES as readonly string[]).includes(v);

/** Order states in which seller staff may see the buyer's delivery PII (B1: only what is needed, only while the order is live). */
const LIVE_ORDER_STATES: readonly string[] = [
  "PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERY_FAILED",
  "RETURN_REQUESTED", "RETURN_PICKUP_SCHEDULED", "RETURN_IN_TRANSIT", "RETURN_RECEIVED", "RETURN_INSPECTED", "DISPUTED",
];

/**
 * Buyer PII (name, phone, address) is visible to seller staff only while the order is live, and for 30 days after
 * delivery or return closure (master prompt B1). `sellerAccessUntil` is the DB value (delivered_at / return closure + 30 days, stored on the order); the 30-day rule lives where it is written, not here.
 */
export const buyerPiiVisible = (input: { readonly orderState: string; readonly sellerAccessUntil?: Date | null; readonly now: Date }): boolean => {
  if (LIVE_ORDER_STATES.includes(input.orderState)) return true;
  if (input.sellerAccessUntil == null) return false;
  return input.now.getTime() <= input.sellerAccessUntil.getTime();
};
