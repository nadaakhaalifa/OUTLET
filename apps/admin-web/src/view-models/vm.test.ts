import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { admin } from "@outlet/domain";
import { KILL_SWITCHES } from "@outlet/feature-flags";
import type { AdminMe, ApprovalWire, BreachWire, DsarItemWire, FlagWire, LedgerBalanceWire, ReconBreakWire, ReviewWire } from "../api/schemas";
import { approvalInbox, approvalRow } from "./approvals";
import { validateElevationForm, elevationRow } from "./elevation";
import { breakRows, trialBalance } from "./finance";
import { EXPECTED_KILL_SWITCHES, flagBoard } from "./flags";
import { reviewQueue, sellerQueue } from "./kyc";
import { navAllowsPath, navFor } from "./nav";
import { validatePiiRequest, revealExpired } from "./pii";
import { evaluatePosture } from "./posture";
import { breachRegister, dsarQueueRows, nextBreachStep } from "./privacy";
import { moderationRows, priceMonitor, promotionRows } from "./queues";
import { previousCairoDate, reconciliationView, submissionBoard } from "./tax";
import { errorState } from "./common";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const iso = (ms: number): string => new Date(ms).toISOString();

const approval = (o: Partial<ApprovalWire> = {}): ApprovalWire => ({
  id: "33333333-3333-4333-8333-333333333333",
  kind: "refund", subject_type: "refund", subject_id: "r1", amount_minor: "700000", currency: "EGP",
  reason_code: "customer_support_ticket", requester_id: U1, state: "REQUESTED", approver_id: null,
  requested_at: iso(NOW - 1000), expires_at: iso(NOW + 60_000), decided_at: null, ...o,
});

describe("approvals", () => {
  it("requester cannot approve even with the approver role", () => {
    const row = approvalRow(approval(), { nowMs: NOW, selfId: U1, selfRoles: ["finance"] });
    expect(row.canApprove).toBe(false);
    expect(row.blocked).toBe("self_approval");
    expect(row.requestedByMe).toBe(true);
  });
  it("a scoped second person can approve; an unscoped one cannot", () => {
    expect(approvalRow(approval(), { nowMs: NOW, selfId: U2, selfRoles: ["finance"] }).canApprove).toBe(true);
    const r = approvalRow(approval(), { nowMs: NOW, selfId: U2, selfRoles: ["marketing"] });
    expect(r.canApprove).toBe(false);
    expect(r.blocked).toBe("approver_scope_missing");
  });
  it("shows the exact covers binding and expiry beats approval at the boundary", () => {
    const row = approvalRow(approval({ expires_at: iso(NOW) }), { nowMs: NOW, selfId: U2, selfRoles: ["finance"] });
    expect(row.effectiveState).toBe("EXPIRED");
    expect(row.canApprove).toBe(false);
    expect(row.covers).toEqual({ kind: "refund", subjectType: "refund", subjectId: "r1", amountMinor: 700000n });
  });
  it("approved rows report whether they still cover", () => {
    const ok = approvalRow(approval({ state: "APPROVED", approver_id: U2 }), { nowMs: NOW, selfId: U2, selfRoles: [] });
    expect(ok.coversNow).toBe(true);
    const old = approvalRow(approval({ state: "APPROVED", approver_id: U2, expires_at: iso(NOW - 1) }), { nowMs: NOW, selfId: U2, selfRoles: [] });
    expect(old.coversNow).toBe(false);
  });
  it("inbox buckets and orders by expiry", () => {
    const items = [
      approval({ id: "a1", expires_at: iso(NOW + 5000) }),
      approval({ id: "a2", expires_at: iso(NOW + 1000) }),
      approval({ id: "a3", requester_id: U2 }),
      approval({ id: "a4", state: "REJECTED" }),
    ];
    const inbox = approvalInbox(items, { nowMs: NOW, selfId: U2, selfRoles: ["finance"] });
    expect(inbox.actionable.map((r) => r.id)).toEqual(["a2", "a1"]);
    expect(inbox.waiting.map((r) => r.id)).toEqual(["a3"]);
    expect(inbox.decided.map((r) => r.id)).toEqual(["a4"]);
  });
  it("property: canApprove implies not requester and scoped", () => {
    fc.assert(
      fc.property(fc.constantFrom(...admin.APPROVAL_KINDS), fc.subarray([...admin.ADMIN_ROLE_NAMES]), fc.boolean(), (kind, roles, same) => {
        const r = approvalRow(approval({ kind }), { nowMs: NOW, selfId: same ? U1 : U2, selfRoles: roles });
        const scoped = roles.some((x) => admin.APPROVER_ROLES[kind].includes(x));
        expect(r.canApprove).toBe(!same && scoped);
      }),
    );
  });
});

