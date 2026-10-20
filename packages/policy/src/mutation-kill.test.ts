import { describe, expect, it } from "vitest";
import { dbSessionContext, type Audience } from "./db-context";
import { assertValidRuleSet, decide, isAllowed, toPublicProblem } from "./decide";
import { InvalidRuleSetError, MalformedAuthzInputError } from "./errors";
import { parseAction, parseActor, parseResource } from "./parse";
import { createDefaultRules } from "./rules";
import {
  ACTIONS,
  ADMIN_ROLES,
  BRAND_ROLES,
  DENY_REASONS,
  RESOURCE_TYPES,
  type Action,
  type Actor,
  type AdminRole,
  type AuthzRequest,
  type Grant,
  type Resource,
  type ResourceType,
  type Rule,
} from "./types";

const NOW = 1_800_000_000_000;
const CFG = { refundDualApprovalAtOrAboveMinor: 500_000n, payoutDualApprovalAtOrAboveMinor: 2_000_000n };

const act = (id: string, grants: readonly Grant[], over: Partial<Actor> = {}): Actor => ({
  id,
  status: "active",
  assurance: grants.some((g) => g.kind === "admin") ? "passkey" : "basic",
  grants,
  tokenScopes: ["seller:read", "seller:write", "admin:access"],
  ...over,
});
const res = (type: ResourceType, over: Partial<Resource> = {}): Resource => ({
  type,
  id: `${type}-1`,
  state: "active",
  ...over,
});
const rq = (
  a: Actor | null,
  action: Action,
  r: Resource | null,
  over: Partial<AuthzRequest> = {},
): AuthzRequest => ({ actor: a, action, resourceType: r?.type ?? "order", resource: r, nowMs: NOW, ...over });
const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "r.test",
  resource: "order",
  actions: ["read"],
  grant: { kind: "shopper" },
  scope: "owner",
  ...over,
});
const owner = act("u1", [{ kind: "shopper" }]);
const mine = res("order", { ownerUserId: "u1" });

// ------------------------------------------------------------------ rules
describe("default rule set is exactly the reviewed policy", () => {
  type Expect = readonly [string, ResourceType, readonly Action[], Rule["grant"], Rule["scope"], Partial<Rule>];
  const ALL_ADMIN: AdminRole[] = ["ops", "finance", "trust_safety", "support", "marketing", "dpo", "security", "super_admin"];
  const shopper = (t: ResourceType, a: Action[]): Expect => [`shopper.${t}.owner`, t, a, { kind: "shopper" }, "owner", {}];
  const brandR = (
    t: ResourceType,
    suffix: string,
    a: Action[],
    roles: Extract<Rule["grant"], { kind: "brand" }>["roles"],
    s: "seller:read" | "seller:write",
  ): Expect => [`brand.${t}.${suffix}`, t, a, { kind: "brand", roles }, "store", { requiresTokenScope: s }];
  const adm = (
    id: string,
    t: ResourceType,
    a: Action[],
    roles: AdminRole[],
    extra: Partial<Rule> = {},
  ): Expect => [
    `admin.${id}`,
    t,
    a,
    { kind: "admin", roles },
    "platform",
    { requiresPasskey: true, requiresTokenScope: "admin:access", ...extra },
  ];
  const RW: Action[] = ["read", "create", "update", "delete"];
  const expected: Expect[] = [
    shopper("order", ["read", "update"]),
    shopper("cart", RW),
    shopper("address", RW),
    shopper("wishlist", RW),
    shopper("review", RW),
    shopper("return_request", ["read", "create", "update"]),
    shopper("store_credit", ["read"]),
    shopper("gift_card", ["read", "update"]),
    shopper("session", ["read", "delete"]),
    shopper("dsar_export", ["read", "create"]),
    ["plus.plus_benefit.owner", "plus_benefit", ["read", "update"], { kind: "plus" }, "owner", {}],
    brandR("store_product", "read", ["read"], ["owner", "manager", "catalog", "warehouse", "support", "finance"], "seller:read"),
    brandR("store_product", "write", ["create", "update", "delete"], ["owner", "manager", "catalog"], "seller:write"),
    brandR("store_inventory", "read", ["read"], ["owner", "manager", "catalog", "warehouse"], "seller:read"),
    brandR("store_inventory", "write", ["create", "update"], ["owner", "manager", "warehouse"], "seller:write"),
    brandR("store_order", "read", ["read"], ["owner", "manager", "warehouse", "support", "finance"], "seller:read"),
    brandR("store_order", "write", ["update"], ["owner", "manager", "warehouse"], "seller:write"),
    brandR("store_return", "read", ["read"], ["owner", "manager", "warehouse", "support"], "seller:read"),
    brandR("store_return", "write", ["update"], ["owner", "manager", "warehouse", "support"], "seller:write"),
    brandR("store_payout", "read", ["read"], ["owner", "manager", "finance"], "seller:read"),
    brandR("store_settings", "read", ["read"], ["owner", "manager"], "seller:read"),
    brandR("store_settings", "write", ["update"], ["owner"], "seller:write"),
    brandR("store_staff", "read", ["read"], ["owner", "manager"], "seller:read"),
    brandR("store_staff", "write", ["create", "update", "delete"], ["owner"], "seller:write"),
    adm("admin_console.access", "admin_console", ["read"], ALL_ADMIN),
    adm("refund.request", "refund", ["read", "create"], ["support", "finance"]),
    adm("refund.approve", "refund", ["approve"], ["finance"], {
      dualApproval: { kind: "at_or_above", thresholdMinor: 500_000n },
    }),
    adm("payout.read", "payout", ["read"], ["finance", "ops"]),
    adm("payout.approve", "payout", ["approve"], ["finance"], {
      dualApproval: { kind: "at_or_above", thresholdMinor: 2_000_000n },
    }),
    adm("pii_view.read", "pii_view", ["read"], ["support", "trust_safety", "dpo"], { requiresReason: true }),
    adm("data_export.create", "data_export", ["create", "export"], ["dpo"], {
      dualApproval: { kind: "always" },
      requiresReason: true,
    }),
    adm("role_grant.grant", "role_grant", ["grant"], ["super_admin"], {
      dualApproval: { kind: "always" },
      requiresReason: true,
    }),
    adm("plan_price.update", "plan_price", ["update"], ["finance"], { dualApproval: { kind: "always" } }),
    adm("audit_log.read", "audit_log", ["read"], ["dpo", "security", "super_admin"]),
    adm("feature_flag.update", "feature_flag", ["read", "update"], ["ops"]),
    adm("break_glass.invoke", "break_glass", ["invoke"], ["super_admin"], {
      dualApproval: { kind: "always" },
      requiresReason: true,
    }),
    ["courier.courier_task.hub", "courier_task", ["read", "update"], { kind: "courier" }, "hub", {}],
    ["creator.creator_link.self", "creator_link", ["read", "create", "update"], { kind: "creator" }, "creator", {}],
    ["creator.creator_payout.self", "creator_payout", ["read"], { kind: "creator" }, "creator", {}],
  ];

  it("matches rule by rule, in order, with no extra keys", () => {
    const rules = createDefaultRules(CFG);
    expect(rules).toHaveLength(expected.length);
    rules.forEach((got, i) => {
      const [id, resource, actions, grant, scope, extra] = expected[i] as Expect;
      expect(got).toStrictEqual({ id, resource, actions, grant, scope, ...extra });
    });
  });
  it("uses the supplied thresholds, not constants", () => {
    const rules = createDefaultRules({ refundDualApprovalAtOrAboveMinor: 7n, payoutDualApprovalAtOrAboveMinor: 9n });
    expect(rules.find((r) => r.id === "admin.refund.approve")?.dualApproval).toEqual({
      kind: "at_or_above",
      thresholdMinor: 7n,
    });
    expect(rules.find((r) => r.id === "admin.payout.approve")?.dualApproval).toEqual({
      kind: "at_or_above",
      thresholdMinor: 9n,
    });
  });
});

