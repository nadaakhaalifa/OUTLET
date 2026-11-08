import { applyDbContext } from "@outlet/db";
import { asRole } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import type { Principal } from "@outlet/policy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminAccessError, liveRoles, nextApprovalStatus } from "../src/index.js";
import { DAY, HOUR, MIN, T0, admin, makeEnv } from "./helpers.js";
import type { Env } from "./helpers.js";

let env: Env;
const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { if (e instanceof AdminAccessError) return e.code; throw e; }
  return "NO_ERROR";
};
const actions = (): string[] => audits.map((a) => a.action);

const A = uuidv7(); const B = uuidv7(); const C = uuidv7(); const SUP = uuidv7(); const FIN = uuidv7(); const TARGET = uuidv7();
const D1 = uuidv7(); const D2 = uuidv7(); const D3 = uuidv7();
let a: Principal; let b: Principal; let c: Principal; let sup: Principal; let fin: Principal; let d1: Principal; let d2: Principal; let d3: Principal;
// thin accessors so the tests read naturally; bound after the environment exists
let svc: Env["svc"]; let client: Env["client"]; let audits: Env["audits"];
const advance = (ms: number): void => { env.advance(ms); };
const seedGrant = (id: string, r: string): Promise<void> => env.seedGrant(id, r);
beforeAll(async () => {
  env = await makeEnv();
  ({ svc, client, audits } = env);
  for (const [id, r] of [[A, "security"], [B, "security"], [C, "security"], [SUP, "support"], [FIN, "finance"], [D1, "dpo"], [D2, "dpo"], [D3, "dpo"]] as const) await seedGrant(id, r);
  const bp = (id: string): Promise<Principal> => svc.buildPrincipal("EG", id);
  a = await bp(A); b = await bp(B); c = await bp(C); sup = await bp(SUP); fin = await bp(FIN); d1 = await bp(D1); d2 = await bp(D2); d3 = await bp(D3);
});
afterAll(async () => { await env.close(); });
beforeEach(() => { env.setNow(new Date(T0)); audits.length = 0; });

describe("pure domain", () => {
  it("approval machine: terminal states are terminal", () => {
    expect(nextApprovalStatus("PENDING", "approve", 1, 2)).toBe("PENDING");
    expect(nextApprovalStatus("PENDING", "approve", 2, 2)).toBe("APPROVED");
    expect(nextApprovalStatus("PENDING", "reject", 0, 2)).toBe("REJECTED");
    expect(nextApprovalStatus("PENDING", "expire", 0, 2)).toBe("EXPIRED");
    for (const s of ["APPROVED", "REJECTED", "EXPIRED"] as const) {
      for (const e of ["approve", "reject", "expire"] as const) expect(() => nextApprovalStatus(s, e, 2, 2)).toThrow(AdminAccessError);
    }
  });
  it("liveRoles honours window and revocation", () => {
    const g = { role: "ops", startsAt: new Date(1000), expiresAt: new Date(2000), revokedAt: null };
    expect(liveRoles([g], [], new Date(999))).toEqual([]);
    expect(liveRoles([g], [], new Date(1000))).toEqual(["ops"]);
    expect(liveRoles([g], [], new Date(2000))).toEqual([]);
    expect(liveRoles([{ ...g, revokedAt: new Date(1500) }], [], new Date(1600))).toEqual([]);
  });
});

