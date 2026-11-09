import type { FlagRecord } from "@outlet/flags";
import type { Principal } from "@outlet/policy";
import { describe, expect, it } from "vitest";
import { AdminController } from "../src/modules/admin/index.js";
import type { AdminServices, FlagAdminPort } from "../src/modules/admin/index.js";
import type { ApiDeps } from "../src/platform/deps.js";
import type { RequestState } from "../src/platform/http.js";

const principal: Principal = { kind: "admin", userId: "staff-1", marketId: "EG", roles: ["finance"], scopes: [] };
const state = { principal, marketId: "EG" } as unknown as RequestState;

const sets: { name: string; enabled: boolean; reason: string }[] = [];
const rec = (enabled: boolean): FlagRecord => ({ key: "payments.cod.enabled", marketId: "EG", enabled, rules: {}, version: 1, updatedBy: "staff-1", updatedAt: new Date() });
const flagAdmin: FlagAdminPort = {
  list: () => Promise.resolve([rec(true)]),
  set: (_p, name, enabled, reason) => { sets.push({ name, enabled, reason }); return Promise.resolve(rec(enabled)); },
};

const controller = (access: Partial<AdminServices["access"]>, approvalAction = "kill_switch.engage", payload: Record<string, unknown> = {}): AdminController => {
  const svc = {
    access: {
      approve: () => Promise.resolve(),
      executeApproval: async (_p: unknown, _id: string, fn: (req: unknown, tx: unknown) => Promise<unknown>) => ({ executed: true, result: await fn({ targetId: "payments.cod.enabled", payload }, {}) }),
      ...access,
    },
    approvals: { get: () => Promise.resolve({ id: "a", action: approvalAction, status: "APPROVED" }) },
    ops: { flags: flagAdmin, audit: { list: () => Promise.reject(new Error("unused")), verify: () => Promise.reject(new Error("unused")) } },
  } as unknown as AdminServices;
  return new AdminController({ admin: () => svc } as unknown as ApiDeps);
};

describe("kill-switch edge branches", () => {
  it("a money release whose policy says no second approver is needed applies directly", async () => {
    const c = controller({ requireApproval: () => Promise.resolve({ required: false }) });
    const res = await c.toggleKill(state, { flag_key: "payments.cod.enabled" }, { enabled: true, reason: "cleared by finance" });
    expect(res.rules[0]).toMatchObject({ enabled: true });
  });

  it("an approved release without a stored reason falls back to a fixed one in the audit entry", async () => {
    const c = controller({});
    await c.decideApproval(state, { approval_request_id: "a" }, { decision: "approve", reason: "second look ok" });
    expect(sets.at(-1)).toEqual({ name: "payments.cod.enabled", enabled: true, reason: "approved release" });
  });

  it("an approval of another action is returned as decided, without touching flags", async () => {
    const before = sets.length;
    const c = controller({}, "role.grant");
    const res = await c.decideApproval(state, { approval_request_id: "a" }, { decision: "approve", reason: "second look ok" });
    expect(res.action).toBe("role.grant");
    expect(sets.length).toBe(before);
  });
});