// ------------------------------------------------------------------ decide
describe("decide: early denials and audit records", () => {
  it("unauthenticated is 401 with a null actor and null resource id", () => {
    const d = decide(rq(null, "read", null), [rule()]);
    expect(d).toEqual({
      effect: "deny",
      httpStatus: 401,
      reason: "unauthenticated",
      audit: {
        effect: "deny",
        actorId: null,
        action: "read",
        resourceType: "order",
        resourceId: null,
        ruleId: null,
        reason: "unauthenticated",
        httpStatus: 401,
        approverIds: [],
        atMs: NOW,
      },
    });
  });
  it("suspended and deleted actors are 403 and audited with the resource id", () => {
    const s = decide(rq({ ...owner, status: "suspended" }, "read", mine), [rule()]);
    expect(s).toMatchObject({ effect: "deny", httpStatus: 403, reason: "actor_suspended" });
    expect(s.audit).toMatchObject({ actorId: "u1", resourceId: "order-1", ruleId: null, approverIds: [] });
    const d = decide(rq({ ...owner, status: "deleted" }, "read", mine), [rule()]);
    expect(d).toMatchObject({ reason: "actor_deleted", httpStatus: 403 });
  });
  it("no rule for the resource type or action", () => {
    expect(decide(rq(owner, "read", mine), [])).toMatchObject({ reason: "no_rule", httpStatus: 403 });
    expect(decide(rq(owner, "delete", mine), [rule()])).toMatchObject({ reason: "no_rule" });
    expect(decide(rq(owner, "read", res("cart", { ownerUserId: "u1" })), [rule()])).toMatchObject({
      reason: "no_rule",
    });
  });
  it("allow carries the rule id and a full audit record", () => {
    const d = decide(rq(owner, "read", mine), [rule({ id: "r.first" }), rule({ id: "r.second" })]);
    expect(d).toEqual({
      effect: "allow",
      ruleId: "r.first",
      httpStatus: 200,
      approverIds: [],
      audit: {
        effect: "allow",
        actorId: "u1",
        action: "read",
        resourceType: "order",
        resourceId: "order-1",
        ruleId: "r.first",
        reason: "allowed",
        httpStatus: 200,
        approverIds: [],
        atMs: NOW,
      },
    });
    expect(isAllowed(rq(owner, "read", mine), [rule()])).toBe(true);
    expect(isAllowed(rq(owner, "read", mine), [])).toBe(false);
  });
  it("public problems hide internal reasons", () => {
    const deny = (status: 401 | 403 | 404) =>
      ({ effect: "deny", httpStatus: status, reason: "not_owned", audit: {} as never }) as const;
    expect(toPublicProblem(deny(401))).toEqual({ status: 401, code: "unauthenticated" });
    expect(toPublicProblem(deny(403))).toEqual({ status: 403, code: "forbidden" });
    expect(toPublicProblem(deny(404))).toEqual({ status: 404, code: "not_found" });
    expect(toPublicProblem(decide(rq(owner, "read", mine), [rule()]))).toEqual({ status: 200, code: "ok" });
  });
});

