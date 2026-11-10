import type { Action } from "./types.js";

/** Bump on any change to the tables below; recorded in audit entries. */
export const POLICY_VERSION = 8;

export const SELLER_ROLES = ["owner", "manager", "catalog", "warehouse", "finance", "support"] as const;
export const ADMIN_ROLES = ["ops", "finance", "trust_safety", "support", "marketing", "dpo", "security", "super_admin"] as const;

/** Actions any anonymous caller may perform (public catalog only). */
export const PUBLIC_ACTIONS: readonly Action[] = ["catalog.read", "store.read"];

/** Shopper actions, always limited to the shopper's own resources. */
export const SHOPPER_ACTIONS: readonly Action[] = [
  "catalog.read", "store.read", "cart.read", "cart.write", "order.read", "order.cancel", "return.create",
  "return.read", "wishlist.read", "wishlist.write", "address.read", "address.write", "privacy.export", "privacy.delete",
  "session.read", "session.revoke", "passkey.manage", "checkout.place", "seller.onboard",
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
  ops: [
    "store.read", "store.suspend", "store.reinstate", "store.threshold.write", "listing.read", "order.read", "return.read", "return.decide",
    "seller_kyc.review", "seller_kyc.read", "price_integrity.read", "approval.read", "approval.decide", "elevation.request",
    "dashboard.read", "attention.read", "attention.write", "dlq.manage", "dlq.discard.money",
  ],
  finance: [
    "order.read", "store.threshold.write", "payout.read", "payout.approve", "refund.approve", "statement.read", "ledger.read",
    "kill_switch.read", "kill_switch.engage", "reconciliation.read", "reconciliation.resolve", "price_integrity.read", "tax.read", "approval.read", "approval.decide", "elevation.request",
    "dashboard.read", "finance.summary.read", "attention.read", "attention.write",
  ],
  trust_safety: [
    "store.read", "store.suspend", "store.reinstate", "listing.read", "listing.takedown", "return.read", "dispute.decide", "seller_kyc.review", "seller_kyc.read",
    "price_integrity.read", "approval.read", "approval.decide", "elevation.request", "dashboard.read",
  ],
  support: ["order.read", "return.read", "user.read", "customer_message.read", "customer_message.write", "approval.read", "approval.decide", "elevation.request", "dashboard.read"],
  marketing: ["promotion.write", "catalog.read", "plan.price.change", "approval.read", "approval.decide", "elevation.request", "dashboard.read"],
  dpo: ["user.read", "privacy.export", "privacy.delete", "data.export", "breach.manage", "privacy.breach.open", "pii_access.read", "approval.read", "approval.decide", "elevation.request", "dashboard.read"],
  security: [
    "audit.read", "rbac.read", "pii_access.read", "role.grant", "session.revoke", "kill_switch.read", "kill_switch.engage", "privacy.breach.open", "approval.read", "approval.decide", "elevation.request", "elevation.approve", "dashboard.read", "dlq.manage", "dlq.discard.money",
  ],
  super_admin: [
    "approval.read", "approval.decide", "role.grant", "plan.price.change", "data.export", "payout.approve", "refund.approve", "audit.read", "rbac.read", "pii_access.read", "kill_switch.read", "kill_switch.engage",
    "approval.read", "approval.decide", "elevation.request", "elevation.approve", "dashboard.read", "finance.summary.read", "dlq.manage", "dlq.discard.money",
  ],
};

/** Actions that always need a second approver regardless of amount. */
export const ALWAYS_DUAL_APPROVAL: readonly Action[] = ["role.grant", "plan.price.change", "data.export", "store.suspend", "store.reinstate", "dlq.discard.money"];
/** Needs a second approver when the switch guards money movement (payments, BNPL, COD, payouts, gift cards). Unknown counts as money. */
export const MONEY_SWITCH_DUAL_APPROVAL: readonly Action[] = ["kill_switch.engage"];
/** Actions that need a second approver at or above the configured amount. */
export const AMOUNT_DUAL_APPROVAL: readonly Action[] = ["payout.approve", "refund.approve", "reconciliation.resolve"];

/**
 * super_admin is break-glass only (see authorize): every action that role can perform needs a second
 * approver regardless of amount. Pass the acting principal to dualApprovalRequired so this applies.
 */
export const SUPER_ADMIN_ACTIONS: readonly Action[] = ADMIN_POLICY.super_admin;

/** Actions whose use must carry a reason code in the audit log (PII/financial reads and exports). */
export const REQUIRES_REASON_CODE: readonly Action[] = ["user.read", "privacy.export", "data.export", "ledger.read", "reconciliation.read", "seller_kyc.read"];

export const requiresReasonCode = (action: Action): boolean => REQUIRES_REASON_CODE.includes(action);