describe("role grants (dual approval)", () => {
  it("never applies directly and rejects self-grant, non-privileged actors and bad input", async () => {
    const req = await svc.grantRole(a, { staffId: TARGET }, "ops", { reason: "new on-call" });
    expect(req.status).toBe("PENDING");
    expect(req.requiredApprovals).toBe(2);
    expect((await svc.buildPrincipal("EG", TARGET)).roles).toEqual([]);
    expect(actions()).toEqual(["approval.requested"]);
    expect(await code(svc.grantRole(a, { staffId: A }, "ops", { reason: "x" }))).toBe("SELF_GRANT");
    expect(await code(svc.grantRole(sup, { staffId: TARGET }, "ops", { reason: "x" }))).toBe("FORBIDDEN");
    expect(await code(svc.grantRole(a, { staffId: TARGET }, "nope", { reason: "x" }))).toBe("INVALID_INPUT");
    expect(await code(svc.grantRole(a, { staffId: TARGET }, "ops", { reason: "  " }))).toBe("INVALID_INPUT");
  });

  it("matrix: self-approval, one vote, wrong role, duplicate, then two distinct approvers apply it once", async () => {
    const req = await svc.grantRole(a, { staffId: TARGET }, "ops", { reason: "rota" });
    expect(await code(svc.approve(a, req.id))).toBe("SELF_APPROVAL");
    expect(await code(svc.approve(sup, req.id))).toBe("FORBIDDEN");
    expect(await code(svc.approve(admin(uuidv7(), []), req.id))).toBe("FORBIDDEN");
    expect((await svc.approve(b, req.id)).status).toBe("PENDING");
    expect(await code(svc.approve(b, req.id))).toBe("ALREADY_DECIDED");
    expect(await code(svc.applyRoleGrant(c, req.id))).toBe("APPROVAL_NOT_APPROVED");
    expect((await svc.approve(c, req.id)).status).toBe("APPROVED");
    const first = await svc.applyRoleGrant(c, req.id);
    expect(first.executed).toBe(true);
    expect(await svc.applyRoleGrant(b, req.id)).toEqual({ executed: false, reason: "already_executed" });
    const rows = await client.query("SELECT expires_at FROM staff_role_assignments WHERE staff_id = $1", [TARGET]);
    expect(rows.rows).toHaveLength(1);
    expect((await svc.buildPrincipal("EG", TARGET)).roles).toEqual(["ops"]);
    expect(actions()).toEqual(expect.arrayContaining(["approval.requested", "approval.approved_vote", "role.granted", "approval.executed"]));
    const granted = audits.find((e) => e.action === "role.granted");
    expect(granted).toMatchObject({ actorType: "staff", actorId: C, targetType: "staff", targetId: TARGET, marketId: "EG" });
    // default life: 90 days
    expect(new Date((rows.rows[0] as { expires_at: Date }).expires_at).getTime()).toBe(T0.getTime() + 90 * DAY);
  });

  it("renewal extends the live grant instead of duplicating it", async () => {
    const t = uuidv7();
    for (const days of [10, 30]) {
      const r = await svc.grantRole(a, { staffId: t }, "marketing", { reason: "renew", ttlDays: days });
      await svc.approve(b, r.id); await svc.approve(c, r.id); await svc.applyRoleGrant(a, r.id);
    }
    const rows = await client.query<{ expires_at: Date }>("SELECT expires_at FROM staff_role_assignments WHERE staff_id = $1", [t]);
    expect(rows.rows).toHaveLength(1);
    expect(new Date(rows.rows[0]?.expires_at ?? 0).getTime()).toBe(T0.getTime() + 30 * DAY);
  });

  it("a rejection is terminal; an expired request cannot be approved and is persisted EXPIRED", async () => {
    const r1 = await svc.grantRole(a, { staffId: TARGET }, "dpo", { reason: "x" });
    expect((await svc.reject(b, r1.id, "no")).status).toBe("REJECTED");
    expect(await code(svc.approve(c, r1.id))).toBe("APPROVAL_NOT_PENDING");
    const r2 = await svc.grantRole(a, { staffId: TARGET }, "dpo", { reason: "x" });
    await svc.approve(b, r2.id);
    advance(25 * HOUR);
    expect(await code(svc.approve(c, r2.id))).toBe("APPROVAL_EXPIRED");
    const st = await client.query<{ status: string }>("SELECT status FROM approval_requests WHERE id = $1", [r2.id]);
    expect(st.rows[0]?.status).toBe("EXPIRED");
    expect(await code(svc.approve(c, r2.id))).toBe("APPROVAL_NOT_PENDING");
    expect(actions()).toContain("approval.expired");
  });

  it("revokeRole applies immediately, is audited, and cannot repeat", async () => {
    const t = uuidv7(); await seedGrant(t, "ops");
    const id = (await client.query<{ id: string }>("SELECT id FROM staff_role_assignments WHERE staff_id = $1", [t])).rows[0]?.id ?? "";
    await svc.revokeRole(a, id, { reason: "left team" });
    expect((await svc.buildPrincipal("EG", t)).roles).toEqual([]);
    expect(audits.at(-1)).toMatchObject({ action: "role.revoked", targetId: t });
    expect(await code(svc.revokeRole(a, id, { reason: "again" }))).toBe("ALREADY_REVOKED");
    expect(await code(svc.revokeRole(sup, id, { reason: "x" }))).toBe("FORBIDDEN");
    expect(await code(svc.revokeRole(a, uuidv7(), { reason: "x" }))).toBe("NOT_FOUND");
  });

  it("grants expire by time", async () => {
    const t = uuidv7();
    const r = await svc.grantRole(a, { staffId: t }, "support", { reason: "temp", ttlDays: 1 });
    await svc.approve(b, r.id); await svc.approve(c, r.id); await svc.applyRoleGrant(a, r.id);
    expect((await svc.buildPrincipal("EG", t)).roles).toEqual(["support"]);
    advance(DAY - 1);
    expect((await svc.buildPrincipal("EG", t)).roles).toEqual(["support"]);
    advance(1);
    expect((await svc.buildPrincipal("EG", t)).roles).toEqual([]);
  });
});

