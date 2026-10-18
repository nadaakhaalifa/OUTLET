import { createDefaultRules, type Actor, type AdminRole, type Grant } from "@outlet/policy";
import { describe, expect, it } from "vitest";
import { canReadPrivacyConsole } from "../../privacy";
import { canReadReconciliation } from "../../reconciliation";
import { canReadTax, canWriteTax } from "../../tax-eta";
import { isFinanceActor } from "../../payouts";
import { adminGateDenial, brandReviewGateDenial, canPassAdminGate, computeAccess, ROUTE_ROLES } from "./access";

/**
 * The route-gate predicates the capability map will call (docs/specs/dashboard-foundations.md, track 1).
 * These pin today's rules so that extracting them from the controllers changed no behaviour.
 */

const NOW = 1_800_000_000_000;
const actor = (roles: readonly (AdminRole | { role: AdminRole; expiresAtMs: number })[], assurance: Actor["assurance"] = "passkey"): Actor => ({
  id: "u1",
  status: "active",
  assurance,
  tokenScopes: ["admin:access"],
  grants: roles.map((r): Grant => (typeof r === "string" ? { kind: "admin", role: r } : { kind: "admin", role: r.role, expiresAtMs: r.expiresAtMs })),
});

describe("adminGateDenial (AdminController.gate)", () => {
  const access = (a: Actor) => computeAccess(a, [], NOW);

  it("allows an effective role in the list with a passkey", () => {
    expect(adminGateDenial(access(actor(["ops"])), ROUTE_ROLES.flagsWrite)).toBeNull();
    expect(canPassAdminGate(access(actor(["security"])), ROUTE_ROLES.flagsRead)).toBe(true);
  });
  it("denies: no standing grant, no passkey, wrong role (reasons in the controller's order)", () => {
    expect(adminGateDenial(access(actor([])), ROUTE_ROLES.flagsRead)).toBe("missing_role");
    expect(adminGateDenial(access(actor(["ops"], "basic")), ROUTE_ROLES.flagsRead)).toBe("passkey_required");
    expect(adminGateDenial(access(actor(["support"])), ROUTE_ROLES.flagsWrite)).toBe("missing_role");
    expect(adminGateDenial(access(actor(["ops"])), ROUTE_ROLES.piiView)).toBe("missing_role");
  });
  it("standing super_admin alone opens nothing but the any_standing gate", () => {
    const a = access(actor(["super_admin"]));
    expect(adminGateDenial(a, ROUTE_ROLES.elevationsAdmin)).toBe("missing_role");
    expect(adminGateDenial(a, "any_standing")).toBeNull();
  });
  it("an expired grant is not standing", () => {
    expect(adminGateDenial(access(actor([{ role: "ops", expiresAtMs: NOW }])), ROUTE_ROLES.flagsWrite)).toBe("missing_role");
    expect(adminGateDenial(access(actor([{ role: "ops", expiresAtMs: NOW + 1 }])), ROUTE_ROLES.flagsWrite)).toBeNull();
  });
});

describe("brandReviewGateDenial", () => {
  const roles = ["ops", "trust_safety"] as const;
  it("same allow set as the admin gate; only the reason order differs", () => {
    for (const held of [[], ["ops"], ["trust_safety"], ["finance"], ["super_admin"]] as const) {
      for (const assurance of ["basic", "passkey"] as const) {
        const a = computeAccess(actor(held, assurance), [], NOW);
        expect(brandReviewGateDenial(a, roles) === null).toBe(adminGateDenial(a, roles) === null);
      }
    }
    expect(brandReviewGateDenial(computeAccess(actor(["finance"], "basic"), [], NOW), roles)).toBe("missing_role");
    expect(brandReviewGateDenial(computeAccess(actor(["ops"], "basic"), [], NOW), roles)).toBe("passkey_required");
  });
});

describe("module predicates", () => {
  it("isFinanceActor: live finance grant only (ops and expired do not count; no passkey check, as built)", () => {
    expect(isFinanceActor(actor(["finance"]), NOW)).toBe(true);
    expect(isFinanceActor(actor(["ops"]), NOW)).toBe(false);
    expect(isFinanceActor(actor([{ role: "finance", expiresAtMs: NOW }]), NOW)).toBe(false);
    expect(isFinanceActor(actor([{ role: "finance", expiresAtMs: NOW + 1 }]), NOW)).toBe(true);
    expect(isFinanceActor({ ...actor(["finance"]), grants: [{ kind: "shopper" }] }, NOW)).toBe(false);
  });
  it("canReadTax / canWriteTax: finance, ops, super_admin read; finance, super_admin write; passkey required; standing super_admin counts", () => {
    expect(canReadTax(actor(["ops"]), NOW)).toBe(true);
    expect(canWriteTax(actor(["ops"]), NOW)).toBe(false);
    expect(canReadTax(actor(["super_admin"]), NOW)).toBe(true);
    expect(canWriteTax(actor(["super_admin"]), NOW)).toBe(true);
    expect(canReadTax(actor(["support"]), NOW)).toBe(false);
    expect(canReadTax(actor(["finance"], "basic"), NOW)).toBe(false);
    expect(canReadTax(actor([{ role: "finance", expiresAtMs: NOW }]), NOW)).toBe(false);
  });
  it("canReadPrivacyConsole: dpo grant plus passkey", () => {
    expect(canReadPrivacyConsole(actor(["dpo"]), NOW)).toBe(true);
    expect(canReadPrivacyConsole(actor(["dpo"], "basic"), NOW)).toBe(false);
    expect(canReadPrivacyConsole(actor(["security"]), NOW)).toBe(false);
    expect(canReadPrivacyConsole(actor([{ role: "dpo", expiresAtMs: NOW }]), NOW)).toBe(false);
  });
  it("canReadReconciliation: the central payout.read rule (finance and ops, passkey, admin scope)", () => {
    const rules = createDefaultRules({ refundDualApprovalAtOrAboveMinor: 0n, payoutDualApprovalAtOrAboveMinor: 0n });
    expect(canReadReconciliation(actor(["finance"]), rules, NOW)).toBe(true);
    expect(canReadReconciliation(actor(["ops"]), rules, NOW)).toBe(true);
    expect(canReadReconciliation(actor(["support"]), rules, NOW)).toBe(false);
    expect(canReadReconciliation(actor(["finance"], "basic"), rules, NOW)).toBe(false);
    expect(canReadReconciliation({ ...actor(["finance"]), tokenScopes: [] }, rules, NOW)).toBe(false);
  });
});
