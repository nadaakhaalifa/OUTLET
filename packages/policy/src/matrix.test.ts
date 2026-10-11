import { describe, expect, it } from "vitest";
import { decide, toPublicProblem } from "./decide";
import {
  NOW, RULES, actor, financeAdmin, financeAdmin2, plusA, req, resource, sellerA, sellerB, shopperA, shopperB,
  superAdmin, superAdmin2,
} from "./test-fixtures";
import type { Actor, AuthzRequest, DenyReason } from "./types";

interface Case {
  readonly name: string;
  readonly request: AuthzRequest;
  readonly status: 200 | 401 | 403 | 404;
  readonly reason?: DenyReason;
  readonly ruleId?: string;
}

const own = resource("order", { ownerUserId: "user-a" });
const storeAProduct = resource("store_product", { storeId: "store-a" });

const cases: readonly Case[] = [
  // BOLA: object belongs to someone else => 404, never 403
  { name: "shopper B reads shopper A order", request: req(shopperB, "read", own), status: 404, reason: "not_owned" },
  { name: "seller B reads seller A product", request: req(sellerB, "read", storeAProduct), status: 404, reason: "not_owned" },
  { name: "seller B updates seller A product", request: req(sellerB, "update", storeAProduct), status: 404, reason: "not_owned" },
  { name: "seller B reads seller A payout", request: req(sellerB, "read", resource("store_payout", { storeId: "store-a" })), status: 404, reason: "not_owned" },
  { name: "shopper B deletes shopper A session", request: req(shopperB, "delete", resource("session", { ownerUserId: "user-a" })), status: 404, reason: "not_owned" },
  { name: "resource without owner is not owned", request: req(shopperA, "read", resource("order")), status: 404, reason: "not_owned" },
  { name: "unknown id is 404", request: { ...req(shopperA, "read", null), resourceType: "order" }, status: 404, reason: "resource_not_found" },
  // owner and tenant happy paths
  { name: "owner reads own order", request: req(shopperA, "read", own), status: 200, ruleId: "shopper.order.owner" },
  { name: "plus member is also a shopper", request: req(plusA, "read", resource("order", { ownerUserId: "user-p" })), status: 200 },
  { name: "plus benefit for plus member", request: req(plusA, "read", resource("plus_benefit", { ownerUserId: "user-p" })), status: 200 },
  { name: "plain shopper has no plus benefit (role, 403)", request: req(shopperA, "read", resource("plus_benefit", { ownerUserId: "user-a" })), status: 403, reason: "missing_role" },
  { name: "seller A reads own product", request: req(sellerA, "read", storeAProduct), status: 200 },
  // BFLA: missing role => 403
  { name: "shopper to admin console", request: req(shopperA, "read", resource("admin_console")), status: 403, reason: "missing_role" },
  { name: "shopper to payout approve", request: req(shopperA, "approve", resource("payout", { amountMinor: 1n })), status: 403, reason: "missing_role" },
  { name: "seller to admin console", request: req(sellerA, "read", resource("admin_console")), status: 403, reason: "missing_role" },
  { name: "catalog staff cannot read payouts of own store (role)", request: req(actor("staff-c", [{ kind: "brand", storeId: "store-a", role: "catalog" }]), "read", resource("store_payout", { storeId: "store-a" })), status: 403, reason: "missing_role" },
  { name: "shopper to seller route", request: req(shopperA, "read", storeAProduct), status: 403, reason: "missing_role" },
  { name: "role check precedes existence (null resource, no role)", request: { ...req(shopperA, "read", null), resourceType: "admin_console" }, status: 403, reason: "missing_role" },
  { name: "marketing admin cannot approve refunds", request: req(actor("adm-m", [{ kind: "admin", role: "marketing" }]), "approve", resource("refund", { amountMinor: 1n })), status: 403, reason: "missing_role" },
  { name: "unmapped action has no rule", request: req(shopperA, "export", own), status: 403, reason: "no_rule" },
  // identity states
  { name: "unauthenticated", request: req(null, "read", own), status: 401, reason: "unauthenticated" },
  { name: "suspended owner", request: req(actor("user-a", [{ kind: "shopper" }], { status: "suspended" }), "read", own), status: 403, reason: "actor_suspended" },
  { name: "deleted actor", request: req(actor("user-a", [{ kind: "shopper" }], { status: "deleted" }), "read", own), status: 403, reason: "actor_deleted" },
  { name: "suspended admin", request: req(actor("adm-fin", [{ kind: "admin", role: "finance" }], { status: "suspended" }), "read", resource("admin_console")), status: 403, reason: "actor_suspended" },
  // deleted resource
  { name: "owner reads deleted order", request: req(shopperA, "read", resource("order", { ownerUserId: "user-a", state: "deleted" })), status: 404, reason: "resource_deleted" },
  { name: "seller reads deleted product", request: req(sellerA, "read", resource("store_product", { storeId: "store-a", state: "deleted" })), status: 404, reason: "resource_deleted" },
  // gates
  { name: "seller token without write scope", request: req(actor("staff-a", [{ kind: "brand", storeId: "store-a", role: "manager" }], { tokenScopes: ["seller:read"] }), "update", storeAProduct), status: 403, reason: "missing_token_scope" },
  { name: "admin without passkey", request: req(actor("adm-fin", [{ kind: "admin", role: "finance" }], { assurance: "basic" }), "read", resource("admin_console")), status: 403, reason: "passkey_required" },
  { name: "admin token without admin scope", request: req(actor("adm-fin", [{ kind: "admin", role: "finance" }], { tokenScopes: [] }), "read", resource("admin_console")), status: 403, reason: "missing_token_scope" },
  { name: "JIT admin grant expired", request: req(actor("adm-fin", [{ kind: "admin", role: "finance", expiresAtMs: NOW - 1 }]), "read", resource("admin_console")), status: 403, reason: "grant_expired" },
  { name: "JIT admin grant live", request: req(actor("adm-fin", [{ kind: "admin", role: "finance", expiresAtMs: NOW + 1 }]), "read", resource("admin_console")), status: 200 },
  // reason code
  { name: "PII view without reason", request: req(actor("adm-s", [{ kind: "admin", role: "support" }]), "read", resource("pii_view")), status: 403, reason: "reason_required" },
  { name: "PII view with blank reason", request: req(actor("adm-s", [{ kind: "admin", role: "support" }]), "read", resource("pii_view"), { reason: "  " }), status: 403, reason: "reason_required" },
  { name: "PII view with reason", request: req(actor("adm-s", [{ kind: "admin", role: "support" }]), "read", resource("pii_view"), { reason: "ticket-123" }), status: 200 },
  // dual approval
  { name: "refund below threshold needs no approval", request: req(financeAdmin, "approve", resource("refund", { amountMinor: 499_999n })), status: 200 },
  { name: "refund at threshold needs approval", request: req(financeAdmin, "approve", resource("refund", { amountMinor: 500_000n })), status: 403, reason: "dual_approval_required" },
  { name: "refund without amount fails closed", request: req(financeAdmin, "approve", resource("refund")), status: 403, reason: "dual_approval_required" },
  { name: "refund with second finance admin", request: req(financeAdmin, "approve", resource("refund", { amountMinor: 500_000n }), { approvals: [financeAdmin2] }), status: 200 },
  { name: "self approval does not count", request: req(financeAdmin, "approve", resource("refund", { amountMinor: 500_000n }), { approvals: [financeAdmin] }), status: 403, reason: "dual_approval_required" },
  { name: "suspended approver does not count", request: req(financeAdmin, "approve", resource("refund", { amountMinor: 500_000n }), { approvals: [{ ...financeAdmin2, status: "suspended" }] }), status: 403, reason: "dual_approval_required" },
  { name: "approver without passkey does not count", request: req(financeAdmin, "approve", resource("refund", { amountMinor: 500_000n }), { approvals: [{ ...financeAdmin2, assurance: "basic" }] }), status: 403, reason: "dual_approval_required" },
  { name: "approver with wrong role does not count", request: req(financeAdmin, "approve", resource("refund", { amountMinor: 500_000n }), { approvals: [actor("adm-m", [{ kind: "admin", role: "marketing" }])] }), status: 403, reason: "dual_approval_required" },
  { name: "approver with expired grant does not count", request: req(financeAdmin, "approve", resource("refund", { amountMinor: 500_000n }), { approvals: [actor("adm-f3", [{ kind: "admin", role: "finance", expiresAtMs: NOW }])] }), status: 403, reason: "dual_approval_required" },
  { name: "shopper cannot approve as second approver", request: req(financeAdmin, "approve", resource("refund", { amountMinor: 500_000n }), { approvals: [shopperA] }), status: 403, reason: "dual_approval_required" },
  { name: "role grant always needs approval", request: req(superAdmin, "grant", resource("role_grant"), { reason: "r" }), status: 403, reason: "dual_approval_required" },
  { name: "role grant with approval and reason", request: req(superAdmin, "grant", resource("role_grant"), { reason: "r", approvals: [superAdmin2] }), status: 200 },
  { name: "break glass needs reason before approval", request: req(superAdmin, "invoke", resource("break_glass"), { approvals: [superAdmin2] }), status: 403, reason: "reason_required" },
  { name: "super admin has no implicit access to shopper data", request: req(superAdmin, "read", own), status: 403, reason: "missing_role" },
  { name: "data export needs dpo, finance cannot", request: req(financeAdmin, "export", resource("data_export"), { reason: "r", approvals: [financeAdmin2] }), status: 403, reason: "missing_role" },
  // courier and creator
  { name: "courier own hub", request: req(actor("c1", [{ kind: "courier", hubId: "hub-1" }]), "update", resource("courier_task", { hubId: "hub-1" })), status: 200 },
  { name: "courier other hub is 404", request: req(actor("c1", [{ kind: "courier", hubId: "hub-1" }]), "update", resource("courier_task", { hubId: "hub-2" })), status: 404, reason: "not_owned" },
  { name: "creator other creator link is 404", request: req(actor("cr1", [{ kind: "creator", creatorId: "cr-1" }]), "read", resource("creator_link", { creatorId: "cr-2" })), status: 404, reason: "not_owned" },
  // wrong resource type for the id lookup
  { name: "request type and resource type mismatch is 404", request: { ...req(shopperA, "read", own), resourceType: "cart" }, status: 404, reason: "resource_not_found" },
];

