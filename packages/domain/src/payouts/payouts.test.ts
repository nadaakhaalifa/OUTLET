import { describe, expect, it } from "vitest";
import type { ApprovalRecord } from "../admin/approval";
import { commissionOf, commissionVatOf } from "../chart-of-accounts/builders";
import { money } from "../money";
import { payoutMachine } from "../state-machine/machines/payout";
import {
  DEFAULT_MINIMUM_PAYOUT_MINOR,
  MS_PER_DAY,
  PAYOUT_HOLD_AFTER_CLOSE_MS,
  applyPayoutEvent,
  approvalRequirementMet,
  assertEgyptIban,
  buildStatement,
  cairoDateKey,
  eventForOutcome,
  ibanLast4,
  isValidEgyptIban,
  latestCycle,
  ledgerPayoutRef,
  namesMatch,
  nextCycleRun,
  normalizeLegalName,
  payoutApprovalStatus,
  planPayout,
  type Clawback,
  type PayableItem,
} from "./index";

const CUTOFF = Date.UTC(2026, 9, 18, 8, 0, 0);
const item = (id: string, net: bigint, over: Partial<PayableItem> = {}): PayableItem => ({
  sellerOrderId: id,
  storeId: "s1",
  net,
  status: "CLOSED",
  closedAtMs: CUTOFF - PAYOUT_HOLD_AFTER_CLOSE_MS - 1,
  openDispute: false,
  ...over,
});
const claw = (id: string, amount: bigint, createdAtMs = 1): Clawback => ({
  id,
  storeId: "s1",
  amount,
  kind: "refund_after_payout",
  createdAtMs,
});

describe("cycle (Africa/Cairo weekly)", () => {
  it("runs on Sunday 10:00 Cairo and keys by the Cairo civil date", () => {
    // 2026-10-11 is a Sunday. Cairo is UTC+3 in October 2026 (DST), so 10:00 local = 07:00 UTC.
    const c = latestCycle(Date.UTC(2026, 9, 14, 12, 0, 0));
    expect(c.key).toBe("2026-10-11");
    expect(c.runAtMs).toBe(Date.UTC(2026, 9, 11, 7, 0, 0));
    expect(c.cutoffMs).toBe(c.runAtMs);
    expect(cairoDateKey(c.runAtMs)).toBe("2026-10-11");
  });

  it("is inclusive at the run instant and exclusive just before", () => {
    const run = Date.UTC(2026, 9, 11, 7, 0, 0);
    expect(latestCycle(run).key).toBe("2026-10-11");
    expect(latestCycle(run - 1).key).toBe("2026-10-04");
  });

  it("uses winter time after the late-October DST end", () => {
    // Egypt DST ends the last Thursday of October. 2026-11-01 is a Sunday: UTC+2, 10:00 = 08:00 UTC.
    expect(latestCycle(Date.UTC(2026, 10, 1, 12, 0, 0)).runAtMs).toBe(Date.UTC(2026, 10, 1, 8, 0, 0));
  });

  it("finds the next run strictly after now", () => {
    const run = Date.UTC(2026, 9, 11, 7, 0, 0);
    expect(nextCycleRun(run)).toBe(Date.UTC(2026, 9, 18, 7, 0, 0));
    expect(nextCycleRun(run - 1)).toBe(run);
  });

  it("rejects an impossible configuration", () => {
    expect(() => latestCycle(0, { weekday: 7, hour: 10 })).toThrow();
    expect(() => nextCycleRun(0, { weekday: 1, hour: 24 })).toThrow();
  });
});