describe("elevation", () => {
  it("requires an enumerated reason code and a bounded ttl", () => {
    const bad = validateElevationForm({ role: "finance", reasonCode: "because", ttlMinutes: "" }, ["support"]);
    expect(bad.ok).toBe(false);
    const ttl = validateElevationForm({ role: "finance", reasonCode: "incident_response", ttlMinutes: "999" }, ["support"]);
    expect(ttl.ok).toBe(false);
    const good = validateElevationForm({ role: "finance", reasonCode: "incident_response", ttlMinutes: "30" }, ["support"]);
    expect(good).toEqual({ ok: true, request: { role: "finance", reason_code: "incident_response", ttl_minutes: 30 } });
  });
  it("break-glass needs a standing super_admin and a 30 minute cap", () => {
    const f = { role: "super_admin", reasonCode: "break_glass_emergency", ttlMinutes: "" };
    expect(validateElevationForm(f, ["ops"]).ok).toBe(false);
    expect(validateElevationForm(f, ["super_admin"]).ok).toBe(true);
    expect(validateElevationForm({ ...f, ttlMinutes: "31" }, ["super_admin"]).ok).toBe(false);
  });
  it("live state uses the server clock", () => {
    const e = { id: U1, user_id: U1, role: "finance" as const, reason_code: "x", approval_id: U2, state: "ACTIVE" as const,
      requested_at: iso(NOW), activated_at: iso(NOW), expires_at: iso(NOW + 1000) };
    expect(elevationRow(e, U1, NOW).live).toBe(true);
    const lapsed = elevationRow(e, U1, NOW + 1000);
    expect(lapsed.live).toBe(false);
    expect(lapsed.lapsed).toBe(true);
    expect(lapsed.canRevoke).toBe(false);
  });
});

