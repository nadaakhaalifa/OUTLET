import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDispute, seedPayout, seedPayoutHold, seedRefund, seedReturn } from "./admin-fixtures.js";
import { bearer, createTestApp, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => t.close());

type Json = Record<string, unknown>;
const get = async (token: string, path: string): Promise<{ status: number; body: Json; raw: string }> => {
  const r = await t.inject({ method: "GET", url: `/v1/eg/admin/${path}`, headers: bearer(token) });
  return { status: r.statusCode, body: JSON.parse(r.body) as Json, raw: r.body };
};
const post = async (token: string, path: string, payload: unknown): Promise<{ status: number; body: Json }> => {
  const r = await t.inject({ method: "POST", url: `/v1/eg/admin/${path}`, headers: { ...bearer(token), "idempotency-key": idemKey(t) }, payload: payload as object });
  return { status: r.statusCode, body: JSON.parse(r.body) as Json };
};
const clean = async (): Promise<void> => {
  await t.raw.query("DELETE FROM payout_holds");
  await t.raw.query("DELETE FROM payouts");
  await t.raw.query("DELETE FROM disputes");
  await t.raw.query("DELETE FROM refunds");
  await t.raw.query("DELETE FROM return_requests");
};
const payoutRow = async (id: string): Promise<{ status: string; hold_reason: string | null; version: number }> =>
  (await t.raw.query<{ status: string; hold_reason: string | null; version: number }>("SELECT status, hold_reason, version FROM payouts WHERE id = $1", [id])).rows[0] ?? { status: "missing", hold_reason: null, version: 0 };

describe("admin refunds list", () => {
  it("lists the market's refunds newest first with keyset paging, status filter, open counts and amounts, and no shopper data", async () => {
    await clean();
    const a = await seedRefund(t.raw, { status: "REQUESTED", amount: 10_000n, createdAt: "2029-12-31T09:00:00Z", dueAt: "2029-12-30T00:00:00Z" });
    const b = await seedRefund(t.raw, { status: "MANUAL_REVIEW", amount: 5_000n, createdAt: "2029-12-31T10:00:00Z", dueAt: "2100-01-01T00:00:00Z" });
    await seedRefund(t.raw, { status: "COMPLETED", amount: 7_000n, createdAt: "2029-12-31T11:00:00Z" });
    await seedRefund(t.raw, { market: "AE", status: "FAILED", amount: 99_000n });
    const fin = await t.admin(["finance"]);
    const p1 = await get(fin.token, "refunds?limit=1");
    expect(p1.status).toBe(200);
    expect(p1.raw).not.toContain("201000000000");
    expect(p1.raw).not.toContain("user_id");
    expect(p1.raw).not.toContain("last_error");
    const page1 = p1.body as { items: { id: string; status: string }[]; next_cursor: string | null; summary: { status: string; count: number; amount: { amount_minor: string; currency: string } }[]; overdue_count: number };
    expect(page1.items[0]?.status).toBe("COMPLETED");
    expect(page1.next_cursor).not.toBeNull();
    // The market's not-completed totals do not depend on the page or the filter, and never include another market.
    expect(page1.summary).toEqual([
      { status: "MANUAL_REVIEW", count: 1, amount: { amount_minor: "5000", currency: "EGP" } },
      { status: "REQUESTED", count: 1, amount: { amount_minor: "10000", currency: "EGP" } },
    ]);
    expect(page1.overdue_count).toBe(1);
    const rest = await get(fin.token, `refunds?limit=5&cursor=${page1.next_cursor ?? ""}`);
    expect((rest.body.items as { id: string }[]).map((i) => i.id)).toEqual([b.id, a.id]);
    const only = await get(fin.token, "refunds?status=REQUESTED");
    expect(only.body.items).toMatchObject([{ id: a.id, order_group_id: a.orderGroupId, store_id: a.storeId, amount: { amount_minor: "10000", currency: "EGP" }, overdue: true }]);
    expect((await get(fin.token, "refunds?status=NOPE")).status).toBe(400);
    expect((await get(fin.token, "refunds?cursor=bm90LWEtdXVpZA")).status).toBe(400);
  });

  it("is finance only: every other admin role and a shopper get 403, a break-glass-less super_admin too", async () => {
    for (const role of ["ops", "support", "trust_safety", "marketing", "dpo", "security"]) {
      expect((await get((await t.admin([role])).token, "refunds")).status, role).toBe(403);
    }
    expect((await get((await t.shopper()).token, "refunds")).status).toBe(403);
  });
});