describe("decide: grant matching and expiry", () => {
  it("shopper rules accept plus grants, plus rules do not accept shoppers", () => {
    const plus = act("p", [{ kind: "plus" }]);
    const m = res("order", { ownerUserId: "p" });
    expect(isAllowed(rq(plus, "read", m), [rule()])).toBe(true);
    const pr = rule({ resource: "plus_benefit", grant: { kind: "plus" } });
    const pm = res("plus_benefit", { ownerUserId: "u1" });
    expect(decide(rq(owner, "read", pm), [pr])).toMatchObject({ reason: "missing_role", httpStatus: 403 });
    expect(isAllowed(rq(act("u1", [{ kind: "plus" }]), "read", pm), [pr])).toBe(true);
  });
  it("brand matcher checks role membership; courier and creator match by kind", () => {
    const br = rule({
      resource: "store_order",
      grant: { kind: "brand", roles: ["owner"] },
      scope: "store",
    });
    const so = res("store_order", { storeId: "s1" });
    const mgr = act("m", [{ kind: "brand", storeId: "s1", role: "manager" }]);
    const own = act("o", [{ kind: "brand", storeId: "s1", role: "owner" }]);
    expect(decide(rq(mgr, "read", so), [br])).toMatchObject({ reason: "missing_role" });
    expect(isAllowed(rq(own, "read", so), [br])).toBe(true);
    // an admin grant with a role named like a brand role must not match a brand matcher
    expect(decide(rq(act("a", [{ kind: "admin", role: "ops" }]), "read", so), [br])).toMatchObject({
      reason: "missing_role",
    });
    const cr = rule({ resource: "courier_task", grant: { kind: "courier" }, scope: "hub" });
    const ct = res("courier_task", { hubId: "h" });
    expect(isAllowed(rq(act("c", [{ kind: "courier", hubId: "h" }]), "read", ct), [cr])).toBe(true);
    expect(decide(rq(act("c", [{ kind: "creator", creatorId: "h" }]), "read", ct), [cr])).toMatchObject({
      reason: "missing_role",
    });
  });
  it("admin grants expire strictly after expiresAtMs; others never expire", () => {
    const ar = rule({
      resource: "audit_log",
      grant: { kind: "admin", roles: ["dpo"] },
      scope: "platform",
      requiresPasskey: true,
    });
    const al = res("audit_log");
    const withExp = (exp?: number) =>
      act("a", [exp === undefined ? { kind: "admin", role: "dpo" } : { kind: "admin", role: "dpo", expiresAtMs: exp }]);
    expect(isAllowed(rq(withExp(NOW + 1), "read", al), [ar])).toBe(true);
    expect(decide(rq(withExp(NOW), "read", al), [ar])).toMatchObject({ reason: "grant_expired", httpStatus: 403 });
    expect(decide(rq(withExp(NOW - 1), "read", al), [ar])).toMatchObject({ reason: "grant_expired" });
    expect(isAllowed(rq(withExp(undefined), "read", al), [ar])).toBe(true);
    // a live second grant wins over an expired one
    const both = act("a", [
      { kind: "admin", role: "dpo", expiresAtMs: NOW - 5 },
      { kind: "admin", role: "dpo" },
    ]);
    expect(isAllowed(rq(both, "read", al), [ar])).toBe(true);
    // not holding the role at all is missing_role, not grant_expired
    expect(decide(rq(act("a", [{ kind: "admin", role: "ops" }]), "read", al), [ar])).toMatchObject({
      reason: "missing_role",
    });
    // an expired grant of a different matcher kind is not "expired" for this rule
    expect(decide(rq(act("a", []), "read", al), [ar])).toMatchObject({ reason: "missing_role" });
  });
});

