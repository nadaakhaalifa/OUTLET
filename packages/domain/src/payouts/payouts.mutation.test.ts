// Targeted tests for payout eligibility, netting, statements, cycles, approval lookup and lifecycle glue.
// Written to kill Stryker survivors (ADR-0019): exact values, exact boundaries, exact messages.
import { describe, expect, it } from "vitest";
import type { ApprovalRecord } from "../admin/approval";
import {
  DEFAULT_CYCLE_CONFIG,
  DEFAULT_MINIMUM_PAYOUT_MINOR,
  HOLD_REASONS,
  InvalidPayoutInputError,
  LINE_HOLDING_STATES,
  MS_PER_DAY,
  PAYOUT_HOLD_AFTER_CLOSE_MS,
  approvalRequirementMet,
  buildStatement,
  canPayoutEvent,
  eventForOutcome,
  ineligibleReason,
  latestCycle,
  ledgerPayoutRef,
  nextCycleRun,
  payoutApprovalStatus,
  planPayout,
  releasesLines,
  applyPayoutEvent,
  type Clawback,
  type PayableItem,
  type StatementFact,
} from "./index";

const CUTOFF = Date.UTC(2026, 0, 18, 8, 0, 0);
const item = (id: string, net: bigint, over: Partial<PayableItem> = {}): PayableItem => ({
  sellerOrderId: id,
  storeId: "s1",
  net,
  status: "CLOSED",
  closedAtMs: CUTOFF - PAYOUT_HOLD_AFTER_CLOSE_MS - 1,
  openDispute: false,
  ...over,
});
const claw = (id: string, amount: bigint, createdAtMs = 1, storeId = "s1"): Clawback => ({ id, storeId, amount, kind: "other", createdAtMs });
const plan = (items: PayableItem[], clawbacks: Clawback[] = [], over: { minimumPayoutMinor?: bigint } = {}) =>
  planPayout({ storeId: "s1", items, clawbacks, cutoffMs: CUTOFF, ...over });

describe("constants", () => {
  it("hold window is exactly 3 days; default minimum is 100 EGP", () => {
    expect(PAYOUT_HOLD_AFTER_CLOSE_MS).toBe(3 * 86_400_000);
    expect(MS_PER_DAY).toBe(86_400_000);
    expect(DEFAULT_MINIMUM_PAYOUT_MINOR).toBe(10_000n);
  });
});

describe("ineligibleReason", () => {
  it("rule order and boundaries", () => {
    expect(ineligibleReason(item("a", 5n), "s1", CUTOFF)).toBeNull();
    expect(ineligibleReason(item("a", 5n, { storeId: "s2", status: "PAID" }), "s1", CUTOFF)).toBe("wrong_store");
    expect(ineligibleReason(item("a", 5n, { status: "DELIVERED" }), "s1", CUTOFF)).toBe("not_closed");
    expect(ineligibleReason(item("a", 5n, { closedAtMs: null }), "s1", CUTOFF)).toBe("not_closed");
    expect(ineligibleReason(item("a", 5n, { status: "DELIVERED", closedAtMs: null }), "s1", CUTOFF)).toBe("not_closed");
    expect(ineligibleReason(item("a", 5n, { closedAtMs: CUTOFF - PAYOUT_HOLD_AFTER_CLOSE_MS }), "s1", CUTOFF)).toBeNull();
    expect(ineligibleReason(item("a", 5n, { closedAtMs: CUTOFF - PAYOUT_HOLD_AFTER_CLOSE_MS + 1 }), "s1", CUTOFF)).toBe("hold_window");
    expect(ineligibleReason(item("a", 5n, { closedAtMs: CUTOFF - PAYOUT_HOLD_AFTER_CLOSE_MS + 1, openDispute: true }), "s1", CUTOFF)).toBe("hold_window");
    expect(ineligibleReason(item("a", 0n, { openDispute: true }), "s1", CUTOFF)).toBe("open_dispute");
    expect(ineligibleReason(item("a", 0n), "s1", CUTOFF)).toBe("non_positive");
    expect(ineligibleReason(item("a", -1n), "s1", CUTOFF)).toBe("non_positive");
    expect(ineligibleReason(item("a", 1n), "s1", CUTOFF)).toBeNull();
  });
});