describe("negative authorization matrix", () => {
  it.each(cases)("$name", ({ request, status, reason, ruleId }) => {
    const d = decide(request, RULES);
    expect(d.httpStatus).toBe(status);
    expect(d.effect).toBe(status === 200 ? "allow" : "deny");
    if (d.effect === "deny" && reason !== undefined) expect(d.reason).toBe(reason);
    if (d.effect === "allow" && ruleId !== undefined) expect(d.ruleId).toBe(ruleId);
    expect(d.audit.httpStatus).toBe(status);
  });

  it("a multi-store staffer is 404 on a third store", () => {
    const multi = actor("m", [
      { kind: "brand", storeId: "store-a", role: "manager" },
      { kind: "brand", storeId: "store-b", role: "catalog" },
    ]);
    expect(decide(req(multi, "read", resource("store_product", { storeId: "store-c" })), RULES).httpStatus).toBe(404);
    expect(decide(req(multi, "update", resource("store_product", { storeId: "store-b" })), RULES).httpStatus).toBe(200);
  });

  it("public problem never leaks the internal reason", () => {
    const owned = toPublicProblem(decide(req(shopperB, "read", own), RULES));
    const missing = toPublicProblem(decide({ ...req(shopperB, "read", null), resourceType: "order" }, RULES));
    const deleted = toPublicProblem(decide(req(shopperA, "read", resource("order", { ownerUserId: "user-a", state: "deleted" })), RULES));
    expect(owned).toEqual({ status: 404, code: "not_found" });
    expect(missing).toEqual(owned);
    expect(deleted).toEqual(owned);
    expect(toPublicProblem(decide(req(shopperA, "read", resource("admin_console")), RULES))).toEqual({ status: 403, code: "forbidden" });
  });

  it("403 does not depend on whether the object exists", () => {
    const a = decide(req(shopperA, "read", resource("store_product", { storeId: "store-a" })), RULES);
    const b = decide({ ...req(shopperA, "read", null), resourceType: "store_product" }, RULES);
    expect(a.httpStatus).toBe(403);
    expect(b.httpStatus).toBe(403);
  });

  it("every denial is audited with a reason and no rule id", () => {
    for (const c of cases.filter((x) => x.status !== 200)) {
      const d = decide(c.request, RULES);
      expect(d.audit.effect).toBe("deny");
      expect(d.audit.ruleId).toBeNull();
      expect(d.audit.reason).not.toBe("allowed");
    }
  });
});

