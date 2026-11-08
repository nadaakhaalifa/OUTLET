import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ADMIN_POLICY, ADMIN_ROLES, authorize, dualApprovalRequired, Principal, requiresReasonCode, REQUIRES_REASON_CODE, Resource, SELLER_POLICY, SELLER_ROLES, SHOPPER_ACTIONS,
  type Principal as P,
} from "../src/index.js";

const base = { marketId: "EG", roles: [], scopes: [] };
const seller = (role: string, storeIds = ["s1"]): P => ({ ...base, kind: "seller_staff", userId: "u1", storeIds, roles: [role] });
const admin = (role: string, breakGlass?: boolean): P => ({ ...base, kind: "admin", userId: "a1", roles: [role], ...(breakGlass === undefined ? {} : { breakGlass }) });
const res = (o: Partial<Resource> = {}): Resource => ({ type: "order", marketId: "EG", storeId: "s1", ...o });
const reason = (d: ReturnType<typeof authorize>): string => (d.effect === "allow" ? "allow" : d.reason);

describe("seller role matrix", () => {
  const actions = ["listing.write", "order.fulfill", "payout.read", "team.manage", "customer_message.write", "return.inspect"];
  for (const role of SELLER_ROLES) {
    for (const a of actions) {
      const expected = SELLER_POLICY[role].includes(a) ? "allow" : "forbidden";
      it(`${role} ${a} -> ${expected}`, () => {
        expect(reason(authorize(seller(role), a, res()))).toBe(expected);
      });
    }
  }
});

describe("admin role matrix", () => {
  const actions = ["payout.approve", "refund.approve", "role.grant", "privacy.export", "store.suspend", "promotion.write", "audit.read", "store.threshold.write"];
  for (const role of ADMIN_ROLES) {
    for (const a of actions) {
      const expected = ADMIN_POLICY[role].includes(a) ? "allow" : "forbidden";
      it(`${role} ${a} -> ${expected}`, () => {
        expect(reason(authorize(admin(role, true), a, res()))).toBe(expected);
      });
    }
  }
});

describe("explicit role matrix (spec, not derived from the tables)", () => {
  it("only admin ops and finance may write a store free-delivery threshold", () => {
    const allowed = [...ADMIN_ROLES].filter((r) => reason(authorize(admin(r, true), "store.threshold.write", res())) === "allow");
    expect(allowed.sort()).toEqual(["finance", "ops"]);
    expect(reason(authorize(seller("owner"), "store.threshold.write", res()))).toBe("forbidden");
  });
  it("seller finance and owner cannot approve payouts, only read them", () => {
    for (const role of ["finance", "owner"]) {
      expect(reason(authorize(seller(role), "payout.approve", res()))).toBe("forbidden");
      expect(reason(authorize(seller(role), "payout.read", res()))).toBe("allow");
    }
  });
  it("admin support cannot read the ledger or payouts", () => {
    expect(reason(authorize(admin("support"), "ledger.read", res()))).toBe("forbidden");
    expect(reason(authorize(admin("support"), "payout.read", res()))).toBe("forbidden");
  });
  it("only admin finance, and super_admin with breakGlass, approve payouts", () => {
    const allowed = [...ADMIN_ROLES].filter((r) => reason(authorize(admin(r, true), "payout.approve", res())) === "allow");
    expect(allowed.sort()).toEqual(["finance", "super_admin"]);
    expect(reason(authorize(admin("finance"), "payout.approve", res()))).toBe("allow");
    expect(reason(authorize(admin("super_admin"), "payout.approve", res()))).toBe("forbidden");
    expect(reason(authorize(admin("super_admin", false), "payout.approve", res()))).toBe("forbidden");
    expect(reason(authorize(admin("super_admin", true), "payout.approve", res()))).toBe("allow");
  });
  it("marketing cannot read users", () => {
    expect(reason(authorize(admin("marketing", true), "user.read", res()))).toBe("forbidden");
  });
  it("super_admin without breakGlass has no grants, other roles on the same principal still work", () => {
    for (const a of ADMIN_POLICY.super_admin) expect(reason(authorize(admin("super_admin"), a, res()))).toBe("forbidden");
    const both: P = { ...base, kind: "admin", userId: "a1", roles: ["super_admin", "ops"] };
    expect(reason(authorize(both, "order.read", res()))).toBe("allow");
    expect(reason(authorize(both, "role.grant", res()))).toBe("forbidden");
  });
});