describe("planPayout eligibility", () => {
  it("pays only closed items past the 3 day buffer with no dispute", () => {
    const plan = planPayout({
      storeId: "s1",
      cutoffMs: CUTOFF,
      clawbacks: [],
      items: [
        item("ok", 50_000n),
        item("fresh", 40_000n, { closedAtMs: CUTOFF - PAYOUT_HOLD_AFTER_CLOSE_MS + 1 }),
        item("edge", 30_000n, { closedAtMs: CUTOFF - PAYOUT_HOLD_AFTER_CLOSE_MS }),
        item("open", 20_000n, { status: "DELIVERED", closedAtMs: null }),
        item("disp", 10_000n, { openDispute: true }),
        item("zero", 0n),
        item("other", 99_000n, { storeId: "s2" }),
      ],
    });
    expect(plan.eligible.map((i) => i.sellerOrderId)).toEqual(["ok", "edge"]);
    expect(plan.ineligible.map((x) => [x.item.sellerOrderId, x.reason]).sort()).toEqual(
      [
        ["fresh", "hold_window"],
        ["open", "not_closed"],
        ["disp", "open_dispute"],
        ["zero", "non_positive"],
        ["other", "wrong_store"],
      ].sort(),
    );
    expect(plan.payout).toBe(80_000n);
    expect(plan.payable).toBe(true);
  });

  it("nets a refund after payout from the next payout and carries the remainder", () => {
    const plan = planPayout({
      storeId: "s1",
      cutoffMs: CUTOFF,
      items: [item("a", 10_000n)],
      clawbacks: [claw("c1", 3_000n, 1), claw("c2", 5_000n, 2)],
      minimumPayoutMinor: 1n,
    });
    expect(plan.payout).toBe(2_000n);
    expect(plan.nettedTotal).toBe(8_000n);
    expect(plan.carryForward).toBe(0n);
    expect(plan.applied).toEqual([
      { clawbackId: "c1", applied: 3_000n, remaining: 0n },
      { clawbackId: "c2", applied: 5_000n, remaining: 0n },
    ]);
  });

  it("applies oldest clawbacks first and keeps the rest outstanding", () => {
    const plan = planPayout({
      storeId: "s1",
      cutoffMs: CUTOFF,
      items: [item("a", 20_000n)],
      clawbacks: [claw("new", 9_000n, 5), claw("old", 6_000n, 1)],
      minimumPayoutMinor: 1n,
    });
    expect(plan.applied.map((a) => a.clawbackId)).toEqual(["old", "new"]);
    expect(plan.payout).toBe(5_000n);
  });

  it("does not pay when clawbacks swallow everything and carries them", () => {
    const plan = planPayout({
      storeId: "s1",
      cutoffMs: CUTOFF,
      items: [item("a", 5_000n)],
      clawbacks: [claw("c", 9_000n)],
    });
    expect(plan.payable).toBe(false);
    expect(plan.skip).toBe("below_minimum");
    expect(plan.payout).toBe(0n);
    expect(plan.applied).toEqual([]);
    expect(plan.carryForward).toBe(9_000n);
  });

  it("skips a payout below the minimum and reports nothing eligible when empty", () => {
    expect(planPayout({ storeId: "s1", cutoffMs: CUTOFF, items: [item("a", DEFAULT_MINIMUM_PAYOUT_MINOR - 1n)], clawbacks: [] }).skip).toBe(
      "below_minimum",
    );
    expect(planPayout({ storeId: "s1", cutoffMs: CUTOFF, items: [], clawbacks: [] }).skip).toBe("nothing_eligible");
    expect(planPayout({ storeId: "s1", cutoffMs: CUTOFF, items: [item("a", DEFAULT_MINIMUM_PAYOUT_MINOR)], clawbacks: [] }).payable).toBe(true);
  });

  it("rejects duplicate ids and non-positive clawbacks", () => {
    expect(() => planPayout({ storeId: "s1", cutoffMs: CUTOFF, items: [item("a", 1n), item("a", 2n)], clawbacks: [] })).toThrow();
    expect(() => planPayout({ storeId: "s1", cutoffMs: CUTOFF, items: [], clawbacks: [claw("c", 0n)] })).toThrow();
    expect(() => planPayout({ storeId: "s1", cutoffMs: CUTOFF, items: [], clawbacks: [claw("c", 1n), claw("c", 1n)] })).toThrow();
    expect(() => planPayout({ storeId: "s1", cutoffMs: CUTOFF, items: [], clawbacks: [], minimumPayoutMinor: -1n })).toThrow();
  });

  it("ignores another store's clawbacks", () => {
    const plan = planPayout({
      storeId: "s1",
      cutoffMs: CUTOFF,
      items: [item("a", 20_000n)],
      clawbacks: [{ ...claw("x", 15_000n), storeId: "s2" }],
    });
    expect(plan.payout).toBe(20_000n);
    expect(plan.carryForward).toBe(0n);
  });
});

