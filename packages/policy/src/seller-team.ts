import type { Action, BrandRole, ResourceType, Rule } from "./types";

/**
 * Seller team permissions (ADR-0058, spec seller-teams-availability-alerts section 1). Pure: no I/O,
 * no clock (time is injected), deny by default. This module is the code-owned catalogue, the preset
 * bundles, the `brand_permission` rule set, the legacy-role mapping and the delegation rules.
 * NOT wired into apps/api yet: chief-reviewer must review before any wiring.
 *
 * CALLER CONTRACT (review finding 8): every TeamMember passed in must be an ACTIVE membership of an
 * ACTIVE seller user (suspended, removed or pending members are filtered out by the caller, never
 * passed here), and `activeOwnerCount` must be recounted inside the same transaction that applies
 * the change (see spec "Wiring requirements"). Approval requests carry `requestedAtMs` and
 * `expiresAtMs`; PENDING requests past expiry are refused here ("expired") and must also be swept
 * to EXPIRED by a job. Compare people by seller USER id, never by membership id.
 */

export interface PermissionDef {
  readonly key: string;
  /** Owner-only to grant (needs second-owner approval or 24 h delay, spec 1.6). */
  readonly sensitive: boolean;
  /** Exposes buyer personal data (masked, active orders only, B1). */
  readonly exposesPii: boolean;
}

const def = (key: string, sensitive = false, exposesPii = false): PermissionDef => ({ key, sensitive, exposesPii });

/** Catalogue version 1. Adding a key needs an enforcement point (rule below) and tests. */
export const PERMISSION_CATALOGUE = [
  def("products.read"),
  def("products.write"),
  def("products.publish"),
  def("stock.read"),
  def("stock.write"),
  def("drops.write"),
  def("orders.read"),
  def("orders.fulfil"),
  def("orders.buyer_contact", false, true),
  def("returns.manage"),
  def("customers.reply"),
  def("promotions.write"),
  def("ads.manage"),
  def("ads.fund", true),
  def("store.branding"),
  def("store.settings"),
  // Not in the spec table: read-only settings. Needed because today `manager` reads settings but
  // only `owner` writes them, and one key cannot express both (flagged for review).
  def("store.settings_view"),
  def("analytics.view"),
  def("analytics.export"),
  def("finance.view"),
  def("finance.payout_account", true),
  def("billing.manage", true),
  def("price_integrity.respond"),
  def("team.view"),
  def("team.manage", true),
  def("store.closure", true),
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSION_CATALOGUE)[number]["key"];
export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_CATALOGUE.map((p) => p.key);

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}
export function isSensitive(key: PermissionKey): boolean {
  return PERMISSION_CATALOGUE.some((p) => p.key === key && p.sensitive);
}