describe("decide: gates, resource and scope", () => {
  it("token scope and passkey gates", () => {
    const g = rule({
      resource: "store_order",
      grant: { kind: "brand", roles: ["manager"] },
      scope: "store",
      requiresTokenScope: "seller:read",
    });
    const so = res("store_order", { storeId: "s1" });
    const base = act("m", [{ kind: "brand", storeId: "s1", role: "manager" }]);
    expect(isAllowed(rq(base, "read", so), [g])).toBe(true);
    expect(decide(rq({ ...base, tokenScopes: [] }, "read", so), [g])).toMatchObject({
      reason: "missing_token_scope",
      httpStatus: 403,
    });
    const pk = rule({ requiresPasskey: true });
    expect(decide(rq(owner, "read", mine), [pk])).toMatchObject({ reason: "passkey_required", httpStatus: 403 });
    expect(isAllowed(rq({ ...owner, assurance: "passkey" }, "read", mine), [pk])).toBe(true);
    expect(isAllowed(rq(owner, "read", mine), [rule({ requiresPasskey: false })])).toBe(true);
  });
  it("resource missing, wrong type, deleted", () => {
    expect(decide(rq(owner, "read", null), [rule()])).toMatchObject({ reason: "resource_not_found", httpStatus: 404 });
    const wrong = rq(owner, "read", res("cart", { ownerUserId: "u1" }), { resourceType: "order" });
    expect(decide(wrong, [rule()])).toMatchObject({ reason: "resource_not_found", httpStatus: 404 });
    const del = res("order", { ownerUserId: "u1", state: "deleted" });
    expect(decide(rq(owner, "read", del), [rule()])).toMatchObject({ reason: "resource_deleted", httpStatus: 404 });
    expect(isAllowed(rq(owner, "read", del), [rule({ allowDeleted: true })])).toBe(true);
    expect(decide(rq(owner, "read", del), [rule({ allowDeleted: false })])).toMatchObject({
      reason: "resource_deleted",
    });
  });
  it("owner scope", () => {
    expect(decide(rq(owner, "read", res("order")), [rule()])).toMatchObject({ reason: "not_owned", httpStatus: 404 });
    expect(decide(rq(owner, "read", res("order", { ownerUserId: "other" })), [rule()])).toMatchObject({
      reason: "not_owned",
    });
  });
  it("store scope uses the live brand grants only", () => {
    const sr = rule({ resource: "store_order", grant: { kind: "brand", roles: ["manager"] }, scope: "store" });
    const so = res("store_order", { storeId: "s2" });
    const a = act("m", [
      { kind: "brand", storeId: "s1", role: "manager" },
      { kind: "brand", storeId: "s2", role: "manager" },
    ]);
    expect(isAllowed(rq(a, "read", so), [sr])).toBe(true);
    expect(decide(rq(a, "read", res("store_order")), [sr])).toMatchObject({ reason: "not_owned" });
    expect(decide(rq(a, "read", res("store_order", { storeId: "s3" })), [sr])).toMatchObject({
      reason: "not_owned",
    });
    // a brand grant for the store with a role the rule does not accept must not widen scope
    const mixed = act("m", [
      { kind: "brand", storeId: "s1", role: "manager" },
      { kind: "brand", storeId: "s2", role: "support" },
    ]);
    expect(decide(rq(mixed, "read", so), [sr])).toMatchObject({ reason: "not_owned" });
  });
  it("hub and creator scopes", () => {
    const hr = rule({ resource: "courier_task", grant: { kind: "courier" }, scope: "hub" });
    const ct = (hubId?: string) => res("courier_task", hubId === undefined ? {} : { hubId });
    const c = act("c", [{ kind: "courier", hubId: "h1" }]);
    expect(isAllowed(rq(c, "read", ct("h1")), [hr])).toBe(true);
    expect(decide(rq(c, "read", ct("h2")), [hr])).toMatchObject({ reason: "not_owned", httpStatus: 404 });
    expect(decide(rq(c, "read", ct()), [hr])).toMatchObject({ reason: "not_owned" });
    const cr = rule({ resource: "creator_link", grant: { kind: "creator" }, scope: "creator" });
    const cl = (creatorId?: string) => res("creator_link", creatorId === undefined ? {} : { creatorId });
    const k = act("k", [{ kind: "creator", creatorId: "c1" }]);
    expect(isAllowed(rq(k, "read", cl("c1")), [cr])).toBe(true);
    expect(decide(rq(k, "read", cl("c2")), [cr])).toMatchObject({ reason: "not_owned" });
    expect(decide(rq(k, "read", cl()), [cr])).toMatchObject({ reason: "not_owned" });
  });
  it("reports the failure of the furthest stage and keeps the first on ties", () => {
    const stageRole = rule({ id: "a", grant: { kind: "plus" } });
    const stageScope = rule({ id: "b" });
    expect(decide(rq(owner, "read", res("order")), [stageRole, stageScope])).toMatchObject({ reason: "not_owned" });
    expect(decide(rq(owner, "read", res("order")), [stageScope, stageRole])).toMatchObject({ reason: "not_owned" });
    // equal stage: first wins
    const gateA = rule({ id: "g1", requiresTokenScope: "x:y" });
    const gateB = rule({ id: "g2", requiresPasskey: true });
    expect(decide(rq(owner, "read", mine), [gateA, gateB])).toMatchObject({ reason: "missing_token_scope" });
    expect(decide(rq(owner, "read", mine), [gateB, gateA])).toMatchObject({ reason: "passkey_required" });
    // a later stage beats an earlier one regardless of order
    const reason = rule({ id: "r", requiresReason: true });
    expect(decide(rq(owner, "read", mine), [gateA, reason])).toMatchObject({ reason: "reason_required" });
    expect(decide(rq(owner, "read", mine), [reason, gateA])).toMatchObject({ reason: "reason_required" });
  });
  it("an allowing rule wins even after earlier rules failed", () => {
    const denied = rule({ id: "no", grant: { kind: "plus" } });
    const ok = rule({ id: "yes" });
    expect(decide(rq(owner, "read", mine), [denied, ok])).toMatchObject({ effect: "allow", ruleId: "yes" });
  });
});