describe("planPayout input validation", () => {
  it("messages", () => {
    expect(() => plan([], [], { minimumPayoutMinor: -1n })).toThrow("minimum payout must not be negative");
    expect(() => plan([], [], { minimumPayoutMinor: 0n })).not.toThrow();
    expect(() => plan([item("a", 5n), item("a", 6n)])).toThrow("duplicate seller order a");
    expect(() => plan([], [claw("c", 0n)])).toThrow("a clawback amount must be positive");
    expect(() => plan([], [claw("c", -5n)])).toThrow("a clawback amount must be positive");
    expect(() => plan([], [claw("c", 5n), claw("c", 6n)])).toThrow("duplicate clawback c");
    expect(() => plan([], [claw("c", 5n)])).not.toThrow();
  });
});

describe("planPayout netting", () => {
  it("nothing eligible carries every own clawback forward and ignores other stores'", () => {
    const p = plan([item("a", 500n, { openDispute: true })], [claw("c1", 70n), claw("c2", 30n), claw("x", 999n, 1, "s2")]);
    expect(p).toEqual({
      storeId: "s1",
      cutoffMs: CUTOFF,
      eligible: [],
      ineligible: [{ item: item("a", 500n, { openDispute: true }), reason: "open_dispute" }],
      eligibleTotal: 0n,
      applied: [],
      nettedTotal: 0n,
      carryForward: 100n,
      payout: 0n,
      payable: false,
      skip: "nothing_eligible",
    });
  });
  it("pays eligible minus clawbacks, in clawback order, applying partially when short", () => {
    const items = [item("b", 20_000n, { closedAtMs: CUTOFF - 5 * MS_PER_DAY }), item("a", 30_000n, { closedAtMs: CUTOFF - 6 * MS_PER_DAY })];
    const p = plan(items, [claw("c2", 10_000n, 20), claw("c1", 5_000n, 10)]);
    expect(p.eligible.map((i) => i.sellerOrderId)).toEqual(["a", "b"]);
    expect(p.applied).toEqual([
      { clawbackId: "c1", applied: 5_000n, remaining: 0n },
      { clawbackId: "c2", applied: 10_000n, remaining: 0n },
    ]);
    expect(p).toMatchObject({ eligibleTotal: 50_000n, nettedTotal: 15_000n, carryForward: 0n, payout: 35_000n, payable: true, skip: null });
  });
  it("a clawback bigger than the balance leaves nothing to pay: the plan applies nothing and carries it all", () => {
    const p = plan([item("a", 20_000n)], [claw("c1", 15_000n, 1), claw("c2", 9_000n, 2)]);
    expect(p).toMatchObject({
      applied: [],
      nettedTotal: 0n,
      carryForward: 24_000n,
      payout: 0n,
      payable: false,
      skip: "below_minimum",
      eligibleTotal: 20_000n,
      eligible: [],
    });
  });
  it("a payable plan applies every clawback in full", () => {
    const q = plan([item("a", 30_000n)], [claw("c1", 10_000n, 1), claw("c2", 5_000n, 2)]);
    expect(q.applied).toEqual([
      { clawbackId: "c1", applied: 10_000n, remaining: 0n },
      { clawbackId: "c2", applied: 5_000n, remaining: 0n },
    ]);
    expect(q).toMatchObject({ nettedTotal: 15_000n, carryForward: 0n, payout: 15_000n, payable: true });
    const r = plan([item("a", 30_000n)], [claw("c1", 40_000n, 1)], { minimumPayoutMinor: 0n });
    expect(r).toMatchObject({ payable: false, applied: [], carryForward: 40_000n });
  });
  it("minimum payout boundary", () => {
    const at = plan([item("a", 10_000n)]);
    expect(at).toMatchObject({ payable: true, payout: 10_000n });
    const below = plan([item("a", 9_999n)]);
    expect(below).toMatchObject({ payable: false, skip: "below_minimum", payout: 0n, eligible: [], eligibleTotal: 9_999n });
    expect(plan([item("a", 1n)], [], { minimumPayoutMinor: 0n })).toMatchObject({ payable: true, payout: 1n });
    expect(plan([item("a", 100n)], [claw("c", 100n)], { minimumPayoutMinor: 0n })).toMatchObject({ payable: false, skip: "below_minimum", payout: 0n });
    expect(plan([item("a", 100n)], [claw("c", 100n)], { minimumPayoutMinor: 0n }).carryForward).toBe(100n);
  });
  it("equal close times order by seller order id; equal clawback times by id", () => {
    const same = CUTOFF - 5 * MS_PER_DAY;
    const p = plan([item("z", 6_000n, { closedAtMs: same }), item("a", 6_000n, { closedAtMs: same }), item("m", 6_000n, { closedAtMs: same })]);
    expect(p.eligible.map((i) => i.sellerOrderId)).toEqual(["a", "m", "z"]);
    const q = plan([item("a", 100_000n)], [claw("c9", 10n, 5), claw("c1", 10n, 5), claw("c5", 10n, 5)]);
    expect(q.applied.map((a) => a.clawbackId)).toEqual(["c1", "c5", "c9"]);
    const r = plan([item("a", 100_000n)], [claw("c9", 10n, 1), claw("c1", 10n, 2)]);
    expect(r.applied.map((a) => a.clawbackId)).toEqual(["c9", "c1"]);
  });
  it("ineligible items are listed with reasons, in the same sorted order", () => {
    const p = plan([
      item("b", 5n, { status: "PAID" }),
      item("a", 5n, { storeId: "s2" }),
      item("c", 20_000n),
    ]);
    expect(p.ineligible.map((x) => [x.item.sellerOrderId, x.reason])).toEqual([
      ["a", "wrong_store"],
      ["b", "not_closed"],
    ]);
  });
});