const sorted = (keys: Iterable<PermissionKey>): readonly PermissionKey[] =>
  [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Keys that are not sensitive. */
const NON_SENSITIVE: readonly PermissionKey[] = PERMISSION_KEYS.filter((k) => !isSensitive(k));

// ---------------------------------------------------------------------------------------------
// Presets (spec 1.3). Versioned bundles; names are placeholders (owner decision T-D1).
// ---------------------------------------------------------------------------------------------

export const PRESET_VERSION = 1;
export const PRESET_CODES = [
  "owner",
  "manager",
  "sales_orders",
  "marketing",
  "catalogue_inventory",
  "warehouse",
  "finance",
  "support",
] as const;
export type PresetCode = (typeof PRESET_CODES)[number];

const MANAGER_EXCLUDED: readonly PermissionKey[] = [
  "finance.payout_account",
  "billing.manage",
  "store.closure",
  "ads.fund",
];

export const PRESETS: Readonly<Record<PresetCode, readonly PermissionKey[]>> = {
  owner: sorted(PERMISSION_KEYS),
  manager: sorted(PERMISSION_KEYS.filter((k) => !MANAGER_EXCLUDED.includes(k))),
  sales_orders: sorted([
    "products.read", "stock.read", "orders.read", "orders.fulfil", "returns.manage", "customers.reply", "analytics.view",
  ]),
  marketing: sorted([
    "products.read", "products.write", "drops.write", "promotions.write", "ads.manage", "store.branding",
    "analytics.view", "customers.reply",
  ]),
  catalogue_inventory: sorted([
    "products.read", "products.write", "products.publish", "stock.read", "stock.write", "drops.write",
    "price_integrity.respond",
  ]),
  warehouse: sorted(["products.read", "stock.read", "stock.write", "orders.read", "orders.fulfil", "returns.manage"]),
  finance: sorted([
    "finance.view", "analytics.view", "analytics.export", "orders.read", "finance.payout_account", "ads.fund",
    "billing.manage",
  ]),
  support: sorted(["products.read", "orders.read", "returns.manage", "customers.reply"]),
};

// ---------------------------------------------------------------------------------------------
// Enforcement points: (resource, action) -> required key. One rule per entry, scope "store".
// ---------------------------------------------------------------------------------------------

interface Enforcement {
  readonly resource: ResourceType;
  readonly actions: readonly Action[];
  readonly key: PermissionKey;
  readonly tokenScope: "seller:read" | "seller:write";
}

export const ENFORCEMENT: readonly Enforcement[] = [
  // Resources that exist today (token scopes copied from rules.ts so decisions match exactly).
  { resource: "store_product", actions: ["read"], key: "products.read", tokenScope: "seller:read" },
  { resource: "store_product", actions: ["create", "update", "delete"], key: "products.write", tokenScope: "seller:write" },
  { resource: "store_inventory", actions: ["read"], key: "stock.read", tokenScope: "seller:read" },
  { resource: "store_inventory", actions: ["create", "update"], key: "stock.write", tokenScope: "seller:write" },
  { resource: "store_order", actions: ["read"], key: "orders.read", tokenScope: "seller:read" },
  { resource: "store_order", actions: ["update"], key: "orders.fulfil", tokenScope: "seller:write" },
  { resource: "store_return", actions: ["read"], key: "returns.manage", tokenScope: "seller:read" },
  { resource: "store_return", actions: ["update"], key: "returns.manage", tokenScope: "seller:write" },
  { resource: "store_payout", actions: ["read"], key: "finance.view", tokenScope: "seller:read" },
  { resource: "store_settings", actions: ["read"], key: "store.settings_view", tokenScope: "seller:read" },
  { resource: "store_settings", actions: ["update"], key: "store.settings", tokenScope: "seller:write" },
  { resource: "store_staff", actions: ["read"], key: "team.view", tokenScope: "seller:read" },
  { resource: "store_staff", actions: ["create", "update", "delete"], key: "team.manage", tokenScope: "seller:write" },
  // New resources (no legacy behaviour; outside the equivalence domain).
  { resource: "store_listing_status", actions: ["update"], key: "products.publish", tokenScope: "seller:write" },
  { resource: "store_drop", actions: ["create", "update"], key: "drops.write", tokenScope: "seller:write" },
  { resource: "store_order_pii", actions: ["read"], key: "orders.buyer_contact", tokenScope: "seller:read" },
  { resource: "store_engagement", actions: ["update"], key: "customers.reply", tokenScope: "seller:write" },
  { resource: "store_promotion", actions: ["create", "update"], key: "promotions.write", tokenScope: "seller:write" },
  { resource: "store_ads", actions: ["update"], key: "ads.manage", tokenScope: "seller:write" },
  { resource: "store_ads_billing", actions: ["create"], key: "ads.fund", tokenScope: "seller:write" },
  { resource: "store_branding", actions: ["update"], key: "store.branding", tokenScope: "seller:write" },
  { resource: "store_analytics", actions: ["read"], key: "analytics.view", tokenScope: "seller:read" },
  { resource: "store_analytics", actions: ["export"], key: "analytics.export", tokenScope: "seller:read" },
  { resource: "store_payout_account", actions: ["update"], key: "finance.payout_account", tokenScope: "seller:write" },
  { resource: "store_billing", actions: ["update"], key: "billing.manage", tokenScope: "seller:write" },
  { resource: "store_price_integrity", actions: ["update"], key: "price_integrity.respond", tokenScope: "seller:write" },
  { resource: "store_closure", actions: ["create"], key: "store.closure", tokenScope: "seller:write" },
];

/** Rules for `brand_permission` grants. Data, so it composes with `createDefaultRules` output. */
export function createPermissionRules(): readonly Rule[] {
  return ENFORCEMENT.map((e) => ({
    id: `brandperm.${e.resource}.${e.actions.join("+")}`,
    resource: e.resource,
    actions: e.actions,
    grant: { kind: "brand_permission", permission: e.key },
    scope: "store",
    requiresTokenScope: e.tokenScope,
  }));
}

// ---------------------------------------------------------------------------------------------
// Legacy mapping (spec 1.3 backward compatibility): exact sets, derived from rules.ts:81-94.
// ---------------------------------------------------------------------------------------------

/**
 * Permission sets whose decisions equal today's role rules (packages/policy/src/rules.ts:82-94),
 * for every existing (resource, action). Keys with no legacy rule (promotions, ads, branding...)
 * are granted only to owner, as the Owner preset has all keys. `products.publish` is held where
 * `store_product` update is held, because publishing is a product update today.
 */
export const LEGACY_ROLE_PERMISSIONS: Readonly<Record<BrandRole, readonly PermissionKey[]>> = {
  owner: PRESETS.owner,
  manager: sorted([
    "products.read", "products.write", "products.publish", "stock.read", "stock.write", "orders.read",
    "orders.fulfil", "returns.manage", "finance.view", "store.settings_view", "team.view", "analytics.view",
    "analytics.export",
  ]),
  catalog: sorted(["products.read", "products.write", "products.publish", "stock.read"]),
  warehouse: sorted([
    "products.read", "stock.read", "stock.write", "orders.read", "orders.fulfil", "returns.manage", "analytics.view",
  ]),
  finance: sorted(["products.read", "orders.read", "finance.view", "analytics.view"]),
  support: sorted(["products.read", "orders.read", "returns.manage", "analytics.view"]),
};

const LEGACY_PRESET: Readonly<Record<BrandRole, PresetCode>> = {
  owner: "owner",
  manager: "manager",
  catalog: "catalogue_inventory",
  warehouse: "warehouse",
  finance: "finance",
  support: "support",
};

export interface MembershipPermissions {
  readonly presetCode: PresetCode;
  readonly presetVersion: number;
  /** True when the set differs from the preset (so it never auto-follows preset changes). */
  readonly customised: boolean;
  readonly permissions: readonly PermissionKey[];
}

/** Existing member role -> permissions to store at migration. Never silently widens access. */
export function membershipForLegacyRole(role: BrandRole): MembershipPermissions {
  const presetCode = LEGACY_PRESET[role];
  const permissions = LEGACY_ROLE_PERMISSIONS[role];
  const preset = PRESETS[presetCode];
  return {
    presetCode,
    presetVersion: PRESET_VERSION,
    customised: permissions.length !== preset.length || permissions.some((k, i) => k !== preset[i]),
    permissions,
  };
}

// ---------------------------------------------------------------------------------------------
// Effective set (spec 1.4): stored permissions minus restrictions minus entitlement denials.
// ---------------------------------------------------------------------------------------------

export const STORE_RESTRICTIONS = ["no_ads"] as const;
export type StoreRestriction = (typeof STORE_RESTRICTIONS)[number];
const RESTRICTION_REMOVES: Readonly<Record<StoreRestriction, readonly PermissionKey[]>> = {
  no_ads: ["ads.manage", "ads.fund"],
};

function isStoreRestriction(v: string): v is StoreRestriction {
  return (STORE_RESTRICTIONS as readonly string[]).includes(v);
}

/**
 * Unknown keys are dropped (deny by default). An UNKNOWN restriction string fails closed: the
 * effective set is empty (never throws, never widens). Monotone: more restrictions never add a key.
 */
export function effectivePermissions(input: {
  readonly permissions: readonly string[];
  readonly restrictions?: readonly string[];
  readonly entitlementDenied?: readonly string[];
}): readonly PermissionKey[] {
  const removed = new Set<string>(input.entitlementDenied ?? []);
  for (const r of input.restrictions ?? []) {
    if (!isStoreRestriction(r)) return [];
    for (const k of RESTRICTION_REMOVES[r]) removed.add(k);
  }
  return sorted(input.permissions.filter(isPermissionKey).filter((k) => !removed.has(k)));
}

// ---------------------------------------------------------------------------------------------
// Delegation (spec 1.5, 1.6, 1.7). Typed decisions, no exceptions.
// ---------------------------------------------------------------------------------------------

export const GRANT_DENY_CODES = [
  "not_found", // cross-store: identical to unknown (404)
  "permission_denied", // actor lacks team.manage (403)
  "target_not_manageable", // manager editing an owner or another team manager (403)
  "self_edit_forbidden", // 422
  "unknown_permission", // 422
  "sensitive_requires_owner", // 422
  "cannot_grant_unheld_permission", // 422
  "cannot_remove_unheld_permission", // 422
  "last_owner", // 409
] as const;
export type GrantDenyCode = (typeof GRANT_DENY_CODES)[number];

const STATUS: Readonly<Record<GrantDenyCode, 403 | 404 | 409 | 422>> = {
  not_found: 404,
  permission_denied: 403,
  target_not_manageable: 403,
  self_edit_forbidden: 422,
  unknown_permission: 422,
  sensitive_requires_owner: 422,
  cannot_grant_unheld_permission: 422,
  cannot_remove_unheld_permission: 422,
  last_owner: 409,
};

export const SENSITIVE_DELAY_MS = 24 * 60 * 60 * 1000;

export type SensitiveApproval =
  | { readonly kind: "none" }
  | { readonly kind: "second_owner"; readonly keys: readonly PermissionKey[] }
  | { readonly kind: "delayed"; readonly keys: readonly PermissionKey[]; readonly activatesAtMs: number };

export type GrantDecision =
  | {
      readonly effect: "allow";
      readonly added: readonly PermissionKey[];
      readonly removed: readonly PermissionKey[];
      readonly approval: SensitiveApproval;
    }
  | GrantDenial;

export interface GrantDenial {
  readonly effect: "deny";
  readonly code: GrantDenyCode;
  readonly httpStatus: 403 | 404 | 409 | 422;
}

const deny = (code: GrantDenyCode): GrantDenial => ({ effect: "deny", code, httpStatus: STATUS[code] });

export interface TeamMember {
  readonly membershipId: string;
  /** Seller USER id; identity comparisons use this, not the membership id. */
  readonly userId: string;
  readonly storeId: string;
  readonly isOwner: boolean;
  /** When the owner status became active (ms). Required for owners acting as approvers. */
  readonly ownerSinceMs?: number | undefined;
  /** Effective permissions (already reduced by restrictions and entitlements). */
  readonly permissions: readonly string[];
}

export function decidePermissionChange(input: {
  readonly actor: TeamMember;
  readonly target: TeamMember;
  /** Complete desired permission set for the target. */
  readonly next: readonly string[];
  readonly activeOwnerCount: number;
  readonly nowMs: number;
}): GrantDecision {
  const { actor, target } = input;
  if (actor.storeId !== target.storeId) return deny("not_found");
  if (!actor.isOwner && !actor.permissions.includes("team.manage")) return deny("permission_denied");
  if (actor.membershipId === target.membershipId) return deny("self_edit_forbidden");
  // Owners change only through transfer / step-down, never by a permission edit (any actor).
  if (target.isOwner) return deny("target_not_manageable");
  const actorHolds = new Set<string>(actor.permissions);
  if (!actor.isOwner) {
    // Same subset bound as removal: no team.manage, no sensitive key, nothing the actor lacks.
    if (target.permissions.some((k) => k === "team.manage" || (isPermissionKey(k) && isSensitive(k)) || !actorHolds.has(k))) {
      return deny("target_not_manageable");
    }
  }
  if (input.next.some((k) => !isPermissionKey(k))) return deny("unknown_permission");
  const next = new Set<string>(input.next);
  const current = new Set<string>(target.permissions);
  const added = sorted(PERMISSION_KEYS.filter((k) => next.has(k) && !current.has(k)));
  const removed = sorted(PERMISSION_KEYS.filter((k) => !next.has(k) && current.has(k)));
  for (const k of added) {
    if (isSensitive(k) && !actor.isOwner) return deny("sensitive_requires_owner");
    if (!actorHolds.has(k)) return deny("cannot_grant_unheld_permission");
  }
  const sensitiveAdded = added.filter(isSensitive);
  let approval: SensitiveApproval = { kind: "none" };
  if (sensitiveAdded.length > 0) {
    approval =
      input.activeOwnerCount >= 2
        ? { kind: "second_owner", keys: sensitiveAdded }
        : { kind: "delayed", keys: sensitiveAdded, activatesAtMs: input.nowMs + SENSITIVE_DELAY_MS };
  }
  return { effect: "allow", added, removed, approval };
}

/** Removing a member (or leaving). The last owner can never go; managers need the same bounds as edits. */
export function decideMemberRemoval(input: {
  readonly actor: TeamMember;
  readonly target: TeamMember;
  readonly activeOwnerCount: number;
}): { readonly effect: "allow" } | GrantDenial {
  const { actor, target } = input;
  if (actor.storeId !== target.storeId) return deny("not_found");
  if (target.isOwner && input.activeOwnerCount <= 1) return deny("last_owner");
  if (actor.membershipId === target.membershipId) return { effect: "allow" };
  if (!actor.isOwner && !actor.permissions.includes("team.manage")) return deny("permission_denied");
  if (!actor.isOwner && (target.isOwner || target.permissions.some((k) => k === "team.manage" || (isPermissionKey(k) && isSensitive(k)) || !actor.permissions.includes(k)))) {
    return deny("target_not_manageable");
  }
  return { effect: "allow" };
}

export type ApprovalDecision =
  | { readonly effect: "allow" }
  | {
      readonly effect: "deny";
      readonly code: "not_found" | "not_owner" | "same_person" | "not_pending" | "owner_too_recent" | "expired";
      readonly httpStatus: 403 | 404 | 409;
    };

/**
 * Second-owner approval of a sensitive grant: another active owner of the same store, never the
 * requester (compared by seller USER id), who was already an owner when the request was created
 * (a freshly minted owner, e.g. via a transfer accepted afterwards, cannot approve), and only
 * while the request is PENDING and unexpired.
 */
export function decideGrantApproval(input: {
  readonly approver: TeamMember;
  readonly requesterUserId: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly nowMs: number;
  readonly storeId: string;
  readonly status: "PENDING" | "APPROVED" | "CANCELLED" | "ACTIVATED" | "EXPIRED";
}): ApprovalDecision {
  const { approver } = input;
  if (approver.storeId !== input.storeId) return { effect: "deny", code: "not_found", httpStatus: 404 };
  if (!approver.isOwner) return { effect: "deny", code: "not_owner", httpStatus: 403 };
  if (approver.userId === input.requesterUserId) return { effect: "deny", code: "same_person", httpStatus: 409 };
  if (approver.ownerSinceMs === undefined || approver.ownerSinceMs > input.requestedAtMs) {
    return { effect: "deny", code: "owner_too_recent", httpStatus: 403 };
  }
  if (input.status !== "PENDING") return { effect: "deny", code: "not_pending", httpStatus: 409 };
  if (input.nowMs >= input.expiresAtMs) return { effect: "deny", code: "expired", httpStatus: 409 };
  return { effect: "allow" };
}

/**
 * Making someone an owner (promotion, or acceptance of an ownership transfer) is a sensitive grant:
 * with 2+ active owners another owner must approve; with a single owner it activates only after
 * SENSITIVE_DELAY_MS (cancellable). Until activation the member is NOT an owner.
 */
export function decideOwnerGrant(input: {
  readonly via: "promotion" | "transfer_accept";
  /** Promotion: the promoting owner. Transfer: the member accepting (the offer came from an owner). */
  readonly actor: TeamMember;
  readonly target: TeamMember;
  readonly activeOwnerCount: number;
  readonly maxOwners: number;
  readonly nowMs: number;
}): { readonly effect: "allow"; readonly approval: Exclude<SensitiveApproval, { kind: "none" }> } | GrantDenial {
  const { actor, target } = input;
  if (actor.storeId !== target.storeId) return deny("not_found");
  if (input.via === "promotion") {
    if (!actor.isOwner) return deny("permission_denied");
    if (actor.userId === target.userId) return deny("self_edit_forbidden");
  } else if (actor.userId !== target.userId) {
    return deny("self_edit_forbidden");
  }
  if (target.isOwner || input.activeOwnerCount >= input.maxOwners) return deny("target_not_manageable");
  const keys: readonly PermissionKey[] = ["team.manage"];
  return {
    effect: "allow",
    approval:
      input.activeOwnerCount >= 2
        ? { kind: "second_owner", keys }
        : { kind: "delayed", keys, activatesAtMs: input.nowMs + SENSITIVE_DELAY_MS },
  };
}

/** A delayed sensitive grant becomes active only once its time has come and it was not cancelled. */
export function isDelayedGrantActive(grant: { readonly activatesAtMs: number; readonly cancelled: boolean }, nowMs: number): boolean {
  return !grant.cancelled && nowMs >= grant.activatesAtMs;
}

/** Keys a non-owner granter may hand out: non-sensitive keys they hold. */
export function grantableKeys(actor: TeamMember): readonly PermissionKey[] {
  const held = actor.permissions.filter(isPermissionKey);
  return sorted(actor.isOwner ? held : held.filter((k) => NON_SENSITIVE.includes(k)));
}