describe("decide: reason and dual approval", () => {
  const reasonRule = rule({ requiresReason: true });
  it("reason is mandatory, whitespace does not count", () => {
    for (const r of [undefined, "", "   ", "\t\n"]) {
      const over = r === undefined ? {} : { reason: r };
      expect(decide(rq(owner, "read", mine, over), [reasonRule])).toMatchObject({
        reason: "reason_required",
        httpStatus: 403,
      });
    }
    expect(isAllowed(rq(owner, "read", mine, { reason: "ticket-1" }), [reasonRule])).toBe(true);
    expect(isAllowed(rq(owner, "read", mine), [rule({ requiresReason: false })])).toBe(true);
  });

  const finRule = (dual: Rule["dualApproval"]): Rule =>
    rule({
      id: "fin",
      resource: "refund",
      actions: ["approve"],
      grant: { kind: "admin", roles: ["finance"] },
      scope: "platform",
      requiresPasskey: true,
      ...(dual === undefined ? {} : { dualApproval: dual }),
    });
  const requester = act("req", [{ kind: "admin", role: "finance" }]);
  const approver = (id: string, over: Partial<Actor> = {}): Actor =>
    act(id, [{ kind: "admin", role: "finance" }], over);
  const target = (amount?: bigint) => res("refund", amount === undefined ? {} : { amountMinor: amount });
  const th = { kind: "at_or_above", thresholdMinor: 1000n } as const;

  it("threshold: below is single-approver, at or above (or unknown) needs a second admin", () => {
    expect(isAllowed(rq(requester, "approve", target(999n)), [finRule(th)])).toBe(true);
    const at = decide(rq(requester, "approve", target(1000n)), [finRule(th)]);
    expect(at).toMatchObject({ reason: "dual_approval_required", httpStatus: 403 });
    expect(decide(rq(requester, "approve", target(1001n)), [finRule(th)])).toMatchObject({
      reason: "dual_approval_required",
    });
    expect(decide(rq(requester, "approve", target()), [finRule(th)])).toMatchObject({
      reason: "dual_approval_required",
    });
    expect(isAllowed(rq(requester, "approve", target(1n)), [finRule(undefined)])).toBe(true);
    expect(decide(rq(requester, "approve", target(1n)), [finRule({ kind: "always" })])).toMatchObject({
      reason: "dual_approval_required",
    });
  });
  it("accepts valid approvers, sorted and de-duplicated, and records them", () => {
    const d = decide(
      rq(requester, "approve", target(5000n), { approvals: [approver("zed"), approver("amy"), approver("zed")] }),
      [finRule(th)],
    );
    expect(d.effect).toBe("allow");
    if (d.effect === "allow") {
      expect(d.approverIds).toEqual(["amy", "zed"]);
      expect(d.audit.approverIds).toEqual(["amy", "zed"]);
    }
  });
  it("rejects approvers that do not count", () => {
    const deny = (approvals: Actor[]) =>
      decide(rq(requester, "approve", target(5000n), { approvals }), [finRule({ kind: "always" })]);
    expect(deny([]).effect).toBe("deny");
    expect(deny([requester]).effect).toBe("deny"); // self-approval
    expect(deny([approver("a", { status: "suspended" })]).effect).toBe("deny");
    expect(deny([approver("a", { status: "deleted" })]).effect).toBe("deny");
    expect(deny([approver("a", { assurance: "basic" })]).effect).toBe("deny");
    expect(deny([act("a", [{ kind: "admin", role: "ops" }])]).effect).toBe("deny"); // wrong role
    expect(deny([act("a", [{ kind: "admin", role: "finance", expiresAtMs: NOW }])]).effect).toBe("deny");
    expect(deny([act("a", [{ kind: "shopper" }], { assurance: "passkey" })]).effect).toBe("deny");
    // a valid approver after invalid ones still counts
    expect(deny([requester, approver("a", { status: "suspended" }), approver("ok")]).effect).toBe("allow");
    // expired approver grant is fine if another live grant exists
    expect(
      deny([
        act("b", [
          { kind: "admin", role: "finance", expiresAtMs: NOW - 1 },
          { kind: "admin", role: "finance", expiresAtMs: NOW + 1 },
        ]),
      ]).effect,
    ).toBe("allow");
  });
  it("approvals on a rule with a non-admin grant never satisfy", () => {
    const odd = rule({ dualApproval: { kind: "always" } });
    const d = decide(rq(owner, "read", mine, { approvals: [approver("a")] }), [odd]);
    expect(d).toMatchObject({ effect: "deny", reason: "dual_approval_required" });
  });
  it("reason is checked before approvals", () => {
    const both = rule({ requiresReason: true, dualApproval: { kind: "always" } });
    expect(decide(rq(owner, "read", mine), [both])).toMatchObject({ reason: "reason_required" });
    expect(decide(rq(owner, "read", mine, { reason: "x" }), [both])).toMatchObject({
      reason: "dual_approval_required",
    });
  });
});

