import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "./decide";
import {
  ENFORCEMENT, LEGACY_ROLE_PERMISSIONS, PERMISSION_CATALOGUE, PERMISSION_KEYS, PRESETS, PRESET_CODES,
  SENSITIVE_DELAY_MS, createPermissionRules, decideGrantApproval, decideMemberRemoval, decideOwnerGrant, decidePermissionChange,
  effectivePermissions, grantableKeys, isDelayedGrantActive, isPermissionKey, isSensitive, membershipForLegacyRole,
  type PermissionKey, type TeamMember,
} from "./seller-team";
import { assertValidRuleSet } from "./decide";
import { NOW, RULES, actor } from "./test-fixtures";
import { BRAND_ROLES, type Action, type BrandRole, type ResourceState, type ResourceType } from "./types";

const STORE = "store-a";
const OTHER = "store-b";

/**
 * TODAY's behaviour, written by hand from packages/policy/src/rules.ts:82-94 (brand rules). Not computed
 * from createDefaultRules, so a drift in either side is caught. apps/api builds
 * `{ kind: "brand", storeId, role }` grants from memberships (auth/seller/application/team.ts:75,179) BUT
 * ALSO has role checks of its own that this equivalence does not cover: the returns, tax-eta,
 * seller-settings, seller-analytics and sizing resolvers, the promotions authorizer, and ~15
 * `storeIdsOf` helpers filtering on `g.kind === "brand"`. Those must migrate to decide() before wiring
 * (spec "Wiring requirements").
 */
const TODAY: readonly (readonly [ResourceType, readonly Action[], readonly BrandRole[], "seller:read" | "seller:write"])[] = [
  ["store_product", ["read"], ["owner", "manager", "catalog", "warehouse", "support", "finance"], "seller:read"], // rules.ts:82
  ["store_product", ["create", "update", "delete"], ["owner", "manager", "catalog"], "seller:write"], // :83
  ["store_inventory", ["read"], ["owner", "manager", "catalog", "warehouse"], "seller:read"], // :84
  ["store_inventory", ["create", "update"], ["owner", "manager", "warehouse"], "seller:write"], // :85
  ["store_order", ["read"], ["owner", "manager", "warehouse", "support", "finance"], "seller:read"], // :86
  ["store_order", ["update"], ["owner", "manager", "warehouse"], "seller:write"], // :87
  ["store_return", ["read"], ["owner", "manager", "warehouse", "support"], "seller:read"], // :88
  ["store_return", ["update"], ["owner", "manager", "warehouse", "support"], "seller:write"], // :89
  ["store_payout", ["read"], ["owner", "manager", "finance"], "seller:read"], // :90
  ["store_settings", ["read"], ["owner", "manager"], "seller:read"], // :91
  ["store_settings", ["update"], ["owner"], "seller:write"], // :92
  ["store_staff", ["read"], ["owner", "manager"], "seller:read"], // :93
  ["store_staff", ["create", "update", "delete"], ["owner"], "seller:write"], // :94
];
const PAIRS = TODAY.flatMap(([r, acts]) => acts.map((a) => [r, a] as const));
const todayAllows = (role: BrandRole, r: ResourceType, a: Action): boolean =>
  TODAY.some(([rr, acts, roles]) => rr === r && acts.includes(a) && roles.includes(role));

const NEW_RULES = createPermissionRules();
const STATES: ResourceState[] = ["active", "draft", "paused", "suspended", "deleted"];
const SCOPES = [[], ["seller:read"], ["seller:write"], ["seller:read", "seller:write"]] as const;
const legacyActor = (role: BrandRole, storeId: string, scopes: readonly string[]) =>
  actor("u", [{ kind: "brand", storeId, role }], { tokenScopes: scopes });
const newActor = (role: BrandRole, storeId: string, scopes: readonly string[]) =>
  actor("u", [{ kind: "brand_permission", storeId, permissions: membershipForLegacyRole(role).permissions }], { tokenScopes: scopes });
const run = (a: ReturnType<typeof actor>, r: ResourceType, act: Action, state: ResourceState, rules: typeof RULES) =>
  decide({ actor: a, action: act, resourceType: r, resource: { type: r, id: "x", storeId: STORE, state }, nowMs: NOW }, rules);