describe("generic dual approval (requireApproval / executeApproval)", () => {
  it("amount gate: below threshold direct, at/above or missing amount pending; executes once and rolls back on failure", async () => {
    const act = { action: "payout.approve", targetType: "payout", targetId: "p1", payload: { payoutId: "p1" } };
    expect(await svc.requireApproval(fin, { ...act, amountMinor: 999_999n })).toEqual({ required: false });
    const hi = await svc.requireApproval(fin, { ...act, amountMinor: 1_000_000n });
    const none = await svc.requireApproval(fin, act);
    expect(hi.required && none.required).toBe(true);
    if (!hi.required) throw new Error("unreachable");
    expect(hi.request.payload).toMatchObject({ amountMinor: "1000000" });
    expect(await code(svc.requireApproval(sup, { ...act, amountMinor: 1n }))).toBe("FORBIDDEN");
    const f2 = admin(uuidv7(), ["finance"]); const f3 = admin(uuidv7(), ["finance"]);
    await svc.approve(f2, hi.request.id); await svc.approve(f3, hi.request.id);
    let runs = 0;
    await expect(svc.executeApproval(fin, hi.request.id, () => { runs++; return Promise.reject(new Error("boom")); })).rejects.toThrow("boom");
    const ok = await svc.executeApproval(fin, hi.request.id, () => { runs++; return Promise.resolve("done"); });
    const again = await svc.executeApproval(fin, hi.request.id, () => { runs++; return Promise.resolve("twice"); });
    expect(ok).toEqual({ executed: true, result: "done" });
    expect(again).toEqual({ executed: false, reason: "already_executed" });
    expect(runs).toBe(2);
  });

  it("detects a tampered payload and refuses stale approvals", async () => {
    const res = await svc.requireApproval(d1, { action: "data.export", targetType: "export", targetId: "e1", payload: { scope: "orders" } });
    if (!res.required) throw new Error("data.export must always need approval");
    await svc.approve(d2, res.request.id); await svc.approve(d3, res.request.id);
    await client.query("UPDATE approval_requests SET payload = '{\"scope\":\"all_users\"}'::jsonb WHERE id = $1", [res.request.id]);
    expect(await code(svc.executeApproval(d1, res.request.id, () => Promise.resolve(1)))).toBe("APPROVAL_TAMPERED");
    const res2 = await svc.requireApproval(d1, { action: "data.export", targetType: "export", targetId: "e2", payload: {} });
    if (!res2.required) throw new Error("x");
    await svc.approve(d2, res2.request.id); await svc.approve(d3, res2.request.id);
    advance(25 * HOUR);
    expect(await code(svc.executeApproval(d1, res2.request.id, () => Promise.resolve(1)))).toBe("APPROVAL_EXPIRED");
  });

  it("super_admin without break-glass cannot approve; with break-glass it is dual-approved anyway", async () => {
    const res = await svc.requireApproval(d1, { action: "data.export", targetType: "export", targetId: "e3", payload: {} });
    if (!res.required) throw new Error("x");
    expect(await code(svc.approve(admin(uuidv7(), ["super_admin"]), res.request.id))).toBe("FORBIDDEN");
    expect((await svc.approve(admin(uuidv7(), ["super_admin"], true), res.request.id)).status).toBe("PENDING");
  });
});

