import { assertValidRuleSet } from "./decide";
import type { Action, AdminRole, BrandRole, ResourceType, Rule } from "./types";

/**
 * Thresholds are business decisions that are not made yet. They are required inputs so that
 * no default amount is ever invented here. VERIFY BEFORE LAUNCH: owner to set both (and to
 * decide whether the threshold is per item or per day).
 */
export interface DefaultRuleConfig {
  readonly refundDualApprovalAtOrAboveMinor: bigint;
  readonly payoutDualApprovalAtOrAboveMinor: bigint;
}

const SHOPPER_READ_WRITE: readonly Action[] = ["read", "create", "update", "delete"];

function shopperOwned(type: ResourceType, actions: readonly Action[]): Rule {
  return { id: `shopper.${type}.owner`, resource: type, actions, grant: { kind: "shopper" }, scope: "owner" };
}

function brand(
  type: ResourceType,
  suffix: string,
  actions: readonly Action[],
  roles: readonly BrandRole[],
  tokenScope: "seller:read" | "seller:write",
): Rule {
  return {
    id: `brand.${type}.${suffix}`,
    resource: type,
    actions,
    grant: { kind: "brand", roles },
    scope: "store",
    requiresTokenScope: tokenScope,
  };
}

function admin(
  id: string,
  type: ResourceType,
  actions: readonly Action[],
  roles: readonly AdminRole[],
  extra: Partial<Rule> = {},
): Rule {
  return {
    id: `admin.${id}`,
    resource: type,
    actions,
    grant: { kind: "admin", roles },
    scope: "platform",
    requiresPasskey: true,
    requiresTokenScope: "admin:access",
    ...extra,
  };
}

/**
 * The launch rule set. It is data: reviewable, diffable and the single source the RLS
 * document and the negative-authorization matrix are checked against.
 */
export function createDefaultRules(config: DefaultRuleConfig): readonly Rule[] {
  const rules: Rule[] = [
    // shopper-owned objects (a Plus member is also a shopper)
    shopperOwned("order", ["read", "update"]),
    shopperOwned("cart", SHOPPER_READ_WRITE),
    shopperOwned("address", SHOPPER_READ_WRITE),
    shopperOwned("wishlist", SHOPPER_READ_WRITE),
    shopperOwned("review", SHOPPER_READ_WRITE),
    shopperOwned("return_request", ["read", "create", "update"]),
    shopperOwned("store_credit", ["read"]),
    shopperOwned("gift_card", ["read", "update"]),
    shopperOwned("session", ["read", "delete"]),
    shopperOwned("dsar_export", ["read", "create"]),
    {
      id: "plus.plus_benefit.owner",
      resource: "plus_benefit",
      actions: ["read", "update"],
      grant: { kind: "plus" },
      scope: "owner",
    },

    // brand tenant: roles gate the function, the store gates the object
    brand("store_product", "read", ["read"], ["owner", "manager", "catalog", "warehouse", "support", "finance"], "seller:read"),
    brand("store_product", "write", ["create", "update", "delete"], ["owner", "manager", "catalog"], "seller:write"),
    brand("store_inventory", "read", ["read"], ["owner", "manager", "catalog", "warehouse"], "seller:read"),
    brand("store_inventory", "write", ["create", "update"], ["owner", "manager", "warehouse"], "seller:write"),
    brand("store_order", "read", ["read"], ["owner", "manager", "warehouse", "support", "finance"], "seller:read"),
    brand("store_order", "write", ["update"], ["owner", "manager", "warehouse"], "seller:write"),
    brand("store_return", "read", ["read"], ["owner", "manager", "warehouse", "support"], "seller:read"),
    brand("store_return", "write", ["update"], ["owner", "manager", "warehouse", "support"], "seller:write"),
    brand("store_payout", "read", ["read"], ["owner", "manager", "finance"], "seller:read"),
    brand("store_settings", "read", ["read"], ["owner", "manager"], "seller:read"),
    brand("store_settings", "write", ["update"], ["owner"], "seller:write"),
    brand("store_staff", "read", ["read"], ["owner", "manager"], "seller:read"),
    brand("store_staff", "write", ["create", "update", "delete"], ["owner"], "seller:write"),

    // platform admin
    admin(
      "admin_console.access",
      "admin_console",
      ["read"],
      ["ops", "finance", "trust_safety", "support", "marketing", "dpo", "security", "super_admin"],
    ),
    admin("refund.request", "refund", ["read", "create"], ["support", "finance"]),
    admin("refund.approve", "refund", ["approve"], ["finance"], {
      dualApproval: { kind: "at_or_above", thresholdMinor: config.refundDualApprovalAtOrAboveMinor },
    }),
    admin("payout.read", "payout", ["read"], ["finance", "ops"]),
    admin("payout.approve", "payout", ["approve"], ["finance"], {
      dualApproval: { kind: "at_or_above", thresholdMinor: config.payoutDualApprovalAtOrAboveMinor },
    }),
    admin("pii_view.read", "pii_view", ["read"], ["support", "trust_safety", "dpo"], { requiresReason: true }),
    admin("data_export.create", "data_export", ["create", "export"], ["dpo"], {
      dualApproval: { kind: "always" },
      requiresReason: true,
    }),
    admin("role_grant.grant", "role_grant", ["grant"], ["super_admin"], {
      dualApproval: { kind: "always" },
      requiresReason: true,
    }),
    admin("plan_price.update", "plan_price", ["update"], ["finance"], { dualApproval: { kind: "always" } }),
    admin("audit_log.read", "audit_log", ["read"], ["dpo", "security", "super_admin"]),
    admin("feature_flag.update", "feature_flag", ["read", "update"], ["ops"]),
    admin("break_glass.invoke", "break_glass", ["invoke"], ["super_admin"], {
      dualApproval: { kind: "always" },
      requiresReason: true,
    }),

    // courier and creator
    {
      id: "courier.courier_task.hub",
      resource: "courier_task",
      actions: ["read", "update"],
      grant: { kind: "courier" },
      scope: "hub",
    },
    {
      id: "creator.creator_link.self",
      resource: "creator_link",
      actions: ["read", "create", "update"],
      grant: { kind: "creator" },
      scope: "creator",
    },
    {
      id: "creator.creator_payout.self",
      resource: "creator_payout",
      actions: ["read"],
      grant: { kind: "creator" },
      scope: "creator",
    },
  ];
  assertValidRuleSet(rules);
  return rules;
}