describe("reason codes", () => {
  it("lists exactly the sensitive reads and exports", () => {
    expect([...REQUIRES_REASON_CODE]).toEqual(["user.read", "privacy.export", "data.export", "ledger.read"]);
    for (const a of REQUIRES_REASON_CODE) expect(requiresReasonCode(a)).toBe(true);
    expect(requiresReasonCode("order.read")).toBe(false);
  });
});

describe("negative cases", () => {
  it("other tenant -> not_found, even with the wrong role", () => {
    expect(reason(authorize(seller("owner"), "order.read", res({ storeId: "s2" })))).toBe("not_found");
    expect(reason(authorize(seller("support"), "listing.write", res({ storeId: "s2" })))).toBe("not_found");
  });
  it("resource without storeId is not_found for seller staff", () => {
    expect(reason(authorize(seller("owner"), "order.read", res({ storeId: undefined as never })))).toBe("not_found");
  });
  it("seller with several stores may act in each", () => {
    const p = seller("owner", ["s1", "s2"]);
    expect(reason(authorize(p, "order.read", res({ storeId: "s2" })))).toBe("allow");
  });
  it("unknown role and prototype-key role are forbidden", () => {
    expect(reason(authorize(seller("nope"), "order.read", res()))).toBe("forbidden");
    expect(reason(authorize(seller("constructor"), "order.read", res()))).toBe("forbidden");
    expect(reason(authorize(admin("toString"), "order.read", res()))).toBe("forbidden");
  });
  it("anonymous: private -> not_found, public catalog -> allow", () => {
    const anon: P = { ...base, kind: "anonymous" };
    expect(reason(authorize(anon, "order.read", res()))).toBe("not_found");
    expect(reason(authorize(anon, "catalog.read", res({ type: "listing" })))).toBe("allow");
    expect(reason(authorize(anon, "catalog.read", res({ ownerUserId: "u9" })))).toBe("not_found");
  });
  it("market mismatch -> not_found for every kind", () => {
    for (const p of [seller("owner"), admin("super_admin"), { ...base, kind: "shopper", userId: "u1" } as P]) {
      expect(reason(authorize(p, "order.read", res({ marketId: "AE", ownerUserId: "u1" })))).toBe("not_found");
    }
  });
  it("shopper: own -> allow, other's -> not_found, admin action -> forbidden", () => {
    const s: P = { ...base, kind: "shopper", userId: "u1" };
    expect(reason(authorize(s, "order.read", res({ ownerUserId: "u1" })))).toBe("allow");
    expect(reason(authorize(s, "order.read", res({ ownerUserId: "u2" })))).toBe("not_found");
    expect(reason(authorize(s, "payout.approve", res({ ownerUserId: "u1" })))).toBe("forbidden");
    expect(reason(authorize({ kind: "shopper", marketId: "EG", roles: [], scopes: [] }, "order.read", res()))).toBe("not_found");
    expect(reason(authorize(s, "catalog.read", res({ type: "listing" })))).toBe("allow");
  });
  it("shopper-own actions (session, passkey, checkout, cart): own -> allow, other's -> not_found, seller and anonymous never", () => {
    const s: P = { ...base, kind: "shopper", userId: "u1" };
    for (const action of ["session.read", "session.revoke", "passkey.manage", "checkout.place", "cart.write"]) {
      expect(SHOPPER_ACTIONS).toContain(action);
      expect(reason(authorize(s, action, res({ ownerUserId: "u1" })))).toBe("allow");
      expect(reason(authorize(s, action, res({ ownerUserId: "u2" })))).toBe("not_found");
      expect(reason(authorize(seller("owner"), action, res({ ownerUserId: "u1" })))).not.toBe("allow");
      expect(reason(authorize({ ...base, kind: "anonymous" }, action, res({ ownerUserId: "u1" })))).toBe("not_found");
    }
  });
  it("seller cannot use admin-only actions", () => {
    expect(reason(authorize(seller("owner"), "payout.approve", res()))).toBe("forbidden");
  });
  it("system needs the exact scope", () => {
    const sys: P = { ...base, kind: "system", scopes: ["order.read"] };
    expect(reason(authorize(sys, "order.read", res()))).toBe("allow");
    expect(reason(authorize(sys, "order.fulfill", res()))).toBe("forbidden");
  });
});