describe("buildStatement", () => {
  const T0 = Date.UTC(2026, 0, 1);
  const order = (id: string, atMs: number, merchandise = 10_000n, storeId = "s1"): StatementFact => ({
    type: "order",
    id,
    storeId,
    atMs,
    merchandise,
    commissionBps: 1_500n,
    vatBps: 1_400n,
  });
  const refund = (id: string, atMs: number, goodsRefunded: bigint, goodsRefundedBefore: bigint): StatementFact => ({
    type: "refund",
    id,
    storeId: "s1",
    atMs,
    goodsRefunded,
    goodsRefundedBefore,
    commissionBps: 1_500n,
    vatBps: 1_400n,
  });
  const adj = (type: "promo_netting" | "payout" | "payout_reversal" | "clawback", id: string, atMs: number, amount: bigint): StatementFact => ({
    type,
    id,
    storeId: "s1",
    atMs,
    amount,
  });
  const run = (facts: StatementFact[], fromMs = T0, toMs = T0 + 10 * MS_PER_DAY) => buildStatement({ storeId: "s1", fromMs, toMs, facts });

  it("an order and its refunds net to zero, with exact per-line figures", () => {
    const s = run([order("o1", T0 + 1), refund("r1", T0 + 2, 4_000n, 0n), refund("r2", T0 + 3, 6_000n, 4_000n)]);
    expect(s.lines.map((l) => [l.type, l.merchandise, l.commission, l.vatOnCommission, l.net, l.balanceAfter])).toEqual([
      ["order", 10_000n, 1_500n, 210n, 8_290n, 8_290n],
      ["refund", -4_000n, -600n, -84n, -3_316n, 4_974n],
      ["refund", -6_000n, -900n, -126n, -4_974n, 0n],
    ]);
    expect(s.totals).toEqual({ merchandise: 0n, commission: 0n, vatOnCommission: 0n, adjustments: 0n, payouts: 0n, net: 0n });
    expect(s.closing).toBe(0n);
    expect(s.opening).toBe(0n);
  });
  it("adjustments subtract, reversals add, payouts are tracked apart", () => {
    const s = run([
      order("o1", T0 + 1),
      adj("promo_netting", "p1", T0 + 2, 100n),
      adj("clawback", "c1", T0 + 3, 200n),
      adj("payout", "pay1", T0 + 4, 3_000n),
      adj("payout_reversal", "rev1", T0 + 5, 500n),
    ]);
    expect(s.totals).toEqual({
      merchandise: 10_000n,
      commission: 1_500n,
      vatOnCommission: 210n,
      adjustments: -300n,
      payouts: -2_500n,
      net: 8_290n - 100n - 200n - 3_000n + 500n,
    });
    expect(s.lines.map((l) => l.adjustment)).toEqual([0n, -100n, -200n, -3_000n, 500n]);
    expect(s.closing).toBe(8_290n - 100n - 200n - 3_000n + 500n);
  });
  it("opening balance is everything before the period; the period is half-open", () => {
    const s = run([order("before", T0 - 1), order("at-from", T0), order("last", T0 + 10 * MS_PER_DAY - 1), order("at-to", T0 + 10 * MS_PER_DAY)]);
    expect(s.opening).toBe(8_290n);
    expect(s.lines.map((l) => l.id)).toEqual(["at-from", "last"]);
    expect(s.closing).toBe(8_290n * 3n);
    expect(s.lines[0]?.balanceAfter).toBe(16_580n);
  });
  it("other stores' facts are ignored", () => {
    expect(run([order("o1", T0 + 1, 10_000n, "s2")]).lines).toEqual([]);
  });
  it("same-instant lines sort by type then id", () => {
    const at = T0 + 5;
    const s = run([
      adj("payout_reversal", "a", at, 1n),
      adj("payout", "a", at, 1n),
      adj("clawback", "a", at, 1n),
      adj("promo_netting", "a", at, 1n),
      refund("a", at, 100n, 0n),
      order("z", at),
      order("a", at),
    ]);
    expect(s.lines.map((l) => `${l.type}:${l.id}`)).toEqual([
      "order:a",
      "order:z",
      "refund:a",
      "promo_netting:a",
      "clawback:a",
      "payout:a",
      "payout_reversal:a",
    ]);
    const byTime = run([order("late", at + 1), order("early", at)]);
    expect(byTime.lines.map((l) => l.id)).toEqual(["early", "late"]);
  });
  it("rejects bad facts with their messages", () => {
    expect(() => run([order("o", T0 + 1, 0n)])).toThrow("order merchandise must be positive");
    expect(() => run([order("o", T0 + 1, -5n)])).toThrow("order merchandise must be positive");
    expect(() => run([refund("r", T0 + 1, 0n, 0n)])).toThrow("refund amounts out of range");
    expect(() => run([refund("r", T0 + 1, -1n, 0n)])).toThrow("refund amounts out of range");
    expect(() => run([refund("r", T0 + 1, 5n, -1n)])).toThrow("refund amounts out of range");
    expect(() => run([refund("r", T0 + 1, 5n, 0n)])).not.toThrow();
    for (const t of ["promo_netting", "payout", "clawback", "payout_reversal"] as const) {
      expect(() => run([adj(t, "x", T0 + 1, 0n)]), t).toThrow("amount must be positive");
      expect(() => run([adj(t, "x", T0 + 1, -1n)]), t).toThrow("amount must be positive");
      expect(() => run([adj(t, "x", T0 + 1, 1n)]), t).not.toThrow();
    }
    expect(() => run([order("o", T0 + 1), order("o", T0 + 2)])).toThrow("duplicate statement fact order:o");
    expect(() => run([order("o", T0 + 1), refund("o", T0 + 2, 1n, 0n)])).not.toThrow();
    expect(() => run([], T0, T0)).toThrow("statement period must be non-empty");
    expect(() => run([], T0 + 1, T0)).toThrow("statement period must be non-empty");
    expect(() => run([], T0, T0 + 1)).not.toThrow(InvalidPayoutInputError);
  });
  it("echoes the period and store", () => {
    const s = run([], T0, T0 + 5);
    expect(s).toMatchObject({ storeId: "s1", fromMs: T0, toMs: T0 + 5, opening: 0n, closing: 0n, lines: [] });
  });
});

