import fc from "fast-check";
import { describe, it } from "vitest";
import { decide } from "./decide";
import { dbSessionContext } from "./db-context";
import { NOW, RULES, actor } from "./test-fixtures";
import {
  ACTIONS, ADMIN_ROLES, BRAND_ROLES, RESOURCE_TYPES,
  type Actor, type AuthzRequest, type Grant, type GrantMatcher, type Resource, type Rule, type Scope,
} from "./types";

const id = fc.constantFrom("u1", "u2", "u3");
const store = fc.constantFrom("s1", "s2");

const grant: fc.Arbitrary<Grant> = fc.oneof(
  fc.constant<Grant>({ kind: "shopper" }),
  fc.constant<Grant>({ kind: "plus" }),
  fc.record({ kind: fc.constant("brand" as const), storeId: store, role: fc.constantFrom(...BRAND_ROLES) }),
  fc.record({ kind: fc.constant("admin" as const), role: fc.constantFrom(...ADMIN_ROLES), expiresAtMs: fc.option(fc.integer({ min: NOW - 10, max: NOW + 10 }), { nil: undefined }) })
    .map((g): Grant => (g.expiresAtMs === undefined ? { kind: "admin", role: g.role } : { kind: "admin", role: g.role, expiresAtMs: g.expiresAtMs })),
  fc.record({ kind: fc.constant("courier" as const), hubId: fc.constantFrom("h1", "h2") }),
  fc.record({ kind: fc.constant("creator" as const), creatorId: fc.constantFrom("c1", "c2") }),
);

const actorArb: fc.Arbitrary<Actor> = fc.record({
  id,
  status: fc.constantFrom("active", "suspended", "deleted" as const),
  assurance: fc.constantFrom("basic", "passkey" as const),
  grants: fc.array(grant, { maxLength: 4 }),
  tokenScopes: fc.subarray(["seller:read", "seller:write", "admin:access", "x"]),
});

const resourceArb: fc.Arbitrary<Resource | null> = fc.option(
  fc.record({
    type: fc.constantFrom(...RESOURCE_TYPES),
    id: fc.constantFrom("r1", "r2"),
    state: fc.constantFrom("active", "deleted" as const),
    ownerUserId: id,
    storeId: store,
    hubId: fc.constantFrom("h1", "h2"),
    creatorId: fc.constantFrom("c1", "c2"),
    amountMinor: fc.bigInt({ min: 0n, max: 10_000_000n }),
  }),
  { nil: null },
);

const matcherArb: fc.Arbitrary<GrantMatcher> = fc.oneof(
  fc.constant<GrantMatcher>({ kind: "shopper" }),
  fc.constant<GrantMatcher>({ kind: "plus" }),
  fc.subarray([...BRAND_ROLES]).map((roles): GrantMatcher => ({ kind: "brand", roles })),
  fc.subarray([...ADMIN_ROLES]).map((roles): GrantMatcher => ({ kind: "admin", roles })),
  fc.constant<GrantMatcher>({ kind: "courier" }),
  fc.constant<GrantMatcher>({ kind: "creator" }),
);

const ruleArb: fc.Arbitrary<Rule> = fc.record({
  resource: fc.constantFrom(...RESOURCE_TYPES),
  actions: fc.subarray([...ACTIONS], { minLength: 1 }),
  grant: matcherArb,
  scope: fc.constantFrom<Scope>("owner", "store", "hub", "creator", "platform"),
  requiresPasskey: fc.boolean(),
  requiresReason: fc.boolean(),
  dual: fc.option(fc.bigInt({ min: 0n, max: 10_000_000n }), { nil: undefined }),
}).map((r): Rule => ({
  id: "gen",
  resource: r.resource,
  actions: r.actions,
  grant: r.grant,
  scope: r.scope,
  requiresPasskey: r.requiresPasskey,
  requiresReason: r.requiresReason,
  ...(r.dual !== undefined ? { dualApproval: { kind: "at_or_above" as const, thresholdMinor: r.dual } } : {}),
}));

const rulesArb = (max: number): fc.Arbitrary<Rule[]> =>
  fc.array(ruleArb, { maxLength: max }).map((rs) => rs.map((r, i) => ({ ...r, id: `gen-${i}` })));

const requestArb = fc.record({
  actor: fc.option(actorArb, { nil: null }),
  action: fc.constantFrom(...ACTIONS),
  resource: resourceArb,
  reason: fc.option(fc.constantFrom("", "ticket"), { nil: undefined }),
  approvals: fc.array(actorArb, { maxLength: 2 }),
  type: fc.constantFrom(...RESOURCE_TYPES),
}).map((r): AuthzRequest => ({
  actor: r.actor,
  action: r.action,
  resourceType: r.resource?.type ?? r.type,
  resource: r.resource,
  nowMs: NOW,
  ...(r.reason !== undefined ? { reason: r.reason } : {}),
  approvals: r.approvals,
}));