describe("kyc and suspension reviews", () => {
  const review = (o: Partial<ReviewWire>): ReviewWire => ({
    id: U1, seller_id: U2, state: "OPEN", reason_code: "fraud_investigation", suspended_at: iso(NOW - 86_400_000),
    due_at: iso(NOW + 86_400_000), overdue: false, automatic: false, reviewed_at: null, ...o,
  });
  it("orders overdue first, then soonest, closed last", () => {
    const rows = reviewQueue(
      [
        review({ id: "c", state: "UPHELD" }),
        review({ id: "b", due_at: iso(NOW + 5 * 86_400_000) }),
        review({ id: "a", due_at: iso(NOW - 1000) }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0]?.overdue).toBe(true);
    expect(rows[2]?.canDecide).toBe(false);
  });
  it("offers suspend only for APPROVED and reinstate only for SUSPENDED", () => {
    const s = (state: string, id: string) => ({ seller_id: id, kyc_state: state, store_count: 1, store_names: ["x"], updated_at: iso(NOW) });
    const rows = sellerQueue([s("APPROVED", U1), s("SUSPENDED", U2), s("SUBMITTED", "44444444-4444-4444-8444-444444444444")]);
    expect(rows.map((r) => r.state)).toEqual(["SUBMITTED", "SUSPENDED", "APPROVED"]);
    expect(rows[2]?.canSuspend).toBe(true);
    expect(rows[1]?.canReinstate).toBe(true);
    expect(rows[0]?.canSuspend).toBe(false);
  });
});

describe("flags", () => {
  const flag = (key: string, enabled: boolean): FlagWire => ({ key, kind: "kill_switch", description: key, enabled, is_default: true });
  it("expects exactly the registry's 14 kill switches", () => {
    expect([...EXPECTED_KILL_SWITCHES].sort()).toEqual(Object.keys(KILL_SWITCHES).sort());
    expect(EXPECTED_KILL_SWITCHES).toHaveLength(14);
  });
  it("lists unreported switches as missing and never hides them", () => {
    const b = flagBoard(EXPECTED_KILL_SWITCHES.slice(0, 12).map((k) => flag(k, k.endsWith("card"))));
    expect(b.missing).toHaveLength(2);
    expect(b.switches).toHaveLength(12);
    const card = b.switches.find((s) => s.key === "kill.payment.card");
    expect(card?.running).toBe(true);
    expect(card?.nextEnabled).toBe(false);
    expect(b.stoppedCount).toBe(11);
  });
});

describe("privacy", () => {
  const dsar = (id: string, due: number): DsarItemWire => ({
    id, type: "export", subject_ref: "subj_x", status: "received", received_at: iso(NOW - 1e9), due_at: iso(due),
    ms_remaining: 0, overdue: false, ready_target_at: null, ready_target_missed: false, cooling_ends_at: null, blockers: [],
  });
  it("puts overdue requests first using the server clock, not the stale flag", () => {
    const rows = dsarQueueRows([dsar("late", NOW + 1000), dsar("over", NOW - 5000), dsar("later", NOW + 9000)], NOW);
    expect(rows.map((r) => r.id)).toEqual(["over", "late", "later"]);
    expect(rows[0]?.overdue).toBe(true);
  });
  const clock = (due: number | null, status: BreachWire["clocks"]["pdpc"]["status"]) => ({ due_at: due === null ? null : iso(due), status, ms_remaining: null });
  const breach = (o: Partial<BreachWire>): BreachWire => ({
    id: U1, detected_at: iso(NOW - 3600_000), severity: "high", summary: "s", affected_count: 5, status: "open", dpo_decision: null,
    triaged_at: null, pdpc_notified_at: null, subjects_notified_at: null, closed_at: null,
    clocks: { triage: clock(NOW + 3600_000, "pending"), pdpc: clock(NOW + 71 * 3600_000, "pending"), subjects: clock(null, "pending") }, ...o,
  });
  it("walks the breach steps", () => {
    expect(nextBreachStep(breach({}))).toBe("triage");
    expect(nextBreachStep(breach({ triaged_at: iso(NOW), dpo_decision: "notify" }))).toBe("pdpc-notified");
    expect(nextBreachStep(breach({ triaged_at: iso(NOW), dpo_decision: "notify", pdpc_notified_at: iso(NOW) }))).toBe("subjects-notified");
    expect(nextBreachStep(breach({ triaged_at: iso(NOW), dpo_decision: "no_notification_required" }))).toBe("close");
    expect(nextBreachStep(breach({ closed_at: iso(NOW) }))).toBe("done");
  });
  it("orders by most urgent clock and flags overdue", () => {
    const urgent = breach({ id: "urgent", clocks: { triage: clock(NOW - 1, "overdue"), pdpc: clock(NOW + 5 * 3600_000, "pending"), subjects: clock(null, "pending") } });
    const calm = breach({ id: "calm" });
    const closed = breach({ id: "closed", closed_at: iso(NOW) });
    const rows = breachRegister([closed, calm, urgent], NOW);
    expect(rows.map((r) => r.id)).toEqual(["urgent", "calm", "closed"]);
    expect(rows[0]?.anyOverdue).toBe(true);
  });
});

describe("tax and finance", () => {
  const doc = (id: string, state: "DEAD_LETTER" | "ACCEPTED" | "QUEUED") => ({
    id, kind: "seller_einvoice" as const, source_ref: "r", issued_at: iso(NOW),
    totals: { net: { amount: "100", currency: "EGP" as const }, vat: { amount: "14", currency: "EGP" as const }, gross: { amount: "114", currency: "EGP" as const } },
    submission: { state, attempts: 5, max_attempts: 5, next_attempt_at: iso(NOW), last_submitted_at: null, last_error: null, eta_uuid: null, rejection_reasons: [], decided_at: null },
  });
  it("only dead letters can be requeued and they sort first", () => {
    const b = submissionBoard([doc("a", "ACCEPTED"), doc("b", "DEAD_LETTER"), doc("c", "QUEUED")]);
    expect(b.rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(b.deadLetters.map((r) => r.id)).toEqual(["b"]);
    expect(b.counts.DEAD_LETTER).toBe(1);
  });
  it("reconciliation is clean only when reconciled and no discrepancies", () => {
    const base = { date: "2026-10-10", documents: 3, counts: {}, gross_by_state: {}, submitted: 3, accepted: 3, rejected: 0, acceptance_rate_bps: 10000, discrepancies: [], reconciled: true };
    expect(reconciliationView(base).clean).toBe(true);
    expect(reconciliationView({ ...base, discrepancies: [{ internal_id: "x", kind: "missing" }] }).clean).toBe(false);
    expect(reconciliationView({ ...base, documents: 0 }).empty).toBe(true);
  });
  it("previous Cairo date crosses month boundaries", () => {
    expect(previousCairoDate(Date.parse("2026-11-01T10:00:00Z"))).toBe("2026-10-31");
    expect(previousCairoDate(Date.parse("2026-10-11T22:30:00Z"))).toBe("2026-10-11");
  });
  const bal = (raw: string, currency = "EGP"): LedgerBalanceWire => ({
    account: "a", type: "t", owner_type: "o", owner_id: "i", sub_key: null, currency, raw, balance: raw, posting_count: 1,
  });
  it("trial balance sums signed postings per currency and refuses to prove a truncated page", () => {
    expect(trialBalance([bal("500"), bal("-500")], 200)).toMatchObject({ balanced: true, complete: true });
    expect(trialBalance([bal("500"), bal("-499")], 200).balanced).toBe(false);
    expect(trialBalance([bal("500"), bal("-500")], 2).complete).toBe(false);
    expect(trialBalance([bal("5"), bal("-5", "USD")], 200).balanced).toBe(false);
  });
  it("property: any set of postings built to net zero balances", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: -1_000_000n, max: 1_000_000n }), { maxLength: 30 }), (xs) => {
        const items = [...xs, -xs.reduce((a, b) => a + b, 0n)].map((v) => bal(v.toString()));
        expect(trialBalance(items, 1000).balanced).toBe(true);
      }),
    );
  });
  it("escalates open breaks older than 3 days", () => {
    const b = (id: string, ageDays: number, status: ReconBreakWire["status"]): ReconBreakWire => ({
      id, kind: "psp_settlement", status, detected_at: iso(NOW - ageDays * 86_400_000),
      expected: { amount: "1000", currency: "EGP" }, actual: { amount: "900", currency: "EGP" },
    });
    const rows = breakRows([b("new", 1, "open"), b("old", 4, "open"), b("done", 9, "resolved")], NOW);
    expect(rows.map((r) => r.id)).toEqual(["old", "new", "done"]);
    expect(rows[0]?.escalate).toBe(true);
    expect(rows[0]?.differenceMinor).toBe(-100n);
    expect(rows[2]?.escalate).toBe(false);
  });
});