describe("legacy equivalence (required property)", () => {
  it("today's table matches the current rules.ts decisions", () => {
    for (const role of BRAND_ROLES) for (const [r, a] of PAIRS) {
      expect(decide({ actor: legacyActor(role, STORE, ["seller:read", "seller:write"]), action: a, resourceType: r,
        resource: { type: r, id: "x", storeId: STORE, state: "active" }, nowMs: NOW }, RULES).effect === "allow").toBe(todayAllows(role, r, a));
    }
  });

  it("every legacy role x every existing action x state x scope x store: identical decision, status and reason", () => {
    for (const role of BRAND_ROLES) for (const [r, a] of PAIRS) for (const state of STATES) for (const scopes of SCOPES) for (const sid of [STORE, OTHER]) {
      const old = run(legacyActor(role, sid, scopes), r, a, state, RULES);
      const now = run(newActor(role, sid, scopes), r, a, state, NEW_RULES);
      expect([now.effect, now.httpStatus]).toEqual([old.effect, old.httpStatus]);
      if (old.effect === "deny" && now.effect === "deny") {
        // "missing_role" and "no_rule" are both a 403 for the caller; every other reason must match exactly.
        expect(now.reason).toBe(old.reason);
      }
    }
  });

  it("property: random role/action/state/scope subset", () => {
    fc.assert(fc.property(
      fc.constantFrom(...BRAND_ROLES), fc.constantFrom(...PAIRS), fc.constantFrom(...STATES),
      fc.subarray(["seller:read", "seller:write"]), fc.boolean(),
      (role, [r, a], state, scopes, own) => {
        const sid = own ? STORE : OTHER;
        const old = run(legacyActor(role, sid, scopes), r, a, state, RULES);
        const now = run(newActor(role, sid, scopes), r, a, state, NEW_RULES);
        return old.effect === now.effect && old.httpStatus === now.httpStatus;
      }));
  });

  it("existing members never gain a key beyond today's behaviour", () => {
    const covered = new Set(ENFORCEMENT.filter((e) => PAIRS.some(([r]) => r === e.resource)).map((e) => e.key));
    for (const role of BRAND_ROLES) {
      if (role === "owner") continue;
      const held = LEGACY_ROLE_PERMISSIONS[role];
      for (const k of held) {
        if (covered.has(k)) continue;
        if (k === "products.publish") expect(held).toContain("products.write");
        else if (k === "analytics.view" || k === "analytics.export") {
          expect(held.includes("orders.read") || held.includes("store.settings_view")).toBe(true);
        } else throw new Error(`unexpected new key ${k} for ${role}`);
      }
    }
  });

  it("legacy mapping flags customised sets and keeps preset names", () => {
    expect(membershipForLegacyRole("owner")).toMatchObject({ presetCode: "owner", customised: false });
    expect(membershipForLegacyRole("manager").customised).toBe(true);
    expect(membershipForLegacyRole("catalog").presetCode).toBe("catalogue_inventory");
    expect(membershipForLegacyRole("catalog").permissions).not.toContain("stock.write");
  });
});