describe("exhaustive sweep over the default rule set", () => {
  const actors: readonly Actor[] = [
    shopperA, shopperB, plusA, sellerA, sellerB, financeAdmin, superAdmin,
    actor("courier", [{ kind: "courier", hubId: "hub-1" }]),
    actor("creator", [{ kind: "creator", creatorId: "cr-1" }]),
    { ...shopperA, status: "suspended" },
    { ...financeAdmin, status: "deleted" },
  ];
  const types = [...new Set(RULES.map((r) => r.resource))];
  const actions = ["read", "create", "update", "delete", "approve", "export", "grant", "invoke"] as const;

  it("allows only with a listed rule, never for foreign, deleted or missing objects, or inactive actors", () => {
    let allows = 0;
    for (const a of actors) {
      for (const type of types) {
        for (const action of actions) {
          const variants = [
            { r: resource(type, { ownerUserId: "someone-else", storeId: "store-z", hubId: "hub-z", creatorId: "cr-z", amountMinor: 1n }), foreign: true },
            { r: resource(type, { ownerUserId: a.id, state: "deleted", storeId: "store-a", hubId: "hub-1", creatorId: "cr-1", amountMinor: 1n }), foreign: false },
            { r: null, foreign: false },
          ];
          for (const v of variants) {
            const d = decide({ ...req(a, action, v.r), resourceType: type }, RULES);
            if (d.effect === "allow") {
              allows += 1;
              const rule = RULES.find((x) => x.id === d.ruleId);
              expect(rule?.resource).toBe(type);
              expect(rule?.actions).toContain(action);
              // foreign, deleted and missing variants must only ever be allowed by platform-scoped rules for foreign
              expect(v.r).not.toBeNull();
              expect(v.r?.state).toBe("active");
              expect(rule?.scope).toBe("platform");
              expect(a.status).toBe("active");
            }
          }
        }
      }
    }
    expect(allows).toBeGreaterThan(0);
  });
});