describe("assertValidRuleSet messages", () => {
  const ok = (r: Rule) => expect(() => assertValidRuleSet([r])).not.toThrow();
  const bad = (rs: Rule[], msg: string) => {
    expect(() => assertValidRuleSet(rs)).toThrow(InvalidRuleSetError);
    expect(() => assertValidRuleSet(rs)).toThrow(msg);
  };
  it("accepts consistent rules of every shape", () => {
    ok(rule());
    ok(rule({ grant: { kind: "plus" } }));
    ok(rule({ resource: "store_order", grant: { kind: "brand", roles: ["owner"] }, scope: "store" }));
    ok(rule({ resource: "courier_task", grant: { kind: "courier" }, scope: "hub" }));
    ok(rule({ resource: "creator_link", grant: { kind: "creator" }, scope: "creator" }));
    ok(
      rule({
        resource: "refund",
        grant: { kind: "admin", roles: ["finance"] },
        scope: "platform",
        requiresPasskey: true,
        dualApproval: { kind: "always" },
      }),
    );
    expect(() => assertValidRuleSet([])).not.toThrow();
  });
  it("rejects each inconsistency with its message", () => {
    bad([rule({ id: "dup" }), rule({ id: "dup" })], "duplicate rule id dup");
    bad([rule({ id: "x", actions: [] })], "rule x has no actions");
    bad([rule({ id: "x", dualApproval: { kind: "always" } })], "rule x: dual approval is only defined for admin grants");
    bad(
      [rule({ id: "x", grant: { kind: "admin", roles: ["ops"] }, scope: "platform" })],
      "rule x: admin rules must require a passkey",
    );
    bad(
      [rule({ id: "x", grant: { kind: "admin", roles: ["ops"] }, scope: "platform", requiresPasskey: false })],
      "rule x: admin rules must require a passkey",
    );
    bad(
      [rule({ id: "x", grant: { kind: "courier" }, scope: "owner" })],
      "rule x: owner scope applies to shopper grants only",
    );
    bad(
      [rule({ id: "x", scope: "store" })],
      "rule x: store scope applies to brand grants only",
    );
    bad(
      [rule({ id: "x", scope: "hub" })],
      "rule x: hub scope applies to courier grants only",
    );
    bad(
      [rule({ id: "x", scope: "creator" })],
      "rule x: creator scope applies to creator grants only",
    );
  });
});