describe("IBAN and names", () => {
  // EG38 0019 0005 0000 0000 2631 8000 2 is the standard documented sample Egyptian IBAN.
  const GOOD = "EG380019000500000000263180002";
  it("accepts the sample IBAN and rejects broken ones", () => {
    expect(isValidEgyptIban(GOOD)).toBe(true);
    expect(isValidEgyptIban("eg38 0019 0005 0000 0000 2631 8000 2")).toBe(true);
    expect(isValidEgyptIban("EG390019000500000000263180002")).toBe(false);
    expect(isValidEgyptIban("GB82WEST12345698765432")).toBe(false);
    expect(() => assertEgyptIban("EG00")).toThrow();
    expect(assertEgyptIban("eg38 0019 0005 0000 0000 2631 8000 2")).toBe(GOOD);
    expect(ibanLast4(GOOD)).toBe("8000".slice(0, 0) + "0002");
  });

  it("matches names regardless of order, diacritics, forms and company suffix", () => {
    expect(namesMatch("Nile Fashion LLC", "nile fashion")).toBe("match");
    expect(namesMatch("شركة النيل للأزياء", "النيل للازياء")).toBe("match");
    expect(namesMatch("أحمد  محمد", "محمد احمد")).toBe("match");
    expect(namesMatch("Nile Fashion", "Delta Fashion")).toBe("mismatch");
    expect(namesMatch("", "")).toBe("mismatch");
    expect(namesMatch("Nile", "Nile Fashion")).toBe("mismatch");
  });

  it("normalization is idempotent", () => {
    const n = normalizeLegalName("  Ahmed   M. Co ");
    expect(normalizeLegalName(n)).toBe(n);
  });
});

describe("dual approval", () => {
  const rec = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
    id: "ap1",
    kind: "payout",
    subjectType: "payout",
    subjectId: "p1",
    amountMinor: 6_000_000n,
    reasonCode: "scheduled_payout",
    requesterId: "u-req",
    state: "APPROVED",
    approverId: "u-app",
    requestedAtMs: 0,
    expiresAtMs: 1_000_000,
    decidedAtMs: 1,
    decisionNote: null,
    ...over,
  });
  const base = { payoutId: "p1", amountMinor: 5_000_000n, nowMs: 10 };

  it("is not required below the threshold", () => {
    const s = payoutApprovalStatus({ ...base, amountMinor: 4_999_999n, records: [] });
    expect(s.kind).toBe("not_required");
    expect(approvalRequirementMet(s)).toBe(true);
  });

  it("is missing at the threshold without a record", () => {
    const s = payoutApprovalStatus({ ...base, records: [] });
    expect(s.kind).toBe("missing");
    expect(approvalRequirementMet(s)).toBe(false);
  });

  it("is covered by an approved record for the same payout, bounded by amount", () => {
    expect(payoutApprovalStatus({ ...base, records: [rec()] })).toEqual({ kind: "covered", approvalId: "ap1" });
    expect(payoutApprovalStatus({ ...base, amountMinor: 6_000_001n, records: [rec()] }).kind).toBe("not_covering");
  });

  it("refuses self approval, other subjects, other kinds, expired and undecided records", () => {
    for (const r of [
      rec({ approverId: "u-req" }),
      rec({ subjectId: "p2" }),
      rec({ kind: "refund" }),
      rec({ expiresAtMs: 10 }),
      rec({ state: "REQUESTED", approverId: null }),
    ]) {
      expect(payoutApprovalStatus({ ...base, records: [r] }).kind).toBe("not_covering");
    }
  });
});