describe("queues", () => {
  it("price monitor surfaces overdue human reviews first", () => {
    const a = (id: string, due: string | null) => ({ id, store_id: U1, action: "suspend", reason_code: "x", applied_at: iso(NOW), human_review_due_at: due });
    const m = priceMonitor([a(U1, null), a(U2, iso(NOW + 1000)), a("44444444-4444-4444-8444-444444444444", iso(NOW - 1000))], NOW);
    expect(m.appeals.map((x) => x.reviewOverdue)).toEqual([true, false]);
    expect(m.log).toHaveLength(3);
  });
  it("moderation is oldest first", () => {
    const i = (id: string, at: number) => ({ target_type: "review" as const, target_id: id, status: "HELD", hold_reason: null, text: "t", photo_ids: [], product_id: null, store_id: null, created_at: iso(at) });
    expect(moderationRows([i(U1, NOW), i(U2, NOW - 5)]).map((r) => r.targetId)).toEqual([U2, U1]);
  });
  it("flags promotion funding that does not total 100", () => {
    const p = (id: string, pl: number, se: number) => ({ id, type: "percent", title: { ar: "x" }, funding: { platform_pct: pl, seller_pct: se }, starts_at: iso(NOW), ends_at: iso(NOW), status: "active" as const, version: 1 });
    const rows = promotionRows([p(U1, 60, 40), p(U2, 60, 30)]);
    expect(rows.map((r) => r.fundingOk)).toEqual([true, false]);
  });
});