describe("catalogue, presets, rules", () => {
  it("has unique known keys, sensitive ones as per spec, and a valid rule set", () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_CATALOGUE.length);
    expect(PERMISSION_KEYS.filter(isSensitive).sort()).toEqual(
      ["ads.fund", "billing.manage", "finance.payout_account", "store.closure", "team.manage"]);
    expect(PERMISSION_CATALOGUE.find((p) => p.key === "orders.buyer_contact")?.exposesPii).toBe(true);
    expect(isPermissionKey("nope")).toBe(false);
    expect(() => assertValidRuleSet(NEW_RULES)).not.toThrow();
    for (const k of PERMISSION_KEYS) expect(ENFORCEMENT.some((e) => e.key === k)).toBe(true);
  });
  it("eight presets, owner has everything, manager lacks the four excluded keys, all keys valid", () => {
    expect(PRESET_CODES).toHaveLength(8);
    expect(PRESETS.owner).toEqual([...PERMISSION_KEYS].sort());
    for (const k of ["finance.payout_account", "billing.manage", "store.closure", "ads.fund"] as const) expect(PRESETS.manager).not.toContain(k);
    expect(PRESETS.manager).toContain("team.manage");
    for (const c of PRESET_CODES) for (const k of PRESETS[c]) expect(isPermissionKey(k)).toBe(true);
    expect(PRESETS.sales_orders).not.toContain("stock.write");
    expect(PRESETS.marketing).not.toContain("finance.view");
  });
  it("preset-based actors: sales cannot write stock, warehouse cannot view analytics export, marketing cannot see payouts", () => {
    const can = (code: (typeof PRESET_CODES)[number], r: ResourceType, a: Action) =>
      run(actor("u", [{ kind: "brand_permission", storeId: STORE, permissions: PRESETS[code] }]), r, a, "active", NEW_RULES).effect === "allow";
    expect(can("sales_orders", "store_inventory", "update")).toBe(false);
    expect(can("sales_orders", "store_order", "update")).toBe(true);
    expect(can("warehouse", "store_analytics", "export")).toBe(false);
    expect(can("marketing", "store_payout", "read")).toBe(false);
    expect(can("support", "store_order_pii", "read")).toBe(false);
    expect(can("marketing", "store_promotion", "create")).toBe(true);
  });
  it("deny by default: empty, unknown-key and foreign-store grants", () => {
    for (const [r, a] of PAIRS) {
      expect(run(actor("u", [{ kind: "brand_permission", storeId: STORE, permissions: [] }]), r, a, "active", NEW_RULES).effect).toBe("deny");
      expect(run(actor("u", [{ kind: "brand_permission", storeId: STORE, permissions: ["bogus"] }]), r, a, "active", NEW_RULES).effect).toBe("deny");
      const foreign = run(actor("u", [{ kind: "brand_permission", storeId: OTHER, permissions: PRESETS.owner }]), r, a, "active", NEW_RULES);
      expect([foreign.effect, foreign.httpStatus]).toEqual(["deny", 404]);
    }
  });
});

describe("effective permissions", () => {
  it("drops unknown keys, applies restriction and entitlement denials, is sorted", () => {
    expect(effectivePermissions({ permissions: ["x", "ads.manage", "ads.fund", "stock.read", "analytics.export"], restrictions: ["no_ads"], entitlementDenied: ["analytics.export"] }))
      .toEqual(["stock.read"]);
    expect(effectivePermissions({ permissions: ["team.view", "stock.read"] })).toEqual(["stock.read", "team.view"]);
  });
  it("unknown restriction fails closed without throwing", () => {
    expect(effectivePermissions({ permissions: ["stock.read"], restrictions: ["future_restriction"] })).toEqual([]);
  });
  it("property: monotone under restrictions and denials", () => {
    fc.assert(fc.property(fc.subarray([...PERMISSION_KEYS]), fc.subarray([...PERMISSION_KEYS]), (perms, denied) => {
      const base = effectivePermissions({ permissions: perms });
      const less = effectivePermissions({ permissions: perms, restrictions: ["no_ads"], entitlementDenied: denied });
      return less.every((k) => base.includes(k));
    }));
  });
});

const member = (id: string, perms: readonly string[], over: Partial<TeamMember> = {}): TeamMember =>
  ({ membershipId: id, userId: `user-${id}`, storeId: STORE, isOwner: false, permissions: perms, ...over });
const owner = (id = "o1") => member(id, PRESETS.owner, { isOwner: true, ownerSinceMs: NOW - 10 * SENSITIVE_DELAY_MS });
const manager = (id = "m1") => member(id, PRESETS.manager);
const staff = (id = "s1", perms: readonly string[] = PRESETS.support) => member(id, perms);
const change = (actorM: TeamMember, target: TeamMember, next: readonly string[], owners = 2) =>
  decidePermissionChange({ actor: actorM, target, next, activeOwnerCount: owners, nowMs: NOW });

