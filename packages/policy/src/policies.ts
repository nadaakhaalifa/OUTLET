import type { Action } from "./types.js";

/** Bump on any change to the tables below; recorded in audit entries. */
export const POLICY_VERSION = 1;

export const SELLER_ROLES = ["owner", "manager", "catalog", "warehouse", "finance", "support"] as const;
export const ADMIN_ROLES = ["ops", "finance", "trust_safety", "support", "marketing", "dpo", "security", "super_admin"] as const;

/** Actions any anonymous caller may perform (public catalog only). */
export const PUBLIC_ACTIONS: readonly Action[] = ["catalog.read", "store.read"];

/** Shopper actions, always limited to the shopper's own resources. */
export const SHOPPER_ACTIONS: readonly Action[] = [
  "catalog.read", "store.read", "cart.read", "cart.write", "order.read", "order.cancel", "return.create",
  "return.read", "wishlist.read", "wishlist.write", "address.read", "address.write", "privacy.export", "privacy.delete",
];

/** Seller role -> actions, scoped to the principal's stores. */
export const SELLER_POLICY: Readonly<Record<(typeof SELLER_ROLES)[number], readonly Action[]>> = {
  owner: [
    "store.read", "store.write", "team.manage", "listing.read", "listing.write", "order.read", "order.fulfill",
    "return.read", "return.inspect", "payout.read", "statement.read", "promotion.write", "customer_message.read", "customer_message.write",
  ],
  manager: [
    "store.read", "listing.read", "listing.write", "order.read", "order.fulfill", "return.read", "return.inspect",
    "promotion.write", "customer_message.read", "customer_message.write",
  ],
  catalog: ["store.read", "listing.read", "listing.write", "promotion.write"],
  warehouse: ["listing.read", "order.read", "order.fulfill", "return.read", "return.inspect"],
  finance: ["store.read", "order.read", "payout.read", "statement.read"],
  support: ["order.read", "return.read", "customer_message.read", "customer_message.write"],
};

/** Admin role -> actions, market scoped. */
export const ADMIN_POLICY: Readonly<Record<(typeof ADMIN_ROLES)[number], readonly Action[]>> = {
  ops: ["store.read", "store.suspend", "listing.read", "order.read", "return.read", "return.decide", "seller_kyc.review"],
  finance: ["order.read", "payout.read", "payout.approve", "refund.approve", "statement.read", "ledger.read"],
  trust_safety: ["store.read", "store.suspend", "listing.read", "listing.takedown", "return.read", "dispute.decide", "seller_kyc.review"],
  support: ["order.read", "return.read", "user.read", "customer_message.read", "customer_message.write"],
  marketing: ["promotion.write", "catalog.read", "plan.price.change"],
  dpo: ["user.read", "privacy.export", "privacy.delete", "data.export", "breach.manage"],
  security: ["audit.read", "role.grant", "session.revoke"],
  super_admin: ["role.grant", "plan.price.change", "data.export", "payout.approve", "refund.approve", "audit.read"],
};

/** Actions that always need a second approver regardless of amount. */
export const ALWAYS_DUAL_APPROVAL: readonly Action[] = ["role.grant", "plan.price.change", "data.export"];
/** Actions that need a second approver at or above the configured amount. */
export const AMOUNT_DUAL_APPROVAL: readonly Action[] = ["payout.approve", "refund.approve"];

/**
 * super_admin is break-glass only (see authorize): every action that role can perform needs a second
 * approver regardless of amount. Pass the acting principal to dualApprovalRequired so this applies.
 */
export const SUPER_ADMIN_ACTIONS: readonly Action[] = ADMIN_POLICY.super_admin;

/** Actions whose use must carry a reason code in the audit log (PII/financial reads and exports). */
export const REQUIRES_REASON_CODE: readonly Action[] = ["user.read", "privacy.export", "data.export", "ledger.read"];

export const requiresReasonCode = (action: Action): boolean => REQUIRES_REASON_CODE.includes(action);