describe("rbac nav, posture, pii, errors", () => {
  it("hides links the role cannot use and fails closed on unknown identity", () => {
    expect(navFor(["dpo"]).map((i) => i.id)).toEqual(["home", "approvals", "elevation", "privacy", "pii"]);
    expect(navFor(["marketing"]).map((i) => i.id)).not.toContain("finance");
    // not_admin, 5xx and malformed identity all reach the nav as null/unrecognised roles: nothing privileged.
    expect(navFor(null)).toEqual([]);
    expect(navFor([])).toEqual([]);
    expect(navFor(["bogus"] as unknown as Parameters<typeof navFor>[0])).toEqual([]);
    expect(navFor(["super_admin"]).map((i) => i.id)).not.toContain("finance");
    expect(navAllowsPath(null, "/")).toBe(false);
    expect(navAllowsPath(null, "/finance")).toBe(false);
    expect(navAllowsPath([], "/finance")).toBe(false);
    expect(navAllowsPath(["support"], "/finance")).toBe(false);
    expect(navAllowsPath(["finance"], "/finance")).toBe(true);
  });
  const me = (o: Partial<AdminMe> & { posture?: AdminMe["posture"] } = {}): AdminMe => ({
    user_id: U1, roles: ["support"], standing_roles: ["support"], assurance: "passkey", posture: { ip_allowlisted: false, device_trusted: true }, ...o,
  });
  it("posture fails closed, and requires the IP allow-list for finance and super admin", () => {
    expect(evaluatePosture(null).sensitiveWritesEnabled).toBe(false);
    expect(evaluatePosture(me()).sensitiveWritesEnabled).toBe(true);
    expect(evaluatePosture(me({ roles: ["finance"] })).level).toBe("ip_not_allowlisted");
    expect(evaluatePosture(me({ roles: ["finance"], posture: { ip_allowlisted: true, device_trusted: true } })).sensitiveWritesEnabled).toBe(true);
    expect(evaluatePosture(me({ posture: { ip_allowlisted: true, device_trusted: false } })).level).toBe("device_untrusted");
    expect(evaluatePosture(me({ assurance: "otp" })).sensitiveWritesEnabled).toBe(false);
  });
  it("a PII request needs subject, known fields and an enumerated reason", () => {
    const ok = validatePiiRequest({ subjectUserId: U1, fields: ["phone"], reasonCode: "customer_support_ticket" });
    expect(ok.ok).toBe(true);
    const none = validatePiiRequest({ subjectUserId: "nope", fields: [], reasonCode: "" });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors.map((e) => e.field).sort()).toEqual(["fields", "reason", "subject"]);
    expect(validatePiiRequest({ subjectUserId: U1, fields: ["ssn"], reasonCode: "kyc_review" }).ok).toBe(false);
    expect(validatePiiRequest({ subjectUserId: U1, fields: ["phone"], reasonCode: "free text" }).ok).toBe(false);
    expect(revealExpired(NOW, NOW + 59_999)).toBe(false);
    expect(revealExpired(NOW, NOW + 60_000)).toBe(true);
  });
  it("maps api errors to honest states", () => {
    expect(errorState({ kind: "forbidden" })).toMatchObject({ kind: "error", messageKey: "state.forbidden" });
    expect(errorState({ kind: "contract", requestId: "r1" })).toMatchObject({ messageKey: "state.contract", requestId: "r1" });
  });
});

describe("reconciliation tickets as break rows (ADR-0050 repoint)", () => {
  it("maps a served ticket to a break row, with the delta as the difference", async () => {
    const { reconTicketList } = await import("../api/schemas");
    const parsed = reconTicketList.parse({
      items: [{ id: "0192f3a4-5b6c-7d8e-9f01-000000000001", source: "psp_settlement", kind: "amount_mismatch", severity: "high", status: "escalated", ref: "S-1", detail: "x", amount_delta: { amount: "-250", currency: "EGP" }, item_at: iso(NOW), first_seen_at: iso(NOW - 4 * 86_400_000), last_seen_at: iso(NOW), escalated_at: iso(NOW), resolved_at: null, last_run_id: null }],
      page: { next_cursor: null, has_more: false },
    });
    const rows = breakRows(parsed.items, NOW);
    expect(rows[0]).toMatchObject({ kind: "psp_settlement:amount_mismatch", status: "escalated", reference: "S-1", differenceMinor: -250n, open: true, escalate: true });
  });
});
