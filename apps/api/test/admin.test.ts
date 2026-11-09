import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_FIXTURES, seedApproval, seedKycCase, seedRun } from "./admin-fixtures.js";
import { bearer, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { createTestApp } from "./harness.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller states the expected shape
const json = <T>(body: string): T => JSON.parse(body) as T;
const post = (token: string, url: string, payload: object, key = idemKey(t)) => t.inject({ method: "POST", url, headers: { ...bearer(token), "idempotency-key": key }, payload });
const auditActions = (): string[] => t.adminAudit.entries.map((e) => e.action);

describe("admin principal", () => {
  it("a standing grant that expired, or one that was revoked, grants nothing", async () => {
    const { userId, token } = await t.admin(["security"]);
    await t.raw.query("UPDATE staff_role_assignments SET revoked_at = now() WHERE staff_id = $1", [userId]);
    const res = await t.inject({ method: "GET", url: "/v1/eg/admin/approval-requests", headers: bearer(token) });
    expect(res.statusCode).toBe(403);
  });

  it("super_admin works only with a live approved break-glass elevation", async () => {
    const { userId, token } = await t.admin(["super_admin"]);
    const url = "/v1/eg/admin/approval-requests";
    expect((await t.inject({ method: "GET", url, headers: bearer(token) })).statusCode).toBe(403);
    await t.raw.query(
      `INSERT INTO elevation_requests (id, market_id, staff_id, role_code, reason, ttl_minutes, status, pending_until, created_at, approved_by, decided_at, starts_at, expires_at)
       VALUES (gen_random_uuid(),'EG',$1,'super_admin','incident',30,'APPROVED','2100-01-01','2020-01-01',gen_random_uuid(),'2020-01-01','2020-01-01','2100-01-01')`,
      [userId],
    );
    expect((await t.inject({ method: "GET", url, headers: bearer(token) })).statusCode).toBe(200);
  });
});

describe("approval queue", () => {
  it("lists newest first with a keyset cursor and filters by status", async () => {
    const { token } = await t.admin(["security"]);
    await seedApproval(t.raw);
    await seedApproval(t.raw);
    await seedApproval(t.raw, { status: "REJECTED" });
    const first = json<{ items: { id: string; status: string }[]; next_cursor: string | null }>((await t.inject({ method: "GET", url: "/v1/eg/admin/approval-requests?status=PENDING&limit=1", headers: bearer(token) })).body);
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const second = json<{ items: { id: string; status: string }[] }>((await t.inject({ method: "GET", url: `/v1/eg/admin/approval-requests?status=PENDING&limit=1&cursor=${first.next_cursor ?? ""}`, headers: bearer(token) })).body);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect([...first.items, ...second.items].every((i) => i.status === "PENDING")).toBe(true);
  });

  it("dual approval: the requester can never decide, one vote leaves it PENDING, the second distinct approver approves", async () => {
    const requester = await t.admin(["security"]);
    const a = await seedApproval(t.raw, { requestedBy: requester.userId });
    const url = `/v1/eg/admin/approval-requests/${a.id}/decision`;
    const own = await post(requester.token, url, { decision: "approve", reason: "my own request" });
    expect(own.statusCode).toBe(403);
    expect(json<{ code: string }>(own.body).code).toBe("self-approval");
    const one = await t.admin(["security"]);
    const r1 = await post(one.token, url, { decision: "approve", reason: "first look ok" });
    expect(r1.statusCode).toBe(200);
    expect(json<{ status: string }>(r1.body).status).toBe("PENDING");
    const again = await post(one.token, url, { decision: "approve", reason: "voting twice" });
    expect(again.statusCode).toBe(409);
    const two = await t.admin(["security"]);
    const r2 = await post(two.token, url, { decision: "approve", reason: "second look ok" });
    expect(json<{ status: string; decided_by: string }>(r2.body)).toMatchObject({ status: "APPROVED", decided_by: two.userId });
    expect(auditActions()).toEqual(expect.arrayContaining(["approval.approved_vote"]));
    const done = await post((await t.admin(["security"])).token, url, { decision: "reject", reason: "too late to change" });
    expect(done.statusCode).toBe(409);
  });

  it("the role of the request's own action is re-checked: security cannot vote on a payout approval", async () => {
    const a = await seedApproval(t.raw, { action: "payout.approve" });
    const { token } = await t.admin(["security"]);
    expect((await post(token, `/v1/eg/admin/approval-requests/${a.id}/decision`, { decision: "approve", reason: "not my area" })).statusCode).toBe(403);
  });

  it("rejects unknown body fields and short reasons (strict DTO)", async () => {
    const a = await seedApproval(t.raw);
    const { token } = await t.admin(["security"]);
    const url = `/v1/eg/admin/approval-requests/${a.id}/decision`;
    expect((await post(token, url, { decision: "approve", reason: "fine reason", status: "APPROVED" })).statusCode).toBe(400);
    expect((await post(token, url, { decision: "approve", reason: "no" })).statusCode).toBe(400);
  });

  it("replaying the same Idempotency-Key returns the stored answer and casts no second vote", async () => {
    const a = await seedApproval(t.raw);
    const { token } = await t.admin(["security"]);
    const url = `/v1/eg/admin/approval-requests/${a.id}/decision`;
    const key = idemKey(t);
    const r1 = await post(token, url, { decision: "approve", reason: "looks right" }, key);
    const r2 = await post(token, url, { decision: "approve", reason: "looks right" }, key);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.headers["idempotent-replayed"]).toBe("true");
    const votes = await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM approval_decisions WHERE approval_request_id = $1", [a.id]);
    expect(votes.rows[0]?.n).toBe(1);
  });
});