describe("deny by default (property tests)", () => {
  it("an empty rule set never allows anything", () => {
    fc.assert(fc.property(requestArb, (r) => decide(r, []).effect === "deny"));
  });

  it("allow implies a rule in the set that names this resource type and action", () => {
    fc.assert(
      fc.property(rulesArb(6), requestArb, (rules, r) => {
        const d = decide(r, rules);
        if (d.effect === "deny") return true;
        const rule = rules.find((x) => x.id === d.ruleId);
        return (
          rule !== undefined &&
          rule.resource === r.resourceType &&
          rule.actions.includes(r.action) &&
          r.actor !== null &&
          r.actor.status === "active" &&
          r.resource !== null &&
          r.resource.state === "active"
        );
      }),
      { numRuns: 2000 },
    );
  });

  it("removing the matching rule always flips allow to deny", () => {
    fc.assert(
      fc.property(rulesArb(6), requestArb, (rules, r) => {
        const d = decide(r, rules);
        if (d.effect === "deny") return true;
        const without = rules.filter((x) => x.id !== d.ruleId);
        const d2 = decide(r, without);
        return d2.effect === "deny" || d2.ruleId !== d.ruleId;
      }),
      { numRuns: 1000 },
    );
  });

  it("adding rules for other resource types never changes a decision", () => {
    fc.assert(
      fc.property(rulesArb(4), rulesArb(4), requestArb, (a, b, r) => {
        const other = b.map((x, i) => ({ ...x, id: `other-${i}`, resource: RESOURCE_TYPES.find((t) => t !== r.resourceType) ?? "order" }));
        return decide(r, a).effect === decide(r, [...a, ...other]).effect;
      }),
    );
  });

  it("a non-active actor or a missing actor is never allowed, with any rule set", () => {
    fc.assert(
      fc.property(rulesArb(6), requestArb, (rules, r) => {
        const inactive = r.actor === null || r.actor.status !== "active";
        return !inactive || decide(r, rules).effect === "deny";
      }),
    );
  });

  it("denial status is 404 only after the role stage (never leaks existence to a role-less actor)", () => {
    fc.assert(
      fc.property(requestArb, (r) => {
        const d = decide(r, RULES);
        if (d.effect === "allow" || d.httpStatus !== 404 || r.actor === null) return true;
        const typeRules = RULES.filter((x) => x.resource === r.resourceType && x.actions.includes(r.action));
        const a = r.actor;
        return typeRules.some((rule) =>
          a.grants.some((g) =>
            rule.grant.kind === "shopper" ? g.kind === "shopper" || g.kind === "plus"
            : rule.grant.kind === "plus" ? g.kind === "plus"
            : rule.grant.kind === "brand" ? g.kind === "brand" && rule.grant.roles.includes(g.role)
            : rule.grant.kind === "admin" ? g.kind === "admin" && rule.grant.roles.includes(g.role)
            : g.kind === rule.grant.kind,
          ),
        );
      }),
      { numRuns: 2000 },
    );
  });

  it("an approval from the requester or from a non-admin never satisfies dual approval", () => {
    const rule: Rule = {
      id: "r", resource: "refund", actions: ["approve"], grant: { kind: "admin", roles: ["finance"] },
      scope: "platform", requiresPasskey: true, dualApproval: { kind: "always" },
    };
    fc.assert(
      fc.property(fc.array(actorArb, { maxLength: 4 }), (others) => {
        const requester = actor("req", [{ kind: "admin", role: "finance" }]);
        const nonAdmins = others.map((o) => ({ ...o, grants: o.grants.filter((g) => g.kind !== "admin") }));
        const d = decide(
          { actor: requester, action: "approve", resourceType: "refund", resource: { type: "refund", id: "x", state: "active" }, nowMs: NOW, approvals: [requester, ...nonAdmins] },
          [rule],
        );
        return d.effect === "deny";
      }),
    );
  });

  it("db session context is null for any non-active actor and for admins without passkey", () => {
    fc.assert(
      fc.property(actorArb, fc.constantFrom(...ADMIN_ROLES), (a, role) => {
        const ctx = dbSessionContext(a, { kind: "admin", role }, NOW);
        if (a.status !== "active" || a.assurance !== "passkey") return ctx === null;
        return true;
      }),
    );
  });
});
