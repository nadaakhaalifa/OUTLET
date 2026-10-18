import { describe, expect, it } from "vitest";
import { decide } from "./decide";
import { BRAND_ROLES, type BrandRole } from "./types";
import { evaluateSellerPermissions, SELLER_PERMISSION_CHECKS, type SellerPermissionKey } from "./seller-permissions";
import { NOW, RULES, actor } from "./test-fixtures";

const STORE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const KEYS = SELLER_PERMISSION_CHECKS.map((c) => c[0]);
const trueKeys = (role: BrandRole, state: "active" | "paused" | "draft" | "suspended" = "active"): SellerPermissionKey[] => {
  const p = evaluateSellerPermissions({
    actor: actor("u1", [{ kind: "brand", storeId: STORE, role }]),
    storeId: STORE, state, nowMs: NOW, rules: RULES,
  });
  return KEYS.filter((k) => p[k]);
};

/** Committed snapshot of the role matrix (packages/policy/src/rules.ts brand rules). */
const SNAPSHOT: Record<BrandRole, readonly SellerPermissionKey[]> = {
  owner: [...KEYS],
  manager: [
    "store_product.read", "store_product.create", "store_product.update", "store_product.delete",
    "store_inventory.read", "store_inventory.create", "store_inventory.update",
    "store_order.read", "store_order.update", "store_return.read", "store_return.update",
    "store_payout.read", "store_settings.read", "store_staff.read", "analytics.read", "analytics.export",
  ],
  catalog: [
    "store_product.read", "store_product.create", "store_product.update", "store_product.delete",
    "store_inventory.read",
  ],
  warehouse: [
    "store_product.read", "store_inventory.read", "store_inventory.create", "store_inventory.update",
    "store_order.read", "store_order.update", "store_return.read", "store_return.update", "analytics.read",
  ],
  finance: ["store_product.read", "store_order.read", "store_payout.read", "analytics.read"],
  support: ["store_product.read", "store_order.read", "store_return.read", "store_return.update", "analytics.read"],
};

describe("evaluateSellerPermissions", () => {
  it("has 20 unique keys", () => {
    expect(new Set(KEYS).size).toBe(20);
  });

  for (const role of BRAND_ROLES) {
    it(`role matrix snapshot: ${role}`, () => {
      expect(trueKeys(role)).toEqual(KEYS.filter((k) => SNAPSHOT[role].includes(k)));
    });
  }

  it("equals decide() for every key, role and state (no grant of its own)", () => {
    for (const role of BRAND_ROLES) {
      for (const state of ["active", "paused", "draft", "suspended"] as const) {
        const a = actor("u1", [{ kind: "brand", storeId: STORE, role }]);
        const p = evaluateSellerPermissions({ actor: a, storeId: STORE, state, nowMs: NOW, rules: RULES });
        for (const [key, type, action] of SELLER_PERMISSION_CHECKS) {
          const d = decide({ actor: a, action, resourceType: type, resource: { type, id: STORE, storeId: STORE, state }, nowMs: NOW }, RULES);
          expect(p[key], `${role}/${state}/${key}`).toBe(d.effect === "allow");
        }
      }
    }
  });

  it("paused and draft stores keep the active permission set", () => {
    for (const role of BRAND_ROLES) {
      expect(trueKeys(role, "paused")).toEqual(trueKeys(role, "active"));
      expect(trueKeys(role, "draft")).toEqual(trueKeys(role, "active"));
    }
  });

  it("suspended store: every permission is false for every role (writes and reads)", () => {
    for (const role of BRAND_ROLES) expect(trueKeys(role, "suspended")).toEqual([]);
  });

  it("a suspended store reports 404 for a foreign actor, never 403 (state is not revealed)", () => {
    const a = actor("u1", [{ kind: "brand", storeId: OTHER, role: "owner" }]);
    const d = decide({ actor: a, action: "read", resourceType: "store_product", resource: { type: "store_product", id: STORE, storeId: STORE, state: "suspended" }, nowMs: NOW }, RULES);
    expect(d).toMatchObject({ effect: "deny", httpStatus: 404, reason: "not_owned" });
  });

  it("a store the actor does not belong to yields all false", () => {
    const p = evaluateSellerPermissions({ actor: actor("u1", [{ kind: "brand", storeId: OTHER, role: "owner" }]), storeId: STORE, state: "active", nowMs: NOW, rules: RULES });
    expect(KEYS.filter((k) => p[k])).toEqual([]);
  });

  it("token scopes count: no seller scope means every key false; read-only scope drops writes", () => {
    const grants = [{ kind: "brand", storeId: STORE, role: "owner" }] as const;
    const none = evaluateSellerPermissions({ actor: actor("u", grants, { tokenScopes: ["seller:enrol"] }), storeId: STORE, state: "active", nowMs: NOW, rules: RULES });
    expect(KEYS.filter((k) => none[k])).toEqual([]);
    const ro = evaluateSellerPermissions({ actor: actor("u", grants, { tokenScopes: ["seller:read"] }), storeId: STORE, state: "active", nowMs: NOW, rules: RULES });
    expect(KEYS.filter((k) => ro[k]).every((k) => k.endsWith(".read") || k === "analytics.read" || k === "analytics.export")).toBe(true);
    expect(ro["store_product.update"]).toBe(false);
  });

  it("suspended actor, no rules, or no grants deny everything (deny by default)", () => {
    const base = { storeId: STORE, state: "active", nowMs: NOW } as const;
    const g = [{ kind: "brand", storeId: STORE, role: "owner" }] as const;
    for (const input of [
      { ...base, actor: actor("u", g, { status: "suspended" }), rules: RULES },
      { ...base, actor: actor("u", g), rules: [] },
      { ...base, actor: actor("u", [{ kind: "shopper" }]), rules: RULES },
    ]) {
      const p = evaluateSellerPermissions(input);
      expect(KEYS.filter((k) => p[k])).toEqual([]);
    }
  });
});