describe("JIT elevation", () => {
  it("validates ttl and reason; approver must differ and hold role.grant; expires by the clock", async () => {
    const t = uuidv7(); const tp = admin(t, []);
    expect(await code(svc.requestElevation(tp, "ops", { reason: "incident", ttlMinutes: 61 }))).toBe("INVALID_INPUT");
    expect(await code(svc.requestElevation(tp, "ops", { reason: "incident", ttlMinutes: 0 }))).toBe("INVALID_INPUT");
    expect(await code(svc.requestElevation(tp, "ops", { reason: " ", ttlMinutes: 10 }))).toBe("INVALID_INPUT");
    const e = await svc.requestElevation(tp, "ops", { reason: "incident 42", ttlMinutes: 30 });
    expect(e.status).toBe("PENDING");
    expect((await svc.buildPrincipal("EG", t)).roles).toEqual([]);
    expect(await code(svc.approveElevation(tp, e.id))).toBe("SELF_APPROVAL");
    expect(await code(svc.approveElevation(sup, e.id))).toBe("FORBIDDEN");
    expect((await svc.approveElevation(a, e.id)).status).toBe("APPROVED");
    expect(await code(svc.approveElevation(b, e.id))).toBe("ELEVATION_NOT_PENDING");
    expect((await svc.buildPrincipal("EG", t)).roles).toEqual(["ops"]);
    advance(30 * MIN - 1);
    expect((await svc.buildPrincipal("EG", t)).roles).toEqual(["ops"]);
    advance(1);
    expect((await svc.buildPrincipal("EG", t)).roles).toEqual([]);
    expect(actions()).toEqual(expect.arrayContaining(["elevation.requested", "elevation.approved"]));
  });

  it("a pending request cannot be approved after 30 minutes; rejection is terminal", async () => {
    const tp = admin(uuidv7(), []);
    const e = await svc.requestElevation(tp, "finance", { reason: "audit", ttlMinutes: 5 });
    advance(31 * MIN);
    expect(await code(svc.approveElevation(a, e.id))).toBe("ELEVATION_EXPIRED");
    const e2 = await svc.requestElevation(tp, "finance", { reason: "audit", ttlMinutes: 5 });
    await svc.rejectElevation(a, e2.id);
    expect(await code(svc.approveElevation(b, e2.id))).toBe("ELEVATION_NOT_PENDING");
  });

  it("breakGlass only with an active super_admin elevation", async () => {
    const t = uuidv7(); const tp = admin(t, []);
    await seedGrant(t, "super_admin");
    const standing = await svc.buildPrincipal("EG", t);
    expect(standing.roles).toEqual(["super_admin"]);
    expect(standing.breakGlass).toBeUndefined();
    const e = await svc.requestElevation(tp, "super_admin", { reason: "prod fire", ttlMinutes: 15 });
    expect((await svc.buildPrincipal("EG", t)).breakGlass).toBeUndefined();
    expect(await code(svc.approveElevation(a, e.id))).toBe("DUAL_APPROVAL_REQUIRED");
    const reqId = e.approvalRequestId ?? "";
    await svc.approve(a, reqId); await svc.approve(b, reqId);
    expect((await svc.buildPrincipal("EG", t)).breakGlass).toBeUndefined();
    expect((await svc.activateElevation(c, reqId)).executed).toBe(true);
    expect((await svc.buildPrincipal("EG", t)).breakGlass).toBe(true);
    expect(audits.find((x) => x.action === "elevation.approved")?.diff?.after).toMatchObject({ breakGlass: true });
    advance(15 * MIN);
    expect((await svc.buildPrincipal("EG", t)).breakGlass).toBeUndefined();
    // a non-super elevation never sets it
    const o = admin(uuidv7(), []);
    const e2 = await svc.requestElevation(o, "ops", { reason: "x", ttlMinutes: 15 });
    await svc.approveElevation(a, e2.id);
    expect((await svc.buildPrincipal("EG", o.userId ?? "")).breakGlass).toBeUndefined();
  });
});