describe("decidePermissionChange (negative rows 1.15 that belong to the pure layer)", () => {
  it("cross-store target is not_found (404)", () => {
    expect(change(manager(), staff("s", PRESETS.support).storeId === STORE ? { ...staff(), storeId: OTHER } : staff(), [])).toMatchObject({ effect: "deny", code: "not_found", httpStatus: 404 });
  });
  it("missing team.manage is permission_denied", () => {
    expect(change(member("a", ["team.view"]), staff(), [])).toMatchObject({ code: "permission_denied", httpStatus: 403 });
  });
  it("self edit is forbidden, even for an owner", () => {
    expect(change(manager("m1"), manager("m1"), [])).toMatchObject({ code: "self_edit_forbidden", httpStatus: 422 });
    expect(change(owner("o1"), owner("o1"), [])).toMatchObject({ code: "self_edit_forbidden" });
  });
  it("manager cannot grant a sensitive key (sensitive_requires_owner) or an unheld one", () => {
    expect(change(manager(), staff(), [...PRESETS.support, "finance.payout_account"])).toMatchObject({ code: "sensitive_requires_owner", httpStatus: 422 });
    const lowMgr = member("m2", ["team.manage", "products.read"]);
    expect(change(lowMgr, staff("s", ["products.read"]), ["products.read", "orders.read"])).toMatchObject({ code: "cannot_grant_unheld_permission" });
  });
  it("escalate-by-grant: a manager cannot edit another manager, an owner, or a member holding a sensitive key", () => {
    expect(change(manager("m1"), manager("m2"), ["products.read"])).toMatchObject({ code: "target_not_manageable", httpStatus: 403 });
    expect(change(manager(), owner(), ["products.read"])).toMatchObject({ code: "target_not_manageable" });
    expect(change(manager(), staff("s", ["products.read", "ads.fund"]), ["products.read"])).toMatchObject({ code: "target_not_manageable" });
  });
  it("manager cannot remove keys it does not hold; unknown key rejected", () => {
    const m = member("m3", ["team.manage", "products.read"]);
    expect(change(m, staff("s", ["products.read", "orders.read"]), ["products.read"])).toMatchObject({ code: "target_not_manageable" });
    expect(change(owner(), staff(), ["bogus"])).toMatchObject({ code: "unknown_permission" });
  });
  it("allowed non-sensitive change reports the diff and no approval", () => {
    const d = change(manager(), staff(), [...PRESETS.support, "stock.read"]);
    expect(d).toEqual({ effect: "allow", added: ["stock.read"], removed: [], approval: { kind: "none" } });
  });
  it("owner granting sensitive: second owner when 2+ owners, 24h delay for a single owner", () => {
    const withTwo = change(owner(), staff(), ["ads.fund"], 2);
    expect(withTwo).toMatchObject({ effect: "allow", approval: { kind: "second_owner", keys: ["ads.fund"] } });
    const solo = change(owner(), staff(), ["ads.fund"], 1);
    expect(solo).toMatchObject({ effect: "allow", approval: { kind: "delayed", activatesAtMs: NOW + SENSITIVE_DELAY_MS } });
  });
  it("owner removing keys; demoting the last owner is last_owner", () => {
    expect(change(owner(), staff(), [])).toMatchObject({ effect: "allow", removed: [...PRESETS.support].sort() });
  });
  it("owner targets are never editable by permission change (owner strips another owner to [])", () => {
    expect(change(owner("o1"), owner("o2"), [], 2)).toMatchObject({ code: "target_not_manageable", httpStatus: 403 });
    expect(change(owner("o1"), owner("o2"), ["products.read"], 1)).toMatchObject({ code: "target_not_manageable" });
  });
  it("target holding a key the actor lacks is not manageable (cur not subset of held)", () => {
    const m = member("m4", ["team.manage", "products.read", "orders.read"]);
    expect(change(m, staff("s", ["products.read", "stock.read"]), ["products.read"])).toMatchObject({ code: "target_not_manageable" });
    expect(change(m, staff("s", ["products.read"]), ["products.read", "orders.read"])).toMatchObject({ effect: "allow" });
  });
  it("property: delegation never yields a key the granter lacks (non-owner) or a sensitive key", () => {
    fc.assert(fc.property(fc.subarray([...PERMISSION_KEYS]), fc.subarray([...PERMISSION_KEYS]), fc.subarray([...PERMISSION_KEYS]),
      (held, cur, next) => {
        const a = member("a", [...new Set([...held, "team.manage"])]);
        const t = member("t", cur.filter((k) => k !== "team.manage"));
        const d = change(a, t, next);
        if (d.effect === "deny") return true;
        return d.added.every((k) => a.permissions.includes(k) && !isSensitive(k));
      }));
  });
  it("property: nobody edits themselves", () => {
    fc.assert(fc.property(fc.subarray([...PERMISSION_KEYS]), fc.boolean(), fc.subarray([...PERMISSION_KEYS]), (p, isOwner, next) => {
      const m = member("same", p, { isOwner });
      const d = change(m, m, next);
      return d.effect === "deny" && (d.code === "self_edit_forbidden" || d.code === "permission_denied");
    }));
  });
});