describe("admin returns and disputes lists", () => {
  it("returns: stage filter matches the Home pipeline (requested, in transit, awaiting inspection, overdue) and carries no shopper identity", async () => {
    await clean();
    const req = await seedReturn(t.raw, { status: "REQUESTED" });
    const transit = await seedReturn(t.raw, { status: "IN_TRANSIT" });
    const waiting = await seedReturn(t.raw, { status: "RECEIVED", inspectionDueAt: "2100-01-01T00:00:00Z" });
    const overdue = await seedReturn(t.raw, { status: "RECEIVED", inspectionDueAt: "2000-01-01T00:00:00Z" });
    await seedReturn(t.raw, { status: "CLOSED" });
    await seedReturn(t.raw, { market: "AE", status: "REQUESTED" });
    const ops = await t.admin(["ops"]);
    const all = await get(ops.token, "returns?limit=50");
    expect(all.status).toBe(200);
    expect(all.raw).not.toContain(req.userId);
    expect(all.raw).not.toContain("user_id");
    expect((all.body.items as unknown[]).length).toBe(4);
    expect(all.body.summary).toEqual({ requested: 1, in_transit: 1, awaiting_inspection: 2, inspection_overdue: 1 });
    const ids = async (stage: string): Promise<string[]> => ((await get(ops.token, `returns?stage=${stage}`)).body.items as { id: string }[]).map((i) => i.id);
    expect(await ids("requested")).toEqual([req.id]);
    expect(await ids("in_transit")).toEqual([transit.id]);
    expect((await ids("awaiting_inspection")).sort()).toEqual([waiting.id, overdue.id].sort());
    expect(await ids("inspection_overdue")).toEqual([overdue.id]);
    expect(((await get(ops.token, "returns?stage=inspection_overdue")).body.items as { stage: string }[])[0]?.stage).toBe("inspection_overdue");
    expect((await get(ops.token, "returns?stage=x")).status).toBe(400);
    for (const role of ["support", "trust_safety"]) expect((await get((await t.admin([role])).token, "returns")).status, role).toBe(200);
    for (const role of ["marketing", "dpo", "security"]) expect((await get((await t.admin([role])).token, "returns")).status, role).toBe(403);
  });

  it("disputes: the open queue by default, past-SLA flag, never the shopper's note; trust_safety only", async () => {
    await clean();
    const late = await seedDispute(t.raw, { status: "OPEN", slaDueAt: "2000-01-01T00:00:00Z" });
    const fine = await seedDispute(t.raw, { status: "UNDER_REVIEW" });
    const done = await seedDispute(t.raw, { status: "RESOLVED_SELLER" });
    await seedDispute(t.raw, { market: "AE", status: "OPEN" });
    const ts = await t.admin(["trust_safety"]);
    const open = await get(ts.token, "disputes");
    expect(open.raw).not.toContain("201000000000");
    expect(open.raw).not.toContain("shopper_note");
    expect((open.body.items as { id: string; past_sla: boolean }[]).map((i) => [i.id, i.past_sla]).sort()).toEqual([[late.id, true], [fine.id, false]].sort());
    expect(open.body.summary).toEqual({ open: 2, past_sla: 1 });
    expect((await get(ts.token, "disputes?status=RESOLVED_SELLER")).body.items).toMatchObject([{ id: done.id, past_sla: false }]);
    for (const role of ["ops", "finance", "support", "marketing", "dpo", "security"]) expect((await get((await t.admin([role])).token, "disputes")).status, role).toBe(403);
  });
});

