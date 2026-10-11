/**
 * Authorization model for Z-OUTLET (spec T3, A2.10, section 0).
 *
 * Pure data types. No I/O, no clock (time is injected as epoch milliseconds),
 * no randomness. Everything is deny by default: access exists only when an
 * explicit allow rule matches.
 */

export type ActorStatus = "active" | "suspended" | "deleted";

/** Brand-side roles. `owner` is the brand owner; the rest are brand staff. */
export const BRAND_ROLES = ["owner", "manager", "catalog", "warehouse", "finance", "support"] as const;
export type BrandRole = (typeof BRAND_ROLES)[number];

/** Platform admin roles. `super_admin` is break-glass only and always needs dual approval. */
export const ADMIN_ROLES = [
  "ops",
  "finance",
  "trust_safety",
  "support",
  "marketing",
  "dpo",
  "security",
  "super_admin",
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export type Grant =
  | { readonly kind: "shopper" }
  | { readonly kind: "plus" }
  | { readonly kind: "brand"; readonly storeId: string; readonly role: BrandRole }
  /** `expiresAtMs` models just-in-time elevation; absent means no expiry. */
  | { readonly kind: "admin"; readonly role: AdminRole; readonly expiresAtMs?: number }
  | { readonly kind: "courier"; readonly hubId: string }
  | { readonly kind: "creator"; readonly creatorId: string };

export type GrantKind = Grant["kind"];

/** `passkey` is mandatory for every admin rule (master prompt, Admin security). */
export type Assurance = "basic" | "passkey";

export interface Actor {
  readonly id: string;
  readonly status: ActorStatus;
  readonly assurance: Assurance;
  readonly grants: readonly Grant[];
  /** OAuth-style scopes carried by the presented token, for example `seller:write`. */
  readonly tokenScopes: readonly string[];
}

export const RESOURCE_TYPES = [
  // shopper-owned
  "order",
  "cart",
  "address",
  "wishlist",
  "review",
  "return_request",
  "store_credit",
  "gift_card",
  "session",
  "dsar_export",
  // Plus
  "plus_benefit",
  // brand tenant
  "store_product",
  "store_inventory",
  "store_order",
  "store_return",
  "store_payout",
  "store_settings",
  "store_staff",
  // platform admin
  "admin_console",
  "refund",
  "payout",
  "pii_view",
  "data_export",
  "role_grant",
  "plan_price",
  "audit_log",
  "feature_flag",
  "break_glass",
  // courier and creator
  "courier_task",
  "creator_link",
  "creator_payout",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const ACTIONS = ["read", "create", "update", "delete", "approve", "export", "grant", "invoke"] as const;
export type Action = (typeof ACTIONS)[number];

export type ResourceState = "active" | "deleted";

export interface Resource {
  readonly type: ResourceType;
  readonly id: string;
  /** Owning user for shopper-owned objects. */
  readonly ownerUserId?: string;
  /** Tenant for brand objects. */
  readonly storeId?: string;
  readonly hubId?: string;
  readonly creatorId?: string;
  readonly state: ResourceState;
  /** Money in integer minor units. Used by threshold-based dual approval. */
  readonly amountMinor?: bigint;
}

/** Which grants satisfy a rule. `shopper` is also satisfied by `plus`. */
export type GrantMatcher =
  | { readonly kind: "shopper" }
  | { readonly kind: "plus" }
  | { readonly kind: "brand"; readonly roles: readonly BrandRole[] }
  | { readonly kind: "admin"; readonly roles: readonly AdminRole[] }
  | { readonly kind: "courier" }
  | { readonly kind: "creator" };

/**
 * Object scoping. `owner`: resource.ownerUserId equals actor.id. `store`: the matching
 * brand grant's storeId equals resource.storeId. `hub` and `creator` likewise.
 * `platform`: the grant alone suffices (admin routes, no object ownership).
 */
export type Scope = "owner" | "store" | "hub" | "creator" | "platform";

export type DualApprovalPolicy =
  | { readonly kind: "always" }
  /** Required when resource.amountMinor is greater than or equal to the threshold, or absent (fail closed). */
  | { readonly kind: "at_or_above"; readonly thresholdMinor: bigint };

export interface Rule {
  readonly id: string;
  readonly resource: ResourceType;
  readonly actions: readonly Action[];
  readonly grant: GrantMatcher;
  readonly scope: Scope;
  readonly requiresTokenScope?: string;
  readonly requiresPasskey?: boolean;
  /** PII views and break-glass require a reason code supplied by the caller. */
  readonly requiresReason?: boolean;
  readonly dualApproval?: DualApprovalPolicy;
  /** Only restore-style rules set this; otherwise a deleted resource is reported as 404. */
  readonly allowDeleted?: boolean;
}

export interface AuthzRequest {
  /** `null` means unauthenticated. */
  readonly actor: Actor | null;
  readonly action: Action;
  readonly resourceType: ResourceType;
  /** `null` means the id did not resolve to any row. */
  readonly resource: Resource | null;
  readonly nowMs: number;
  /** Reason code for PII views and break-glass. */
  readonly reason?: string;
  /** Other admins who approved this exact request. Verified here, never trusted. */
  readonly approvals?: readonly Actor[];
}

/** Internal, machine-readable reasons. Written to the audit log, never shown to the client. */
export const DENY_REASONS = [
  "unauthenticated",
  "actor_suspended",
  "actor_deleted",
  "no_rule",
  "missing_role",
  "grant_expired",
  "missing_token_scope",
  "passkey_required",
  "resource_not_found",
  "resource_deleted",
  "not_owned",
  "reason_required",
  "dual_approval_required",
  "malformed_request",
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

export type DenyStatus = 401 | 403 | 404;

export interface AuditRecord {
  readonly effect: "allow" | "deny";
  readonly actorId: string | null;
  readonly action: Action;
  readonly resourceType: ResourceType;
  readonly resourceId: string | null;
  readonly ruleId: string | null;
  readonly reason: DenyReason | "allowed";
  readonly httpStatus: 200 | DenyStatus;
  readonly approverIds: readonly string[];
  readonly atMs: number;
}

export type Decision =
  | {
      readonly effect: "allow";
      readonly ruleId: string;
      readonly httpStatus: 200;
      readonly approverIds: readonly string[];
      readonly audit: AuditRecord;
    }
  | {
      readonly effect: "deny";
      readonly httpStatus: DenyStatus;
      readonly reason: DenyReason;
      readonly audit: AuditRecord;
    };