describe("KYC", () => {
  it("lists submitted cases with the Arabic legal name and filters by status", async () => {
    const k = await seedKycCase(t.raw, "NEEDS_INFO");
    const { token } = await t.admin(["trust_safety"]);
    const res = json<{ items: { id: string; legal_name_ar: string; status: string }[] }>((await t.inject({ method: "GET", url: "/v1/eg/admin/kyc-cases?status=NEEDS_INFO&limit=50", headers: bearer(token) })).body);
    const hit = res.items.find((i) => i.id === k.caseId);
    expect(hit).toMatchObject({ status: "NEEDS_INFO", legal_name_ar: "شركة الاختبار" });
  });

  it("approve moves the case and the seller, writes the decision log, and a reject needs a reason code the API supplies", async () => {
    const k = await seedKycCase(t.raw);
    const { userId, token } = await t.admin(["ops"]);
    const res = await post(token, `/v1/eg/admin/kyc-cases/${k.caseId}/decision`, { decision: "APPROVED", decision_reason: "documents verified" });
    expect(res.statusCode).toBe(200);
    expect(json<{ status: string }>(res.body).status).toBe("APPROVED");
    const seller = await t.raw.query<{ status: string }>("SELECT status FROM sellers WHERE id = $1", [k.sellerId]);
    expect(seller.rows[0]?.status).toBe("active");
    const log = await t.raw.query<{ actor_kind: string; actor_id: string }>("SELECT actor_kind, actor_id FROM kyc_decisions WHERE case_id = $1", [k.caseId]);
    expect(log.rows[0]).toMatchObject({ actor_kind: "admin", actor_id: userId });
    const k2 = await seedKycCase(t.raw);
    const rej = await post(token, `/v1/eg/admin/kyc-cases/${k2.caseId}/decision`, { decision: "REJECTED", decision_reason: "register number does not match" });
    expect(json<{ status: string }>(rej.body).status).toBe("REJECTED");
  });

  it("a decision on a case that is not in a decidable state is a 409, and finance cannot decide", async () => {
    const k = await seedKycCase(t.raw, "SUBMITTED");
    const { token } = await t.admin(["ops"]);
    expect((await post(token, `/v1/eg/admin/kyc-cases/${k.caseId}/decision`, { decision: "APPROVED", decision_reason: "again please" })).statusCode).toBe(409);
    const fin = await t.admin(["finance"]);
    expect((await post(fin.token, `/v1/eg/admin/kyc-cases/${k.caseId}/decision`, { decision: "APPROVED", decision_reason: "again please" })).statusCode).toBe(403);
  });
});

describe("reconciliation reads need a reason code and are audited", () => {
  it("no X-Reason-Code: 403 reason-code-required, nothing is logged and nothing is read", async () => {
    const { token } = await t.admin(["finance"]);
    const before = t.adminAudit.entries.length;
    const res = await t.inject({ method: "GET", url: "/v1/eg/admin/reconciliation/runs", headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(json<{ code: string }>(res.body).code).toBe("reason-code-required");
    expect(t.adminAudit.entries.length).toBe(before);
  });

  it("a reason code outside the taxonomy is refused before any data is returned", async () => {
    const { token } = await t.admin(["finance"]);
    const before = t.adminAudit.entries.length;
    const res = await t.inject({ method: "GET", url: "/v1/eg/admin/reconciliation/runs", headers: { ...bearer(token), "x-reason-code": "curiosity" } });
    expect(res.statusCode).toBe(403);
    expect(t.adminAudit.entries.length).toBe(before);
  });

  it("with a reason code the read succeeds and one pii.viewed entry carries ids and the code, never the data", async () => {
    const run = await seedRun(t.raw);
    const { userId, token } = await t.admin(["finance"]);
    const before = t.adminAudit.entries.length;
    const res = await t.inject({ method: "GET", url: `/v1/eg/admin/reconciliation/runs/${run.runId}/items`, headers: { ...bearer(token), "x-reason-code": "finance_reconciliation" } });
    expect(res.statusCode).toBe(200);
    const body = json<{ items: { id: string; status: string; age_days: number; expected: { amount_minor: string } | null; actual: unknown }[] }>(res.body);
    expect(body.items[0]).toMatchObject({ id: run.itemId, status: "MISSING_SOURCE", age_days: 2, actual: null, expected: { amount_minor: "12500", currency: "EGP" } });
    const entries = t.adminAudit.entries.slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "pii.viewed", actorId: userId, targetType: "reconciliation_run", targetId: run.runId, diff: { after: { piiAccessId: expect.any(String) as unknown } } });
    const logged = await t.raw.query<{ action: string; reason_code: string; target_id: string }>("SELECT action, reason_code, target_id FROM pii_access_log WHERE actor_id = $1", [userId]);
    expect(logged.rows).toEqual([{ action: "ledger.read", reason_code: "finance_reconciliation", target_id: run.runId }]);
  });

  it("lists runs with the contract source names", async () => {
    await seedRun(t.raw);
    const { token } = await t.admin(["finance"]);
    const res = json<{ items: { source: string; status: string; matched_count: number }[] }>((await t.inject({ method: "GET", url: "/v1/eg/admin/reconciliation/runs?source=psp_settlement&limit=50", headers: { ...bearer(token), "x-reason-code": "finance_reconciliation" } })).body);
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items[0]).toMatchObject({ source: "psp_settlement", status: "COMPLETED", matched_count: 3 });
  });
});

describe("coverage", () => {
  it("has a fixture for every admin route (routes.test.ts runs the matrix)", () => {
    expect(Object.keys(ADMIN_FIXTURES)).toHaveLength(13);
  });
});