describe("lifecycle", () => {
  const ctx = { approvalRequirementMet: true, noOpenDispute: true, ibanNameMatched: true };
  it("reuses the shared machine and its guards", () => {
    expect(applyPayoutEvent("SCHEDULED", "APPROVE", ctx)).toBe("APPROVED");
    expect(() => applyPayoutEvent("SCHEDULED", "APPROVE", { ...ctx, approvalRequirementMet: false })).toThrow();
    expect(() => applyPayoutEvent("APPROVED", "SEND", { ...ctx, ibanNameMatched: false })).toThrow();
    expect(applyPayoutEvent("SENT", "BANK_REJECTED", ctx)).toBe("FAILED");
    expect(payoutMachine.analyze().ok).toBe(true);
  });
  it("maps provider outcomes and builds attempt-scoped ledger refs", () => {
    expect(eventForOutcome("settled")).toBe("BANK_CONFIRMED");
    expect(eventForOutcome("rejected")).toBe("BANK_REJECTED");
    expect(eventForOutcome("accepted")).toBeNull();
    expect(eventForOutcome("unavailable")).toBeNull();
    expect(ledgerPayoutRef("p", 2)).toBe("p~2");
  });
});

describe("statement", () => {
  const T = Date.UTC(2026, 9, 1);
  it("uses the ledger formulas and chains opening to closing", () => {
    const st = buildStatement({
      storeId: "s1",
      fromMs: T + MS_PER_DAY,
      toMs: T + 10 * MS_PER_DAY,
      facts: [
        { type: "order", id: "o0", storeId: "s1", atMs: T, merchandise: 100_000n, commissionBps: 1_500n, vatBps: 1_400n },
        { type: "order", id: "o1", storeId: "s1", atMs: T + 2 * MS_PER_DAY, merchandise: 123_457n, commissionBps: 1_500n, vatBps: 1_400n },
        { type: "refund", id: "r1", storeId: "s1", atMs: T + 3 * MS_PER_DAY, goodsRefunded: 50_001n, goodsRefundedBefore: 0n, commissionBps: 1_500n, vatBps: 1_400n },
        { type: "promo_netting", id: "pn", storeId: "s1", atMs: T + 4 * MS_PER_DAY, amount: 1_000n },
        { type: "payout", id: "po", storeId: "s1", atMs: T + 5 * MS_PER_DAY, amount: 20_000n },
        { type: "order", id: "x", storeId: "other", atMs: T + 2 * MS_PER_DAY, merchandise: 5n, commissionBps: 0n, vatBps: 0n },
      ],
    });
    const c = commissionOf(money(123_457n), 1_500n).amount;
    const v = commissionVatOf(money(c), 1_400n).amount;
    const opening = 100_000n - commissionOf(money(100_000n), 1_500n).amount - commissionVatOf(commissionOf(money(100_000n), 1_500n), 1_400n).amount;
    expect(st.opening).toBe(opening);
    expect(st.lines[0]?.commission).toBe(c);
    expect(st.lines[0]?.vatOnCommission).toBe(v);
    expect(st.lines[0]?.net).toBe(123_457n - c - v);
    expect(st.lines.map((l) => l.type)).toEqual(["order", "refund", "promo_netting", "payout"]);
    expect(st.totals.payouts).toBe(-20_000n);
    expect(st.totals.adjustments).toBe(-1_000n);
    expect(st.closing).toBe(st.opening + st.totals.net);
    expect(st.lines.at(-1)?.balanceAfter).toBe(st.closing);
  });

  it("rejects duplicates, empty periods and non-positive facts", () => {
    const f = { type: "payout" as const, id: "p", storeId: "s", atMs: 1, amount: 1n };
    expect(() => buildStatement({ storeId: "s", fromMs: 0, toMs: 10, facts: [f, f] })).toThrow();
    expect(() => buildStatement({ storeId: "s", fromMs: 5, toMs: 5, facts: [] })).toThrow();
    expect(() => buildStatement({ storeId: "s", fromMs: 0, toMs: 10, facts: [{ ...f, amount: 0n }] })).toThrow();
    expect(() =>
      buildStatement({ storeId: "s", fromMs: 0, toMs: 10, facts: [{ type: "order", id: "o", storeId: "s", atMs: 1, merchandise: 0n, commissionBps: 0n, vatBps: 0n }] }),
    ).toThrow();
  });
});