// ------------------------------------------------------------------ parse
describe("parseActor / parseResource / parseAction", () => {
  const valid = {
    id: "u1",
    status: "active",
    assurance: "basic",
    grants: [{ kind: "shopper" }],
    tokenScopes: ["a:b"],
  };
  const thrown = (fn: () => unknown, msg: string) => {
    expect(fn).toThrow(MalformedAuthzInputError);
    expect(fn).toThrow(msg);
  };

  it("parses a full actor with every grant kind", () => {
    const a = parseActor({
      ...valid,
      grants: [
        { kind: "shopper" },
        { kind: "plus" },
        { kind: "brand", storeId: "s1", role: "owner" },
        { kind: "admin", role: "ops" },
        { kind: "admin", role: "dpo", expiresAtMs: 5 },
        { kind: "courier", hubId: "h" },
        { kind: "creator", creatorId: "c" },
      ],
      tokenScopes: ["x", "y"],
      extra: "ignored",
    });
    expect(a).toStrictEqual({
      id: "u1",
      status: "active",
      assurance: "basic",
      grants: [
        { kind: "shopper" },
        { kind: "plus" },
        { kind: "brand", storeId: "s1", role: "owner" },
        { kind: "admin", role: "ops" },
        { kind: "admin", role: "dpo", expiresAtMs: 5 },
        { kind: "courier", hubId: "h" },
        { kind: "creator", creatorId: "c" },
      ],
      tokenScopes: ["x", "y"],
    });
  });
  it("accepts every declared role, status and assurance", () => {
    for (const role of BRAND_ROLES) expect(() => parseActor({ ...valid, grants: [{ kind: "brand", storeId: "s", role }] })).not.toThrow();
    for (const role of ADMIN_ROLES) expect(() => parseActor({ ...valid, grants: [{ kind: "admin", role }] })).not.toThrow();
    for (const status of ["active", "suspended", "deleted"]) expect(parseActor({ ...valid, status }).status).toBe(status);
    expect(parseActor({ ...valid, assurance: "passkey" }).assurance).toBe("passkey");
  });
  it("rejects bad shapes with specific messages", () => {
    thrown(() => parseActor(null), "actor: not an object");
    thrown(() => parseActor([]), "actor: not an object");
    thrown(() => parseActor("x"), "actor: not an object");
    thrown(() => parseActor({ ...valid, grants: "x" }), "actor.grants");
    thrown(() => parseActor({ ...valid, tokenScopes: {} }), "actor.tokenScopes");
    thrown(() => parseActor({ ...valid, id: "" }), "actor.id: not a string id");
    thrown(() => parseActor({ ...valid, id: 5 }), "actor.id: not a string id");
    thrown(() => parseActor({ ...valid, id: "x".repeat(129) }), "actor.id: not a string id");
    expect(parseActor({ ...valid, id: "x".repeat(128) }).id).toHaveLength(128);
    thrown(() => parseActor({ ...valid, status: "frozen" }), "actor.status: unexpected value");
    thrown(() => parseActor({ ...valid, assurance: "none" }), "actor.assurance: unexpected value");
    thrown(() => parseActor({ ...valid, tokenScopes: [""] }), "actor.tokenScopes[]: not a string id");
    thrown(() => parseActor({ ...valid, grants: [null] }), "grant: not an object");
    thrown(() => parseActor({ ...valid, grants: [{ kind: "root" }] }), "grant.kind: unexpected value");
    thrown(() => parseActor({ ...valid, grants: [{ kind: "brand", role: "owner" }] }), "grant.storeId: not a string id");
    thrown(() => parseActor({ ...valid, grants: [{ kind: "brand", storeId: "s", role: "god" }] }), "grant.role: unexpected value");
    thrown(() => parseActor({ ...valid, grants: [{ kind: "admin", role: "god" }] }), "grant.role: unexpected value");
    thrown(() => parseActor({ ...valid, grants: [{ kind: "admin", role: "ops", expiresAtMs: "9" }] }), "grant.expiresAtMs");
    thrown(() => parseActor({ ...valid, grants: [{ kind: "admin", role: "ops", expiresAtMs: NaN }] }), "grant.expiresAtMs");
    thrown(() => parseActor({ ...valid, grants: [{ kind: "admin", role: "ops", expiresAtMs: Infinity }] }), "grant.expiresAtMs");
    thrown(() => parseActor({ ...valid, grants: [{ kind: "courier" }] }), "grant.hubId: not a string id");
    thrown(() => parseActor({ ...valid, grants: [{ kind: "creator" }] }), "grant.creatorId: not a string id");
  });
  it("parseResource keeps only defined optional fields", () => {
    expect(parseResource({ type: "order", id: "o1", state: "active" })).toStrictEqual({
      type: "order",
      id: "o1",
      state: "active",
    });
    expect(
      parseResource({
        type: "store_order",
        id: "o1",
        state: "deleted",
        ownerUserId: "u",
        storeId: "s",
        hubId: "h",
        creatorId: "c",
        amountMinor: 5n,
      }),
    ).toStrictEqual({
      type: "store_order",
      id: "o1",
      state: "deleted",
      ownerUserId: "u",
      storeId: "s",
      hubId: "h",
      creatorId: "c",
      amountMinor: 5n,
    });
    expect(parseResource({ type: "order", id: "o", state: "active", amountMinor: 0n }).amountMinor).toBe(0n);
    for (const t of RESOURCE_TYPES) expect(parseResource({ type: t, id: "i", state: "active" }).type).toBe(t);
  });
  it("parseResource rejects bad input with messages", () => {
    const base = { type: "order", id: "o1", state: "active" };
    thrown(() => parseResource(undefined), "resource: not an object");
    thrown(() => parseResource({ ...base, amountMinor: 5 }), "resource.amountMinor must be bigint");
    thrown(() => parseResource({ ...base, type: "nope" }), "resource.type: unexpected value");
    thrown(() => parseResource({ ...base, id: "" }), "resource.id: not a string id");
    thrown(() => parseResource({ ...base, state: "gone" }), "resource.state: unexpected value");
    thrown(() => parseResource({ ...base, ownerUserId: "" }), "resource.ownerUserId: not a string id");
    thrown(() => parseResource({ ...base, storeId: 1 }), "resource.storeId: not a string id");
    thrown(() => parseResource({ ...base, hubId: "" }), "resource.hubId: not a string id");
    thrown(() => parseResource({ ...base, creatorId: "" }), "resource.creatorId: not a string id");
  });
  it("parseAction", () => {
    for (const a of ACTIONS) expect(parseAction(a)).toBe(a);
    thrown(() => parseAction("destroy"), "action: unexpected value");
    expect(DENY_REASONS).toContain("malformed_request");
  });
});