describe("reason codes for PII views", () => {
  const view = { action: "user.read", targetType: "user", targetId: "u-1" };
  it("throws for every action in REQUIRES_REASON_CODE without a valid code and writes nothing", async () => {
    const dpo = admin(uuidv7(), ["dpo", "finance", "support", "security"]);
    for (const action of ["user.read", "privacy.export", "data.export", "ledger.read"]) {
      const p = action === "ledger.read" ? admin(uuidv7(), ["finance"]) : dpo;
      expect(await code(svc.recordPiiView(p, { action, targetType: "t", targetId: "1" }, undefined))).toBe("REASON_CODE_REQUIRED");
      expect(await code(svc.recordPiiView(p, { action, targetType: "t", targetId: "1" }, "because"))).toBe("REASON_CODE_REQUIRED");
    }
    expect(await code(svc.recordPiiView(sup, view, "other_with_note"))).toBe("REASON_CODE_REQUIRED");
    expect(audits).toHaveLength(0);
  });
  it("writes an id-only audit entry; unauthorised actors are refused before any entry", async () => {
    await svc.recordPiiView(sup, view, "support_ticket");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "pii.viewed", actorId: SUP, targetType: "user", targetId: "u-1", diff: { after: { action: "user.read", reasonCode: "support_ticket" } } });
    await svc.recordPiiView(sup, view, "other_with_note", "customer called twice");
    expect(audits[1]?.diff?.after).toMatchObject({ reasonCode: "other_with_note", note: "customer called twice" });
    expect(await code(svc.recordPiiView(fin, view, "support_ticket"))).toBe("FORBIDDEN");
    expect(audits).toHaveLength(2);
  });
});

describe("database guarantees", () => {
  const ctx = (market: string) => async <T,>(sql: string, p: unknown[] = []): Promise<T[]> =>
    asRole(client, "outlet_app", async (tx) => { await applyDbContext(tx, { kind: "user", marketId: market, userId: A }); return (await tx.query<T & object>(sql, p)).rows; });
  it("outlet_app cannot DELETE history and is pinned to its market", async () => {
    const r = await svc.grantRole(a, { staffId: TARGET }, "ops", { reason: "x" });
    await expect(ctx("EG")("DELETE FROM approval_requests WHERE id = $1", [r.id])).rejects.toThrow(/permission denied/);
    await expect(ctx("EG")("DELETE FROM staff_role_assignments")).rejects.toThrow(/permission denied/);
    expect((await ctx("EG")("SELECT 1 FROM approval_requests WHERE id = $1", [r.id])).length).toBe(1);
    expect((await ctx("AE")("SELECT 1 FROM approval_requests WHERE id = $1", [r.id])).length).toBe(0);
    await expect(ctx("AE")("INSERT INTO approval_requests (id, market_id, action, target_type, target_id, payload, payload_hash, requested_by, status, expires_at, created_at) VALUES (gen_random_uuid(),'EG','x','t','1','{}',decode(repeat('00',32),'hex'),gen_random_uuid(),'PENDING',now(),now())")).rejects.toThrow(/row-level security/);
  });
  it("the database itself refuses the requester as approver", async () => {
    const r = await svc.grantRole(a, { staffId: TARGET }, "ops", { reason: "x" });
    await expect(client.query("INSERT INTO approval_decisions (id, approval_request_id, market_id, approver_id, decision, created_at) VALUES (gen_random_uuid(),$1,'EG',$2,'APPROVE',now())", [r.id, A])).rejects.toThrow(/approver must differ/);
  });
});