describe("payout approval lookup", () => {
  const rec = (id: string, over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
    id,
    kind: "payout",
    subjectType: "payout",
    subjectId: "p1",
    amountMinor: 6_000_000n,
    reasonCode: "weekly",
    requesterId: "fin1",
    state: "APPROVED",
    approverId: "fin2",
    requestedAtMs: 0,
    expiresAtMs: 1_000,
    decidedAtMs: 10,
    decisionNote: null,
    ...over,
  });
  const st = (records: ApprovalRecord[]) => payoutApprovalStatus({ payoutId: "p1", amountMinor: 6_000_000n, records, nowMs: 5 });
  it("picks the lowest-id covering record regardless of input order", () => {
    expect(st([rec("b"), rec("a"), rec("c")])).toEqual({ kind: "covered", approvalId: "a" });
    expect(st([rec("a", { subjectId: "other" }), rec("b")])).toEqual({ kind: "covered", approvalId: "b" });
    expect(st([rec("c"), rec("b", { state: "REQUESTED" })])).toEqual({ kind: "covered", approvalId: "c" });
  });
  it("status kinds and the met predicate", () => {
    expect(st([])).toEqual({ kind: "missing" });
    expect(st([rec("a", { state: "REJECTED" })])).toEqual({ kind: "not_covering" });
    expect(payoutApprovalStatus({ payoutId: "p1", amountMinor: 1n, records: [], nowMs: 5 })).toEqual({ kind: "not_required" });
    expect(approvalRequirementMet({ kind: "not_required" })).toBe(true);
    expect(approvalRequirementMet({ kind: "covered", approvalId: "a" })).toBe(true);
    expect(approvalRequirementMet({ kind: "missing" })).toBe(false);
    expect(approvalRequirementMet({ kind: "not_covering" })).toBe(false);
  });
});