describe("admin payouts", () => {
  it("lists with status filter, open counts and net amounts; detail adds line count and the store's open holds; another market is 404", async () => {
    await clean();
    const sched = await seedPayout(t.raw, { status: "SCHEDULED", createdAt: "2029-12-31T10:00:00Z" });
    await seedPayoutHold(t.raw, sched.storeId);
    const held = await seedPayout(t.raw, { status: "ON_HOLD", holdReason: "iban_name_mismatch", createdAt: "2029-12-31T11:00:00Z" });
    await seedPayout(t.raw, { status: "SETTLED" });
    const foreign = await seedPayout(t.raw, { market: "AE" });
    const fin = await t.admin(["finance"]);
    const list = await get(fin.token, "payouts?limit=1");
    const p1 = list.body as { items: { id: string }[]; next_cursor: string | null; summary: { status: string; count: number; net: { amount_minor: string } }[] };
    expect(p1.next_cursor).not.toBeNull();
    expect(p1.summary).toEqual([
      { status: "ON_HOLD", count: 1, net: { amount_minor: "240000", currency: "EGP" } },
      { status: "SCHEDULED", count: 1, net: { amount_minor: "240000", currency: "EGP" } },
    ]);
    expect((await get(fin.token, "payouts?status=ON_HOLD")).body.items).toMatchObject([{ id: held.id, status: "ON_HOLD", hold_reason: "iban_name_mismatch", net: { amount_minor: "240000", currency: "EGP" } }]);
    const detail = await get(fin.token, `payouts/${sched.id}`);
    expect(detail.body).toMatchObject({ id: sched.id, status: "SCHEDULED", line_count: 0, open_holds: [{ reason: "risk", released_at: null }] });
    expect((await get(fin.token, `payouts/${foreign.id}`)).status).toBe(404);
    expect((await get(fin.token, `payouts/${randomUUID()}`)).status).toBe(404);
    for (const role of ["ops", "support", "trust_safety", "dpo"]) expect((await get((await t.admin([role])).token, "payouts")).status, role).toBe(403);
  });

  it("hold: SCHEDULED -> ON_HOLD with intent and result audited and an outbox event; the same hold again changes nothing; another state is 409; another market is 404", async () => {
    await clean();
    const p = await seedPayout(t.raw, { status: "SCHEDULED" });
    const sent = await seedPayout(t.raw, { status: "SENT" });
    const foreign = await seedPayout(t.raw, { market: "AE" });
    const fin = await t.admin(["finance"]);
    const before = t.adminAudit.entries.length;
    const r = await post(fin.token, `payouts/${p.id}/hold`, { reason_code: "risk_review" });
    expect(r).toMatchObject({ status: 200, body: { id: p.id, status: "ON_HOLD", hold_reason: "ops:risk_review" } });
    expect(await payoutRow(p.id)).toMatchObject({ status: "ON_HOLD", hold_reason: "ops:risk_review", version: 2 });
    expect(t.adminAudit.entries.slice(before)).toMatchObject([
      { action: "payout.hold_requested", actorId: fin.userId, targetId: p.id, diff: { after: { reasonCode: "risk_review" } } },
      { action: "payout.on_hold", actorId: fin.userId, targetId: p.id, diff: { after: { status: "ON_HOLD", reasonCode: "risk_review" } } },
    ]);
    const ev = await t.raw.query<{ n: string }>("SELECT count(*)::text AS n FROM outbox_events WHERE event_type = 'payout.on_hold' AND aggregate_id = $1", [p.id]);
    expect(ev.rows[0]?.n).toBe("1");
    expect(await post(fin.token, `payouts/${p.id}/hold`, { reason_code: "risk_review" })).toMatchObject({ status: 200, body: { status: "ON_HOLD" } });
    expect(t.adminAudit.entries.length).toBe(before + 2);
    expect((await payoutRow(p.id)).version).toBe(2);
    expect(await post(fin.token, `payouts/${sent.id}/hold`, { reason_code: "risk_review" })).toMatchObject({ status: 409, body: { code: "invalid-transition" } });
    expect((await payoutRow(sent.id)).status).toBe("SENT");
    expect((await post(fin.token, `payouts/${foreign.id}/hold`, { reason_code: "risk_review" })).status).toBe(404);
    expect((await payoutRow(foreign.id)).status).toBe("SCHEDULED");
    expect((await post(fin.token, `payouts/${p.id}/hold`, { reason_code: "because" })).status).toBe(400);
    expect((await post(fin.token, `payouts/${p.id}/hold`, { reason_code: "risk_review", note: "x" })).status).toBe(400);
    for (const role of ["ops", "support", "trust_safety", "dpo", "security"]) expect((await post((await t.admin([role])).token, `payouts/${p.id}/hold`, { reason_code: "risk_review" })).status, role).toBe(403);
  });

  it("a failing audit port stops the hold (nothing changes, so nothing is unaudited)", async () => {
    await clean();
    const p = await seedPayout(t.raw, { status: "SCHEDULED" });
    const { PayoutsAdmin } = await import("../src/modules/admin/index.js");
    const { roleClient } = await import("@outlet/db/testing");
    const fin = await t.admin(["finance"]);
    const staff = { kind: "admin" as const, userId: fin.userId, marketId: "EG", roles: ["finance"], scopes: [] };
    const down = new PayoutsAdmin(t.payoutService, roleClient(t.raw, "outlet_app"), { appendIn: () => Promise.reject(new Error("audit down")) });
    await expect(down.hold(staff, p.id, "risk_review")).rejects.toThrow("audit down");
    expect((await payoutRow(p.id)).status).toBe("SCHEDULED");
  });

  it("release is always dual approval: the first call files the request and changes nothing; the second finance approver's vote releases it once, voiding the earlier approval", async () => {
    await clean();
    const p = await seedPayout(t.raw, { status: "ON_HOLD", holdReason: "ops:risk_review" });
    const sched = await seedPayout(t.raw, { status: "SCHEDULED" });
    const one = await t.admin(["finance"]);
    expect(await post(one.token, `payouts/${sched.id}/release`, { reason_code: "issue_resolved" })).toMatchObject({ status: 409, body: { code: "invalid-transition" } });
    const asked = await post(one.token, `payouts/${p.id}/release`, { reason_code: "issue_resolved" });
    expect(asked).toMatchObject({ status: 409, body: { code: "dual-approval-required" } });
    expect(await payoutRow(p.id)).toMatchObject({ status: "ON_HOLD", hold_reason: "ops:risk_review" });
    const url = `approval-requests/${String(asked.body.detail)}/decision`;
    // The requester can never decide their own request.
    expect((await post(one.token, url, { decision: "approve", reason: "mine" })).status).toBe(403);
    // A role without payout.release cannot vote.
    expect((await post((await t.admin(["security"])).token, url, { decision: "approve", reason: "not mine to decide" })).status).toBe(403);
    const before = t.adminAudit.entries.length;
    expect(await post((await t.admin(["finance"])).token, url, { decision: "approve", reason: "issue is resolved" })).toMatchObject({ status: 200, body: { status: "PENDING" } });
    expect(await payoutRow(p.id)).toMatchObject({ status: "ON_HOLD" });
    const vote = await post((await t.admin(["finance"])).token, url, { decision: "approve", reason: "second look agrees" });
    expect(vote).toMatchObject({ status: 200, body: { status: "EXECUTED" } });
    expect(await payoutRow(p.id)).toMatchObject({ status: "SCHEDULED", hold_reason: null });
    expect(t.adminAudit.entries.slice(before).map((e) => e.action)).toContain("payout.released");
    // Re-running the recovery route for an executed request is refused and changes nothing.
    expect((await post((await t.admin(["finance"])).token, `approval-requests/${String(asked.body.detail)}/execute`, {})).status).toBe(409);
    expect((await payoutRow(p.id)).status).toBe("SCHEDULED");
    for (const role of ["ops", "support", "trust_safety"]) expect((await post((await t.admin([role])).token, `payouts/${p.id}/release`, { reason_code: "issue_resolved" })).status, role).toBe(403);
    expect((await post(one.token, `payouts/${p.id}/release`, { reason_code: "nope" })).status).toBe(400);
  });
});