describe("break-glass dual approval (ADM-T06)", () => {
  const pending = async (reason = "prod fire") => {
    const t = uuidv7(); const tp = admin(t, []);
    const e = await svc.requestElevation(tp, "super_admin", { reason, ttlMinutes: 20 });
    return { t, tp, e, req: e.approvalRequestId ?? "" };
  };
  const events = async (type: string): Promise<{ payload: Record<string, string> }[]> =>
    (await client.query<{ payload: Record<string, string> }>("SELECT payload FROM outbox_events WHERE event_type = $1", [type])).rows;

  it("creates an elevation.approve request needing 2 approvals; one approver is insufficient", async () => {
    const { t, e, req } = await pending();
    expect(req).not.toBe("");
    const row = await client.query<{ action: string; required_approvals: number }>("SELECT action, required_approvals FROM approval_requests WHERE id = $1", [req]);
    expect(row.rows[0]).toMatchObject({ action: "elevation.approve", required_approvals: 2 });
    expect((await svc.approve(a, req)).status).toBe("PENDING");
    expect(await code(svc.activateElevation(b, req))).toBe("APPROVAL_NOT_APPROVED");
    expect((await svc.buildPrincipal("EG", t)).roles).toEqual([]);
    expect(await code(svc.approveElevation(a, e.id))).toBe("DUAL_APPROVAL_REQUIRED");
  });

  it("two distinct approvers activate it once and emit admin.break_glass_activated", async () => {
    const { t, req } = await pending("sev1 database fire");
    await svc.approve(a, req); await svc.approve(b, req);
    const first = await svc.activateElevation(c, req);
    expect(first.executed).toBe(true);
    expect(await svc.activateElevation(c, req)).toEqual({ executed: false, reason: "already_executed" });
    const p = await svc.buildPrincipal("EG", t);
    expect(p.roles).toEqual(["super_admin"]);
    expect(p.breakGlass).toBe(true);
    const ev = (await events("admin.break_glass_activated")).filter((x) => x.payload.actor === t);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ actor: t, approvers: [A, B].sort().join(","), reason: "sev1 database fire", ttlMinutes: "20" });
    advance(20 * MIN);
    expect((await svc.buildPrincipal("EG", t)).breakGlass).toBeUndefined();
  });

  it("the requester cannot approve or activate their own break-glass", async () => {
    const t = uuidv7(); await seedGrant(t, "security");
    const tp = await svc.buildPrincipal("EG", t);
    const e = await svc.requestElevation(tp, "super_admin", { reason: "self serve", ttlMinutes: 5 });
    const req = e.approvalRequestId ?? "";
    expect(await code(svc.approve(tp, req))).toBe("SELF_APPROVAL");
    await svc.approve(a, req); await svc.approve(b, req);
    expect(await code(svc.activateElevation(tp, req))).toBe("SELF_APPROVAL");
    expect((await svc.buildPrincipal("EG", t)).breakGlass).toBeUndefined();
    expect(await code(svc.approve(sup, req))).toBe("APPROVAL_NOT_PENDING");
  });

  it("approvers without role.grant are refused; the same approver cannot vote twice", async () => {
    const { req } = await pending();
    expect(await code(svc.approve(sup, req))).toBe("FORBIDDEN");
    await svc.approve(a, req);
    expect(await code(svc.approve(a, req))).toBe("ALREADY_DECIDED");
  });

  it("expires with the 30 minute window: no approval and no activation afterwards", async () => {
    const { t, req } = await pending();
    await svc.approve(a, req); await svc.approve(b, req);
    advance(31 * MIN);
    expect(await code(svc.activateElevation(c, req))).toBe("APPROVAL_EXPIRED");
    expect((await svc.buildPrincipal("EG", t)).roles).toEqual([]);
    const second = await pending();
    advance(31 * MIN);
    expect(await code(svc.approve(a, second.req))).toBe("APPROVAL_EXPIRED");
  });

  it("a rejected elevation cannot be activated; other roles keep single-approver elevation", async () => {
    const { e, req } = await pending();
    await svc.approve(a, req); await svc.approve(b, req);
    await svc.rejectElevation(c, e.id);
    expect(await code(svc.activateElevation(c, req))).toBe("ELEVATION_NOT_PENDING");
    const o = await svc.requestElevation(admin(uuidv7(), []), "ops", { reason: "x", ttlMinutes: 5 });
    expect(o.approvalRequestId).toBeUndefined();
    expect((await svc.approveElevation(a, o.id)).status).toBe("APPROVED");
  });

  it("activateElevation refuses a request that is not an elevation.approve", async () => {
    const r = await svc.grantRole(a, { staffId: TARGET }, "ops", { reason: "x" });
    await svc.approve(b, r.id); await svc.approve(c, r.id);
    expect(await code(svc.activateElevation(b, r.id))).toBe("INVALID_INPUT");
  });
});