describe("weekly cycle (Africa/Cairo)", () => {
  // Sunday 2026-01-04 10:00 Cairo (UTC+2) is 08:00Z.
  const run = Date.UTC(2026, 0, 4, 8, 0, 0);
  it("the cycle starts exactly at the run time; one ms earlier belongs to the previous week", () => {
    expect(latestCycle(run)).toEqual({ key: "2026-01-04", runAtMs: run, cutoffMs: run });
    const prev = latestCycle(run - 1);
    expect(prev.key).toBe("2025-12-28");
    expect(prev.runAtMs).toBe(run - 7 * MS_PER_DAY);
    expect(latestCycle(run + 3 * MS_PER_DAY).key).toBe("2026-01-04");
  });
  it("next run is strictly after now", () => {
    expect(nextCycleRun(run)).toBe(run + 7 * MS_PER_DAY);
    expect(nextCycleRun(run - 1)).toBe(run);
    expect(nextCycleRun(run + 1)).toBe(run + 7 * MS_PER_DAY);
  });
  it("custom weekday and hour", () => {
    // Wednesday 2026-01-07 00:00 Cairo is 2026-01-06T22:00Z.
    const wed = Date.UTC(2026, 0, 6, 22, 0, 0);
    expect(latestCycle(wed, { weekday: 3, hour: 0 })).toEqual({ key: "2026-01-07", runAtMs: wed, cutoffMs: wed });
    expect(nextCycleRun(wed - 1, { weekday: 3, hour: 0 })).toBe(wed);
    expect(DEFAULT_CYCLE_CONFIG).toEqual({ weekday: 0, hour: 10 });
  });
  it("config is validated by both entry points, with the field name", () => {
    expect(() => latestCycle(run, { weekday: 7, hour: 10 })).toThrow("weekday must be an integer between 0 and 6");
    expect(() => latestCycle(run, { weekday: -1, hour: 10 })).toThrow("weekday must be an integer between 0 and 6");
    expect(() => latestCycle(run, { weekday: 1.5, hour: 10 })).toThrow("weekday must be an integer between 0 and 6");
    expect(() => latestCycle(run, { weekday: 0, hour: 24 })).toThrow("hour must be an integer between 0 and 23");
    expect(() => nextCycleRun(run, { weekday: 7, hour: 10 })).toThrow("weekday must be an integer between 0 and 6");
    expect(() => nextCycleRun(run, { weekday: 0, hour: -1 })).toThrow("hour must be an integer between 0 and 23");
    expect(() => latestCycle(run, { weekday: 6, hour: 23 })).not.toThrow();
    expect(() => latestCycle(run, { weekday: 0, hour: 0 })).not.toThrow();
  });
});

describe("lifecycle glue", () => {
  it("constants", () => {
    expect([...HOLD_REASONS]).toEqual([
      "no_bank_details",
      "iban_name_mismatch",
      "name_check_unavailable",
      "risk_review",
      "exceeds_ledger_balance",
      "open_dispute",
      "manual_hold",
    ]);
    expect([...LINE_HOLDING_STATES]).toEqual(["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED"]);
  });
  it("only a cancelled payout releases its lines", () => {
    expect(releasesLines("CANCELLED")).toBe(true);
    for (const s of ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED"] as const) expect(releasesLines(s)).toBe(false);
  });
  it("provider outcomes map to events; accepted and unavailable do nothing", () => {
    expect(eventForOutcome("settled")).toBe("BANK_CONFIRMED");
    expect(eventForOutcome("rejected")).toBe("BANK_REJECTED");
    expect(eventForOutcome("accepted")).toBeNull();
    expect(eventForOutcome("unavailable")).toBeNull();
  });
  it("ledger reference per attempt", () => {
    expect(ledgerPayoutRef("p1", 1)).toBe("p1~1");
    expect(ledgerPayoutRef("p1", 12)).toBe("p1~12");
  });
  it("machine glue honours guards", () => {
    const ok = { approvalRequirementMet: true, noOpenDispute: true, ibanNameMatched: true };
    expect(canPayoutEvent("SCHEDULED", "APPROVE", ok)).toBe(true);
    expect(canPayoutEvent("SCHEDULED", "APPROVE", { ...ok, noOpenDispute: false })).toBe(false);
    expect(canPayoutEvent("SCHEDULED", "SEND", ok)).toBe(false);
    expect(applyPayoutEvent("SCHEDULED", "APPROVE", ok)).toBe("APPROVED");
    expect(applyPayoutEvent("SENT", "BANK_CONFIRMED", ok)).toBe("SETTLED");
    expect(() => applyPayoutEvent("SETTLED", "CANCEL", ok)).toThrow();
  });
});