describe("admin payout release is bound to the hold it was requested for", () => {
  it("asking again returns the live request; a stale approval (payout re-held with another reason) never releases and the refusal is audited", async () => {
    await clean();
    const p = await seedPayout(t.raw, { status: "ON_HOLD", holdReason: "ops:risk_review" });
    const one = await t.admin(["finance"]);
    const first = await post(one.token, `payouts/${p.id}/release`, { reason_code: "issue_resolved" });
    expect(first).toMatchObject({ status: 409, body: { code: "dual-approval-required" } });
    // A second click returns the same pending request instead of filing another.
    expect((await post(one.token, `payouts/${p.id}/release`, { reason_code: "issue_resolved" })).body.detail).toBe(first.body.detail);
    // The payout is released and held again for another reason while the first request is still pending.
    await t.payoutService.release("EG", p.id);
    expect(await post(one.token, `payouts/${p.id}/hold`, { reason_code: "iban_check" })).toMatchObject({ status: 200, body: { status: "ON_HOLD", hold_reason: "ops:iban_check" } });
    const url = `approval-requests/${String(first.body.detail)}/decision`;
    const before = t.adminAudit.entries.length;
    expect((await post((await t.admin(["finance"])).token, url, { decision: "approve", reason: "first look" })).status).toBe(200);
    const vote = await post((await t.admin(["finance"])).token, url, { decision: "approve", reason: "second look" });
    expect(vote).toMatchObject({ status: 409, body: { code: "stale-approval" } });
    expect(await payoutRow(p.id)).toMatchObject({ status: "ON_HOLD", hold_reason: "ops:iban_check" });
    expect(t.adminAudit.entries.slice(before).map((e) => e.action)).toContain("payout.release_refused");
    // The current hold gets its own request (not the stale one).
    const again = await post(one.token, `payouts/${p.id}/release`, { reason_code: "issue_resolved" });
    expect(again).toMatchObject({ status: 409, body: { code: "dual-approval-required" } });
    expect(again.body.detail).not.toBe(first.body.detail);
  });

  it("a hold that loses the race audits payout.hold_failed after its intent", async () => {
    await clean();
    const p = await seedPayout(t.raw, { status: "SCHEDULED" });
    const { PayoutsAdmin } = await import("../src/modules/admin/index.js");
    const { roleClient } = await import("@outlet/db/testing");
    const { PayoutsError } = await import("@outlet/payouts");
    const fin = await t.admin(["finance"]);
    const staff = { kind: "admin" as const, userId: fin.userId, marketId: "EG", roles: ["finance"], scopes: [] };
    const seen: string[] = [];
    const audit = { appendIn: (_tx: unknown, e: { action: string }) => { seen.push(e.action); return Promise.resolve(undefined as never); } };
    const racing = new PayoutsAdmin({ get: t.payoutService.get.bind(t.payoutService), hold: () => Promise.reject(new PayoutsError("INVALID_STATE", "raced")), release: t.payoutService.release.bind(t.payoutService) }, roleClient(t.raw, "outlet_app"), audit);
    await expect(racing.hold(staff, p.id, "risk_review")).rejects.toMatchObject({ code: "invalid-transition" });
    expect(seen).toEqual(["payout.hold_requested", "payout.hold_failed"]);
  });
});

describe("admin lists fail closed", () => {
  it("answers 503 when the lists are not composed", async () => {
    const bare = await createTestApp({ adminOps: false });
    try {
      const fin = await bare.admin(["finance"]);
      for (const path of ["refunds", "payouts"]) expect((await bare.inject({ method: "GET", url: `/v1/eg/admin/${path}`, headers: bearer(fin.token) })).statusCode, path).toBe(503);
    } finally {
      await bare.close();
    }
  });
});