describe("service error paths", () => {
  const exportReq = async (id: string) => {
    const res = await svc.requireApproval(d1, { action: "data.export", targetType: "export", targetId: id, payload: {} });
    if (!res.required) throw new Error("must need approval");
    return res.request;
  };
  it("executeApproval: unknown id, unapproved, rejected, replay and non-admin principal", async () => {
    expect(await code(svc.executeApproval(d1, uuidv7(), () => Promise.resolve(1)))).toBe("NOT_FOUND");
    expect(await code(svc.approve(d2, uuidv7()))).toBe("NOT_FOUND");
    const r = await exportReq("x1");
    expect(await code(svc.executeApproval(d1, r.id, () => Promise.resolve(1)))).toBe("APPROVAL_NOT_APPROVED");
    await svc.reject(d2, r.id);
    expect(await code(svc.executeApproval(d1, r.id, () => Promise.resolve(1)))).toBe("APPROVAL_NOT_APPROVED");
    const noUser: Principal = { kind: "admin", marketId: "EG", roles: ["dpo"], scopes: [] };
    expect(await code((async () => svc.executeApproval(noUser, r.id, () => Promise.resolve(1)))())).toBe("FORBIDDEN");
    const shopper: Principal = { kind: "shopper", userId: uuidv7(), marketId: "EG", roles: [], scopes: [] };
    expect(await code(svc.requireApproval(shopper, { action: "data.export", targetType: "e", targetId: "1", payload: {} }))).toBe("FORBIDDEN");
  });
  it("executeApproval replay never reruns the callback", async () => {
    const r = await exportReq("x2");
    await svc.approve(d2, r.id); await svc.approve(d3, r.id);
    let n = 0;
    await svc.executeApproval(d1, r.id, () => { n++; return Promise.resolve(0); });
    expect(await svc.executeApproval(d1, r.id, () => { n++; return Promise.resolve(0); })).toEqual({ executed: false, reason: "already_executed" });
    expect(n).toBe(1);
  });
  it("applyRoleGrant refuses a non role.grant request and a tampered grant payload", async () => {
    const r = await exportReq("x3");
    await svc.approve(d2, r.id); await svc.approve(d3, r.id);
    expect(await code(svc.applyRoleGrant(d1, r.id))).toBe("INVALID_INPUT");
    const g = await svc.grantRole(a, { staffId: TARGET }, "ops", { reason: "t" });
    await svc.approve(b, g.id); await svc.approve(c, g.id);
    await client.query("UPDATE approval_requests SET payload = jsonb_set(payload, '{role}', '\"super_admin\"') WHERE id = $1", [g.id]);
    expect(await code(svc.applyRoleGrant(a, g.id))).toBe("APPROVAL_TAMPERED");
  });
  it("grantRole bounds ttlDays; revokeRole requires a reason; elevation of unknown id", async () => {
    expect(await code(svc.grantRole(a, { staffId: TARGET }, "ops", { reason: "x", ttlDays: 0 }))).toBe("INVALID_INPUT");
    expect(await code(svc.grantRole(a, { staffId: TARGET }, "ops", { reason: "x", ttlDays: 366 }))).toBe("INVALID_INPUT");
    expect(await code(svc.revokeRole(a, uuidv7(), { reason: " " }))).toBe("INVALID_INPUT");
    expect(await code(svc.approveElevation(a, uuidv7()))).toBe("NOT_FOUND");
  });
  it("requestElevation rejects non-admin principals and ttl bounds 0 and 61", async () => {
    const shopper: Principal = { kind: "shopper", userId: uuidv7(), marketId: "EG", roles: [], scopes: [] };
    expect(await code(svc.requestElevation(shopper, "ops", { reason: "x", ttlMinutes: 5 }))).toBe("FORBIDDEN");
    for (const ttlMinutes of [0, 61]) expect(await code(svc.requestElevation(admin(uuidv7(), []), "super_admin", { reason: "x", ttlMinutes }))).toBe("INVALID_INPUT");
    expect(await code(svc.requestElevation(admin(uuidv7(), []), "ops", { reason: "x", ttlMinutes: 1.5 }))).toBe("INVALID_INPUT");
  });
  it("recordPiiView: note too long, unknown code on a non-required action is a no-op, other_with_note with blank note", async () => {
    expect(await code(svc.recordPiiView(sup, { action: "user.read", targetType: "user", targetId: "u" }, "support_ticket", "x".repeat(501)))).toBe("INVALID_INPUT");
    expect(await code(svc.recordPiiView(sup, { action: "user.read", targetType: "user", targetId: "u" }, "other_with_note", "   "))).toBe("REASON_CODE_REQUIRED");
    expect(audits).toHaveLength(0);
  });
  it("buildPrincipal defaults to the injected clock and honours an explicit time", async () => {
    const t = uuidv7(); await seedGrant(t, "ops");
    expect((await svc.buildPrincipal("EG", t, new Date("2019-01-01"))).roles).toEqual([]);
    expect((await svc.buildPrincipal("EG", t, new Date(T0))).roles).toEqual(["ops"]);
    expect((await svc.buildPrincipal("AE", t)).roles).toEqual([]);
  });
});