// ------------------------------------------------------------------ db context
describe("dbSessionContext", () => {
  const shopperCtx = (a: Actor, aud: Audience, now = NOW) => dbSessionContext(a, aud, now);
  it("shopper audience needs a shopper or plus grant", () => {
    expect(shopperCtx(act("u", [{ kind: "shopper" }]), { kind: "shopper" })).toStrictEqual({
      userId: "u",
      role: "customer",
      storeIds: [],
    });
    expect(shopperCtx(act("u", [{ kind: "plus" }]), { kind: "shopper" })?.role).toBe("customer");
    expect(shopperCtx(act("u", [{ kind: "courier", hubId: "h" }]), { kind: "shopper" })).toBeNull();
  });
  it("seller audience lists distinct sorted store ids", () => {
    const a = act("s", [
      { kind: "brand", storeId: "b", role: "manager" },
      { kind: "brand", storeId: "a", role: "owner" },
      { kind: "brand", storeId: "b", role: "support" },
      { kind: "shopper" },
    ]);
    expect(shopperCtx(a, { kind: "seller" })).toStrictEqual({ userId: "s", role: "seller", storeIds: ["a", "b"] });
    expect(shopperCtx(act("s", [{ kind: "shopper" }]), { kind: "seller" })).toBeNull();
  });
  it("admin audience needs the exact live role and a passkey and maps to its db role", () => {
    for (const role of ADMIN_ROLES) {
      const a = act("a", [{ kind: "admin", role }]);
      expect(shopperCtx(a, { kind: "admin", role })).toStrictEqual({ userId: "a", role, storeIds: [] });
    }
    const ops = act("a", [{ kind: "admin", role: "ops" }]);
    expect(shopperCtx(ops, { kind: "admin", role: "finance" })).toBeNull();
    expect(shopperCtx({ ...ops, assurance: "basic" }, { kind: "admin", role: "ops" })).toBeNull();
    const exp = (e: number) => act("a", [{ kind: "admin", role: "ops", expiresAtMs: e }]);
    expect(shopperCtx(exp(NOW + 1), { kind: "admin", role: "ops" })).not.toBeNull();
    expect(shopperCtx(exp(NOW), { kind: "admin", role: "ops" })).toBeNull();
    // a non-admin grant never satisfies the admin audience
    expect(shopperCtx(act("a", [{ kind: "shopper" }], { assurance: "passkey" }), { kind: "admin", role: "ops" })).toBeNull();
  });
  it("courier and creator audiences", () => {
    expect(shopperCtx(act("c", [{ kind: "courier", hubId: "h" }]), { kind: "courier" })).toStrictEqual({
      userId: "c",
      role: "courier",
      storeIds: [],
    });
    expect(shopperCtx(act("c", [{ kind: "creator", creatorId: "k" }]), { kind: "creator" })).toStrictEqual({
      userId: "c",
      role: "creator",
      storeIds: [],
    });
    expect(shopperCtx(act("c", [{ kind: "shopper" }]), { kind: "courier" })).toBeNull();
    expect(shopperCtx(act("c", [{ kind: "shopper" }]), { kind: "creator" })).toBeNull();
  });
  it("non-active actors get no context", () => {
    for (const status of ["suspended", "deleted"] as const) {
      expect(shopperCtx(act("u", [{ kind: "shopper" }], { status }), { kind: "shopper" })).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ cross-kind confusion
describe("grant kinds with overlapping role names never cross over", () => {
  it("an admin 'support' grant does not satisfy a brand matcher containing 'support'", () => {
    const br = rule({
      resource: "store_order",
      grant: { kind: "brand", roles: ["support", "finance"] },
      scope: "platform",
    });
    const so = res("store_order", { storeId: "s1" });
    const adminSupport = act("a", [{ kind: "admin", role: "support" }]);
    expect(decide(rq(adminSupport, "read", so), [br])).toMatchObject({ reason: "missing_role" });
    const brandSupport = act("b", [{ kind: "brand", storeId: "s1", role: "support" }]);
    expect(isAllowed(rq(brandSupport, "read", so), [br])).toBe(true);
  });
  it("a brand 'support' grant does not give the admin db role", () => {
    const a = act("b", [{ kind: "brand", storeId: "s1", role: "support" }], { assurance: "passkey" });
    expect(dbSessionContext(a, { kind: "admin", role: "support" }, NOW)).toBeNull();
    const f = act("b", [{ kind: "brand", storeId: "s1", role: "finance" }], { assurance: "passkey" });
    expect(dbSessionContext(f, { kind: "admin", role: "finance" }, NOW)).toBeNull();
  });
  it("audiences are satisfied by any matching grant, not only when all grants match", () => {
    const mixed = act("m", [
      { kind: "brand", storeId: "s1", role: "owner" },
      { kind: "shopper" },
      { kind: "courier", hubId: "h" },
      { kind: "creator", creatorId: "c" },
    ]);
    expect(dbSessionContext(mixed, { kind: "shopper" }, NOW)?.role).toBe("customer");
    expect(dbSessionContext(mixed, { kind: "courier" }, NOW)?.role).toBe("courier");
    expect(dbSessionContext(mixed, { kind: "creator" }, NOW)?.role).toBe("creator");
  });
  it("hub and creator scope match any one of several grants", () => {
    const hr = rule({ resource: "courier_task", grant: { kind: "courier" }, scope: "hub" });
    const c = act("c", [
      { kind: "courier", hubId: "h1" },
      { kind: "courier", hubId: "h2" },
    ]);
    expect(isAllowed(rq(c, "read", res("courier_task", { hubId: "h2" })), [hr])).toBe(true);
    const cr = rule({ resource: "creator_link", grant: { kind: "creator" }, scope: "creator" });
    const k = act("k", [
      { kind: "creator", creatorId: "c1" },
      { kind: "creator", creatorId: "c2" },
    ]);
    expect(isAllowed(rq(k, "read", res("creator_link", { creatorId: "c2" })), [cr])).toBe(true);
  });
  it("approvals on a shopper-grant rule with dual approval are never accepted", () => {
    const odd = rule({ dualApproval: { kind: "always" } });
    const fakeApprover = act("z", [{ kind: "shopper" }], { assurance: "passkey" });
    expect(decide(rq(owner, "read", mine, { approvals: [fakeApprover] }), [odd])).toMatchObject({
      effect: "deny",
      reason: "dual_approval_required",
    });
  });
});
