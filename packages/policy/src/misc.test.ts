import { describe, expect, it } from "vitest";
import { assertValidRuleSet } from "./decide";
import { dbSessionContext } from "./db-context";
import { InvalidRuleSetError, MalformedAuthzInputError } from "./errors";
import { parseActor, parseResource } from "./parse";
import { NOW, RULES, actor, financeAdmin, sellerA, shopperA } from "./test-fixtures";
import type { Rule } from "./types";

describe("rule set validation", () => {
  it("default rules are valid and ids unique", () => {
    expect(() => assertValidRuleSet(RULES)).not.toThrow();
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });
  it("rejects an admin rule without passkey, duplicate ids and dual approval on non-admin", () => {
    const bad: Rule = { id: "x", resource: "order", actions: ["read"], grant: { kind: "admin", roles: ["ops"] }, scope: "platform" };
    expect(() => assertValidRuleSet([bad])).toThrow(InvalidRuleSetError);
    const ok: Rule = { ...bad, requiresPasskey: true };
    expect(() => assertValidRuleSet([ok, ok])).toThrow(InvalidRuleSetError);
    expect(() => assertValidRuleSet([{ ...ok, grant: { kind: "shopper" }, scope: "owner", dualApproval: { kind: "always" } }])).toThrow(InvalidRuleSetError);
  });
  it("every admin rule in the default set requires a passkey and every approval rule has dual approval or is below-threshold gated", () => {
    for (const r of RULES.filter((x) => x.grant.kind === "admin")) expect(r.requiresPasskey).toBe(true);
    for (const id of ["admin.role_grant.grant", "admin.plan_price.update", "admin.data_export.create", "admin.break_glass.invoke"]) {
      expect(RULES.find((r) => r.id === id)?.dualApproval).toEqual({ kind: "always" });
    }
  });
});

describe("parsers fail closed", () => {
  it("accepts a well-formed actor and resource", () => {
    expect(parseActor({ id: "u", status: "active", assurance: "basic", grants: [{ kind: "brand", storeId: "s", role: "manager" }], tokenScopes: [] }).grants).toHaveLength(1);
    expect(parseResource({ type: "order", id: "o", state: "active", ownerUserId: "u", amountMinor: 5n }).amountMinor).toBe(5n);
  });
  it.each([
    [null], [{}], [{ id: "u", status: "root", assurance: "basic", grants: [], tokenScopes: [] }],
    [{ id: "u", status: "active", assurance: "basic", grants: [{ kind: "admin", role: "god" }], tokenScopes: [] }],
    [{ id: "", status: "active", assurance: "basic", grants: [], tokenScopes: [] }],
  ])("rejects malformed actor %#", (raw) => {
    expect(() => parseActor(raw)).toThrow(MalformedAuthzInputError);
  });
  it("rejects a resource with a number amount or unknown type", () => {
    expect(() => parseResource({ type: "order", id: "o", state: "active", amountMinor: 5 })).toThrow(MalformedAuthzInputError);
    expect(() => parseResource({ type: "nope", id: "o", state: "active" })).toThrow(MalformedAuthzInputError);
  });
});

describe("db session context", () => {
  it("maps audiences to DB roles and store ids", () => {
    expect(dbSessionContext(shopperA, { kind: "shopper" }, NOW)).toEqual({ userId: "user-a", role: "customer", storeIds: [] });
    expect(dbSessionContext(sellerA, { kind: "seller" }, NOW)).toEqual({ userId: "staff-a", role: "seller", storeIds: ["store-a"] });
    expect(dbSessionContext(financeAdmin, { kind: "admin", role: "finance" }, NOW)?.role).toBe("finance");
  });
  it("is null when the audience does not match a grant, status is not active or the JIT grant expired", () => {
    expect(dbSessionContext(shopperA, { kind: "seller" }, NOW)).toBeNull();
    expect(dbSessionContext(shopperA, { kind: "admin", role: "finance" }, NOW)).toBeNull();
    expect(dbSessionContext({ ...sellerA, status: "suspended" }, { kind: "seller" }, NOW)).toBeNull();
    expect(dbSessionContext(actor("a", [{ kind: "admin", role: "ops", expiresAtMs: NOW }]), { kind: "admin", role: "ops" }, NOW)).toBeNull();
  });
});