describe("dualApprovalRequired", () => {
  const cfg = { thresholdMinor: 1_000_000n };
  it("amount gated", () => {
    expect(dualApprovalRequired("payout.approve", cfg, 999_999n)).toBe(false);
    expect(dualApprovalRequired("payout.approve", cfg, 1_000_000n)).toBe(true);
    expect(dualApprovalRequired("refund.approve", cfg, 5n)).toBe(false);
    expect(dualApprovalRequired("refund.approve", cfg)).toBe(true);
  });
  it("negative amount fails safe", () => {
    expect(dualApprovalRequired("payout.approve", cfg, -1n)).toBe(true);
    expect(dualApprovalRequired("refund.approve", cfg, -5_000_000n)).toBe(true);
  });
  it("every super_admin action is dual-approval when the actor is super_admin", () => {
    const sa = { roles: ["super_admin"] };
    for (const a of ADMIN_POLICY.super_admin) expect(dualApprovalRequired(a, cfg, 0n, sa)).toBe(true);
    expect(dualApprovalRequired("payout.approve", cfg, 5n, { roles: ["finance"] })).toBe(false);
  });
  it("always gated and ungated", () => {
    for (const a of ["role.grant", "plan.price.change", "data.export"]) expect(dualApprovalRequired(a, cfg, 0n)).toBe(true);
    expect(dualApprovalRequired("order.read", cfg, 99_999_999n)).toBe(false);
  });
});

describe("schemas", () => {
  it("parse a valid principal and resource, reject a bad kind", () => {
    expect(Principal.safeParse({ ...base, kind: "admin" }).success).toBe(true);
    expect(Principal.safeParse({ ...base, kind: "root" }).success).toBe(false);
    expect(Resource.safeParse({ type: "order", marketId: "EG" }).success).toBe(true);
  });
});

describe("properties", () => {
  const id = fc.stringMatching(/^s[0-9]{1,3}$/);
  const anyAction = fc.constantFrom(...Object.values(SELLER_POLICY).flat(), "payout.approve", "x.y");
  it("never allows seller_staff outside their stores", () => {
    fc.assert(
      fc.property(fc.array(id, { maxLength: 4 }), id, fc.constantFrom(...SELLER_ROLES), anyAction, (stores, target, role, action) => {
        fc.pre(!stores.includes(target));
        const d = authorize(seller(role, stores), action, res({ storeId: target }));
        expect(d.effect).toBe("deny");
      }),
    );
  });
  it("never allows across markets", () => {
    fc.assert(
      fc.property(fc.constantFrom("anonymous", "shopper", "seller_staff", "admin", "system"), anyAction, (kind, action) => {
        const p: P = { kind, userId: "u1", marketId: "EG", storeIds: ["s1"], roles: [...SELLER_ROLES, ...ADMIN_ROLES], scopes: [action] };
        expect(authorize(p, action, res({ marketId: "AE", ownerUserId: "u1" })).effect).toBe("deny");
      }),
    );
  });
});