describe("removal, approval, delay, grantable keys", () => {
  it("removal rules", () => {
    expect(decideMemberRemoval({ actor: manager(), target: { ...staff(), storeId: OTHER }, activeOwnerCount: 2 })).toMatchObject({ code: "not_found" });
    expect(decideMemberRemoval({ actor: owner("o1"), target: owner("o1"), activeOwnerCount: 1 })).toMatchObject({ code: "last_owner", httpStatus: 409 });
    expect(decideMemberRemoval({ actor: staff("s1"), target: staff("s1"), activeOwnerCount: 1 })).toEqual({ effect: "allow" });
    expect(decideMemberRemoval({ actor: staff("s1"), target: staff("s2"), activeOwnerCount: 1 })).toMatchObject({ code: "permission_denied" });
    expect(decideMemberRemoval({ actor: manager(), target: manager("m2"), activeOwnerCount: 1 })).toMatchObject({ code: "target_not_manageable" });
    expect(decideMemberRemoval({ actor: manager(), target: owner(), activeOwnerCount: 2 })).toMatchObject({ code: "target_not_manageable" });
    expect(decideMemberRemoval({ actor: manager(), target: staff("s", ["ads.fund"]), activeOwnerCount: 2 })).toMatchObject({ code: "target_not_manageable" });
    expect(decideMemberRemoval({ actor: member("m9", ["team.manage"]), target: staff("s", ["orders.read"]), activeOwnerCount: 2 })).toMatchObject({ code: "target_not_manageable" });
    expect(decideMemberRemoval({ actor: manager(), target: staff(), activeOwnerCount: 2 })).toEqual({ effect: "allow" });
    expect(decideMemberRemoval({ actor: owner("o1"), target: owner("o2"), activeOwnerCount: 2 })).toEqual({ effect: "allow" });
  });
  it("approval: requester cannot approve, only same-store pending owners that predate the request", () => {
    const base = { requesterUserId: "user-o1", requestedAtMs: NOW, expiresAtMs: NOW + SENSITIVE_DELAY_MS, nowMs: NOW + 1, storeId: STORE, status: "PENDING" as const };
    expect(decideGrantApproval({ ...base, approver: owner("o2") })).toEqual({ effect: "allow" });
    expect(decideGrantApproval({ ...base, approver: owner("o1") })).toMatchObject({ code: "same_person", httpStatus: 409 });
    expect(decideGrantApproval({ ...base, approver: { ...owner("o9"), userId: "user-o1" } })).toMatchObject({ code: "same_person" });
    expect(decideGrantApproval({ ...base, approver: manager() })).toMatchObject({ code: "not_owner" });
    expect(decideGrantApproval({ ...base, approver: { ...owner("o2"), storeId: OTHER } })).toMatchObject({ code: "not_found" });
    expect(decideGrantApproval({ ...base, status: "CANCELLED", approver: owner("o2") })).toMatchObject({ code: "not_pending" });
    expect(decideGrantApproval({ ...base, nowMs: NOW + SENSITIVE_DELAY_MS, approver: owner("o2") })).toMatchObject({ code: "expired" });
    expect(decideGrantApproval({ ...base, approver: { ...owner("o2"), ownerSinceMs: NOW + 1 } })).toMatchObject({ code: "owner_too_recent", httpStatus: 403 });
    expect(decideGrantApproval({ ...base, approver: { ...owner("o2"), ownerSinceMs: undefined } })).toMatchObject({ code: "owner_too_recent" });
  });
  it("attack: single owner A requests sensitive grant, transfer to colluding B, B self-approves", () => {
    const a = owner("oa");
    expect(change(a, staff("s9"), ["ads.fund"], 1)).toMatchObject({ approval: { kind: "delayed" } });
    const tReq = NOW;
    const grant = decideOwnerGrant({ via: "transfer_accept", actor: staff("b"), target: staff("b"), activeOwnerCount: 1, maxOwners: 3, nowMs: tReq + 1 });
    expect(grant).toMatchObject({ effect: "allow", approval: { kind: "delayed", activatesAtMs: tReq + 1 + SENSITIVE_DELAY_MS } });
    const bAsOwner = { ...staff("b"), isOwner: true, ownerSinceMs: tReq + 1 + SENSITIVE_DELAY_MS };
    expect(decideGrantApproval({ approver: bAsOwner, requesterUserId: a.userId, requestedAtMs: tReq, expiresAtMs: tReq + 2 * SENSITIVE_DELAY_MS, nowMs: tReq + 1 + SENSITIVE_DELAY_MS, storeId: STORE, status: "PENDING" }))
      .toMatchObject({ code: "owner_too_recent" });
  });
  it("owner grant: promotion / transfer accept rules", () => {
    const base = { activeOwnerCount: 2, maxOwners: 3, nowMs: NOW };
    expect(decideOwnerGrant({ ...base, via: "promotion", actor: owner(), target: manager() })).toMatchObject({ approval: { kind: "second_owner" } });
    expect(decideOwnerGrant({ ...base, activeOwnerCount: 1, via: "promotion", actor: owner(), target: manager() })).toMatchObject({ approval: { kind: "delayed" } });
    expect(decideOwnerGrant({ ...base, via: "promotion", actor: { ...owner(), storeId: OTHER }, target: manager() })).toMatchObject({ code: "not_found" });
    expect(decideOwnerGrant({ ...base, via: "promotion", actor: manager(), target: staff() })).toMatchObject({ code: "permission_denied" });
    expect(decideOwnerGrant({ ...base, via: "promotion", actor: owner(), target: { ...manager(), userId: "user-o1" } })).toMatchObject({ code: "self_edit_forbidden" });
    expect(decideOwnerGrant({ ...base, via: "transfer_accept", actor: staff("x"), target: staff("y") })).toMatchObject({ code: "self_edit_forbidden" });
    expect(decideOwnerGrant({ ...base, via: "promotion", actor: owner(), target: owner("o2") })).toMatchObject({ code: "target_not_manageable" });
    expect(decideOwnerGrant({ ...base, activeOwnerCount: 3, via: "promotion", actor: owner(), target: manager() })).toMatchObject({ code: "target_not_manageable" });
  });
  it("delayed grant activates only after the delay and when not cancelled", () => {
    expect(isDelayedGrantActive({ activatesAtMs: NOW, cancelled: false }, NOW - 1)).toBe(false);
    expect(isDelayedGrantActive({ activatesAtMs: NOW, cancelled: false }, NOW)).toBe(true);
    expect(isDelayedGrantActive({ activatesAtMs: NOW, cancelled: true }, NOW + 1)).toBe(false);
  });
  it("grantableKeys: owner all held, manager only non-sensitive", () => {
    expect(grantableKeys(owner())).toEqual([...PERMISSION_KEYS].sort());
    expect(grantableKeys(manager())).toContain("team.view");
    expect(grantableKeys(manager())).not.toContain("team.manage");
    expect(grantableKeys(member("x", ["bogus", "stock.read"]))).toEqual(["stock.read"]);
  });
  it("types: PermissionKey is the catalogue", () => {
    const k: PermissionKey = "stock.read";
    expect(isPermissionKey(k)).toBe(true);
  });
});
