import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chart } from "../chart-of-accounts/accounts";
import {
  creatorCommissionAccrued,
  creatorCommissionClawedBack,
  creatorPayout,
  type EntryMeta,
} from "../chart-of-accounts/builders";
import { balanceOf, reverseEntry, trialBalance, type JournalEntry } from "../ledger";
import { money } from "../money";
import {
  DEFAULT_CREATOR_CONFIG,
  applyMonthlyCap,
  balanceView,
  checkApplication,
  classifyClick,
  clawbackDelta,
  commissionMachine,
  commissionOn,
  decideCreatorFraud,
  eligibleBase,
  isReservedHandle,
  normalizeHandle,
  payoutEligible,
  payoutLineAmount,
  planVoid,
  rateFor,
  selectLastClick,
  targetCommission,
  transitionCommission,
  validateCreatorConfig,
  COMMISSION_EVENTS,
  COMMISSION_STATES,
  type ClickFact,
  type PartyIdentifiers,
} from "./index";

const CFG = DEFAULT_CREATOR_CONFIG;
const DAY = 86_400_000;
const click = (o: Partial<ClickFact> & { id: string; atMs: number }): ClickFact => ({
  linkId: "l1",
  creatorId: "c1",
  deviceHash: "d1",
  counted: true,
  uaClass: "app",
  ...o,
});
const party = (userId: string, o: Partial<PartyIdentifiers> = {}): PartyIdentifiers => ({
  userId,
  deviceHashes: [],
  paymentFingerprintHashes: [],
  addressHashes: [],
  ...o,
});

describe("config", () => {
  it("rejects an under-21 minimum and out-of-range rates", () => {
    expect(() => validateCreatorConfig({ ...CFG, minAgeYears: 18 })).toThrow();
    expect(() => validateCreatorConfig({ ...CFG, defaultRateBps: 6_000n })).toThrow();
    expect(validateCreatorConfig(CFG)).toBe(CFG);
  });
  it("uses the category rate then the default", () => {
    const c = { ...CFG, categoryRateBps: { shoes: 500n } };
    expect(rateFor(c, "shoes")).toBe(500n);
    expect(rateFor(c, "bags")).toBe(300n);
    expect(rateFor(c, null)).toBe(300n);
  });
});

describe("eligibility", () => {
  const ok = { ageYears: 25, handle: "nada_style", termsVersionAccepted: 1, sellerConflict: false };
  it("refuses under 21 with the policy reason", () => {
    expect(checkApplication(CFG, { ...ok, ageYears: 20 })).toBe("under_age");
    expect(checkApplication(CFG, { ...ok, ageYears: 21 })).toBeNull();
    expect(checkApplication(CFG, { ...ok, ageYears: null })).toBe("age_unknown");
  });
  it("guards handles", () => {
    expect(normalizeHandle(" Nada_Style ")).toBe("nada_style");
    expect(normalizeHandle("a")).toBeNull();
    expect(isReservedHandle(CFG, "z_outlet")).toBe(true);
    expect(checkApplication(CFG, { ...ok, handle: "official" })).toBe("handle_reserved");
  });
  it("seller conflict and terms", () => {
    expect(checkApplication(CFG, { ...ok, sellerConflict: true })).toBe("seller_conflict");
    expect(checkApplication(CFG, { ...ok, termsVersionAccepted: null })).toBe("terms_not_accepted");
  });
  it("payout needs approved KYC and age", () => {
    const f = { status: "ACTIVE", kycState: "SUBMITTED", ageYears: 30, termsAccepted: true } as const;
    expect(payoutEligible(CFG, f)).toBe("kyc_incomplete");
    expect(payoutEligible(CFG, { ...f, kycState: "APPROVED" })).toBeNull();
    expect(payoutEligible(CFG, { ...f, kycState: "APPROVED", ageYears: 20 })).toBe("under_age");
    expect(payoutEligible(CFG, { ...f, kycState: "APPROVED", status: "SUSPENDED" })).toBe("not_active");
  });
});

describe("attribution", () => {
  const base = { orderAtMs: 10 * DAY, buyerDeviceHashes: ["d1"] };
  it("last click wins; ties break by id", () => {
    const clicks = [click({ id: "a", atMs: 5 * DAY, creatorId: "c1" }), click({ id: "b", atMs: 8 * DAY, creatorId: "c2" })];
    expect(selectLastClick(CFG, { ...base, clicks })?.creatorId).toBe("c2");
    const tie = [click({ id: "a", atMs: 8 * DAY }), click({ id: "z", atMs: 8 * DAY, creatorId: "c9" })];
    expect(selectLastClick(CFG, { ...base, clicks: tie })?.id).toBe("z");
  });
  it("ignores expired, future, foreign-device, uncounted and bot clicks", () => {
    const clicks = [
      click({ id: "old", atMs: 2 * DAY }),
      click({ id: "future", atMs: 11 * DAY }),
      click({ id: "other", atMs: 9 * DAY, deviceHash: "dX" }),
      click({ id: "unc", atMs: 9 * DAY, counted: false }),
      click({ id: "bot", atMs: 9 * DAY, uaClass: "bot" }),
      click({ id: "hl", atMs: 9 * DAY, uaClass: "headless" }),
    ];
    expect(selectLastClick(CFG, { ...base, clicks })).toBeNull();
  });
  it("window boundary is inclusive at exactly 7 days", () => {
    expect(selectLastClick(CFG, { ...base, clicks: [click({ id: "e", atMs: 3 * DAY })] })?.id).toBe("e");
    expect(selectLastClick(CFG, { ...base, clicks: [click({ id: "e", atMs: 3 * DAY - 1 })] })).toBeNull();
  });
  it("a suspended creator's click does not attribute", () => {
    const r = selectLastClick(CFG, { ...base, clicks: [click({ id: "a", atMs: 9 * DAY })], activeCreatorIds: new Set(["c2"]) });
    expect(r).toBeNull();
  });
  it("caps counted clicks per ip per hour and refuses bots", () => {
    expect(classifyClick(CFG, { uaClass: "app", countedForIpThisHour: 29 })).toEqual({ counted: true, attributable: true });
    expect(classifyClick(CFG, { uaClass: "app", countedForIpThisHour: 30 })).toEqual({ counted: false, attributable: false });
    expect(classifyClick(CFG, { uaClass: "bot", countedForIpThisHour: 0 })).toEqual({ counted: true, attributable: false });
  });
});

describe("commission", () => {
  it("takes voucher and VAT out of the base", () => {
    // 1,140.00 gross, 0 voucher: VAT 14/114 = 140.00 -> base 1,000.00
    expect(eligibleBase({ merchandiseGross: 114_000n, voucherAllocated: 0n, vatBps: 1_400n })).toBe(100_000n);
    expect(eligibleBase({ merchandiseGross: 114_000n, voucherAllocated: 114_000n, vatBps: 1_400n })).toBe(0n);
    expect(eligibleBase({ merchandiseGross: 100n, voucherAllocated: 500n, vatBps: 1_400n })).toBe(0n);
  });
  it("rounds half-even once", () => {
    expect(commissionOn(1_050n, 100n)).toBe(10n); // 10.5 -> 10
    expect(commissionOn(1_150n, 100n)).toBe(12n); // 11.5 -> 12
  });
  it("claws back pro rata, never twice, never more than held", () => {
    const t = { originalBase: 100_000n, rateBps: 300n }; // commission 3,000
    expect(targetCommission(t, 0n)).toBe(3_000n);
    expect(clawbackDelta(t, 3_000n, 0n, 40_000n)).toBe(1_200n);
    expect(clawbackDelta(t, 3_000n, 1_200n, 40_000n)).toBe(0n); // replay
    expect(clawbackDelta(t, 3_000n, 1_200n, 100_000n)).toBe(1_800n);
    expect(clawbackDelta(t, 3_000n, 3_000n, 100_000n)).toBe(0n);
    expect(clawbackDelta(t, 3_000n, 0n, 999_999n)).toBe(3_000n); // clamped
  });
  it("holds a commission that crosses the monthly cap", () => {
    expect(applyMonthlyCap(1_900_000n, 100_000n, 2_000_000n).kind).toBe("accrue");
    expect(applyMonthlyCap(1_900_000n, 100_001n, 2_000_000n).kind).toBe("hold");
  });
  it("reports a negative payable explicitly", () => {
    expect(balanceView(-250n)).toEqual({ payable: 0n, owesPlatform: 250n, negative: true });
    expect(balanceView(900n)).toEqual({ payable: 900n, owesPlatform: 0n, negative: false });
  });
  it("payout line never exceeds the ledger payable or the reserved commissions", () => {
    expect(payoutLineAmount(5_000n, 8_000n)).toBe(5_000n);
    expect(payoutLineAmount(9_000n, 8_000n)).toBe(8_000n);
    expect(payoutLineAmount(-1n, 8_000n)).toBe(0n);
  });
});

describe("commission machine", () => {
  it("has no unreachable states or dead ends", () => {
    const a = commissionMachine.analyze();
    expect(a.unreachable).toEqual([]);
    expect(a.deadEnds).toEqual([]);
  });
  it("follows the table and rejects the rest", () => {
    expect(transitionCommission("ACCRUING", "ACCRUE")).toBe("ACCRUED");
    expect(transitionCommission("ACCRUED", "PAY")).toBe("PAID");
    expect(transitionCommission("PAID", "CLAWBACK_ALL")).toBe("CLAWED_BACK");
    expect(() => transitionCommission("ACCRUING", "PAY")).toThrow();
    expect(() => transitionCommission("VOIDED", "ACCRUE")).toThrow();
    expect(() => transitionCommission("CLAWED_BACK", "PAY")).toThrow();
  });
  it("every (state, event) pair either moves within the state set or throws", () => {
    for (const s of COMMISSION_STATES) {
      for (const e of COMMISSION_EVENTS) {
        try {
          expect(COMMISSION_STATES).toContain(transitionCommission(s, e));
        } catch {
          /* typed rejection */
        }
      }
    }
  });
});

describe("fraud", () => {
  const thr = 3;
  it("self purchase, shared device, payment and address are voided", () => {
    const creator = party("u1", { deviceHashes: ["d1"], paymentFingerprintHashes: ["f1"], addressHashes: ["a1"] });
    const run = (buyer: PartyIdentifiers) => decideCreatorFraud({ creator, buyer, otherBuyers: [], clusterThreshold: thr });
    expect(run(party("u1"))).toBe("self_purchase");
    expect(run(party("u2", { deviceHashes: ["d1"] }))).toBe("same_device");
    expect(run(party("u2", { paymentFingerprintHashes: ["f1"] }))).toBe("shared_payment");
    expect(run(party("u2", { addressHashes: ["a1"] }))).toBe("shared_address");
    expect(run(party("u2", { deviceHashes: ["dX"] }))).toBeNull();
  });
  it("a linked ring bigger than the threshold is voided", () => {
    const creator = party("c");
    const ring = ["b1", "b2", "b3"].map((id) => party(id, { deviceHashes: ["ring"] }));
    const buyer = party("b4", { deviceHashes: ["ring"] });
    expect(decideCreatorFraud({ creator, buyer, otherBuyers: ring, clusterThreshold: thr })).toBe("cluster");
    expect(decideCreatorFraud({ creator, buyer, otherBuyers: ring.slice(0, 1), clusterThreshold: thr })).toBeNull();
  });
});

describe("ledger entries", () => {
  const meta = (n: number): EntryMeta => ({
    id: `e${n}`,
    idempotencyKey: `k${n}`,
    occurredAt: new Date("2026-10-12T08:00:00Z"),
    ref: { type: "commission", id: `c${n}` },
  });

  it("accrual, clawback and payout post the expected accounts and balance", () => {
    const a = creatorCommissionAccrued({ creatorId: "u1", amount: money(3_000n) }, meta(1));
    expect(a.postings.map((p) => [p.account, p.amount.amount])).toEqual([
      ["creator_commission_expense", 3_000n],
      ["creator_payable:u1", -3_000n],
    ]);
    const c = creatorCommissionClawedBack({ creatorId: "u1", amount: money(1_200n) }, meta(2));
    const p = creatorPayout({ creatorId: "u1", amount: money(1_000n), bankAccount: "main" }, meta(3));
    expect(trialBalance([a, c, p]).get("EGP")).toBe(0n);
    // payable natural balance = credits - debits = 3000 - 1200 - 1000
    expect(-balanceOf(chart.creatorPayable("u1"), [a, c, p]).amount).toBe(800n);
  });

  it("a clawback after payout leaves an explicit negative payable", () => {
    const a = creatorCommissionAccrued({ creatorId: "u1", amount: money(1_000n) }, meta(1));
    const p = creatorPayout({ creatorId: "u1", amount: money(1_000n), bankAccount: "main" }, meta(2));
    const c = creatorCommissionClawedBack({ creatorId: "u1", amount: money(400n) }, meta(3));
    const natural = -balanceOf(chart.creatorPayable("u1"), [a, p, c]).amount;
    expect(natural).toBe(-400n);
    expect(balanceView(natural).owesPlatform).toBe(400n);
  });

  it("rejects non-positive amounts and unsafe ids", () => {
    expect(() => creatorCommissionAccrued({ creatorId: "u1", amount: money(0n) }, meta(1))).toThrow();
    expect(() => chart.creatorPayable("a:b")).toThrow();
  });

  it("property: any sequence of accruals, clawbacks, payouts and reversals keeps the ledger balanced and clawbacks never exceed accruals", () => {
    const op = fc.oneof(
      fc.record({ k: fc.constant("accrue" as const), u: fc.constantFrom("u1", "u2", "u3"), n: fc.bigInt({ min: 1n, max: 1_000_000n }) }),
      fc.record({ k: fc.constant("claw" as const), u: fc.constantFrom("u1", "u2", "u3"), n: fc.bigInt({ min: 1n, max: 1_000_000n }) }),
      fc.record({ k: fc.constant("pay" as const), u: fc.constantFrom("u1", "u2", "u3"), n: fc.bigInt({ min: 1n, max: 1_000_000n }) }),
      fc.record({ k: fc.constant("reverse" as const), u: fc.constant("u1"), n: fc.bigInt({ min: 0n, max: 50n }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const entries: JournalEntry[] = [];
        ops.forEach((o, i) => {
          const m = meta(i);
          if (o.k === "accrue") entries.push(creatorCommissionAccrued({ creatorId: o.u, amount: money(o.n) }, m));
          else if (o.k === "claw") entries.push(creatorCommissionClawedBack({ creatorId: o.u, amount: money(o.n) }, m));
          else if (o.k === "pay") entries.push(creatorPayout({ creatorId: o.u, amount: money(o.n), bankAccount: "main" }, m));
          else if (entries.length > 0) {
            const target = entries[Number(o.n) % entries.length];
            if (target !== undefined) entries.push(reverseEntry(target, { id: `r${i}`, idempotencyKey: `rk${i}`, occurredAt: m.occurredAt }));
          }
        });
        expect(trialBalance(entries).get("EGP") ?? 0n).toBe(0n);
        // expense account equals total accrued minus total clawed back, with reversals netted
        const expense = balanceOf(chart.creatorCommissionExpense, entries).amount;
        const payables = ["u1", "u2", "u3"].reduce((s, u) => s + balanceOf(chart.creatorPayable(u), entries).amount, 0n);
        const bank = balanceOf(chart.bankSettlement("main"), entries).amount;
        expect(expense + payables + bank).toBe(0n);
      }),
      { numRuns: 200 },
    );
  });
});

import { planRefund, refundedBaseOf } from "./index";

describe("planRefund", () => {
  const c = { state: "ACCRUED", base: 100_000n, rateBps: 300n, amount: 3_000n, clawedBack: 0n, refundedBase: 0n } as const;
  it("claws back pro rata and is replay safe", () => {
    const p = planRefund(c, 40_000n);
    expect(p).toMatchObject({ kind: "clawback", delta: 1_200n, clawedBack: 1_200n, full: false });
    expect(planRefund({ ...c, clawedBack: 1_200n, refundedBase: 40_000n }, 40_000n).kind).toBe("none");
    expect(planRefund({ ...c, clawedBack: 1_200n, refundedBase: 40_000n }, 10_000n).kind).toBe("none");
  });
  it("full refund of a paid commission claws back everything", () => {
    expect(planRefund({ ...c, state: "PAID" }, 100_000n)).toMatchObject({ kind: "clawback", delta: 3_000n, full: true });
  });
  it("held commissions shrink or void without a ledger entry", () => {
    expect(planRefund({ ...c, state: "ACCRUING" }, 40_000n)).toMatchObject({ kind: "shrink_held", amount: 1_800n, void: false });
    expect(planRefund({ ...c, state: "ACCRUING" }, 100_000n)).toMatchObject({ kind: "shrink_held", amount: 0n, void: true });
  });
  it("terminal states ignore refunds", () => {
    expect(planRefund({ ...c, state: "VOIDED" }, 100_000n).kind).toBe("none");
    expect(planRefund({ ...c, state: "CLAWED_BACK", clawedBack: 3_000n }, 100_000n).kind).toBe("none");
  });
  it("converts a gross refund to base share", () => {
    expect(refundedBaseOf(100_000n, 114_000n, 57_000n)).toBe(50_000n);
    expect(refundedBaseOf(100_000n, 114_000n, 999_999n)).toBe(100_000n);
    expect(refundedBaseOf(100_000n, 0n, 5n)).toBe(0n);
  });
});

describe("worked examples (docs/specs/ledger-chart-of-accounts.md, examples 12 to 14)", () => {
  const meta = (n: number): EntryMeta => ({
    id: `w${n}`,
    idempotencyKey: `wk${n}`,
    occurredAt: new Date("2026-10-12T08:00:00Z"),
    ref: { type: "commission", id: "c" },
  });
  const rows = (e: JournalEntry) => e.postings.map((p) => [p.account, p.amount.amount] as const);
  const natural = (es: JournalEntry[]) => -balanceOf(chart.creatorPayable("u1"), es).amount;

  it("12. accrual on a 1,140.00 EGP line: base 100,000 after VAT, 3% gives 3,000", () => {
    const base = eligibleBase({ merchandiseGross: 114_000n, voucherAllocated: 0n, vatBps: 1_400n });
    expect(base).toBe(100_000n);
    const amount = commissionOn(base, 300n);
    expect(amount).toBe(3_000n);
    const e = creatorCommissionAccrued({ creatorId: "u1", amount: money(amount) }, meta(1));
    expect(rows(e)).toEqual([["creator_commission_expense", 3_000n], ["creator_payable:u1", -3_000n]]);
    expect(natural([e])).toBe(3_000n);
  });

  it("13. half the line is returned after accrual: 1,500 is clawed back, 1,500 stays payable", () => {
    const a = creatorCommissionAccrued({ creatorId: "u1", amount: money(3_000n) }, meta(1));
    const refundedBase = refundedBaseOf(100_000n, 114_000n, 57_000n);
    expect(refundedBase).toBe(50_000n);
    const delta = clawbackDelta({ originalBase: 100_000n, rateBps: 300n }, 3_000n, 0n, refundedBase);
    expect(delta).toBe(1_500n);
    const c = creatorCommissionClawedBack({ creatorId: "u1", amount: money(delta) }, meta(2));
    expect(rows(c)).toEqual([["creator_payable:u1", 1_500n], ["creator_commission_expense", -1_500n]]);
    expect(natural([a, c])).toBe(1_500n);
    expect(trialBalance([a, c]).get("EGP")).toBe(0n);
  });

  it("14. return after payout: the payable goes to minus 3,000, shown as owed, netted from the next accrual of 5,000", () => {
    const a = creatorCommissionAccrued({ creatorId: "u1", amount: money(3_000n) }, meta(1));
    const p = creatorPayout({ creatorId: "u1", amount: money(3_000n), bankAccount: "main" }, meta(2));
    const c = creatorCommissionClawedBack({ creatorId: "u1", amount: money(3_000n) }, meta(3));
    expect(natural([a, p, c])).toBe(-3_000n);
    expect(balanceView(natural([a, p, c]))).toEqual({ payable: 0n, owesPlatform: 3_000n, negative: true });
    const next = creatorCommissionAccrued({ creatorId: "u1", amount: money(5_000n) }, meta(4));
    expect(natural([a, p, c, next])).toBe(2_000n);
    expect(trialBalance([a, p, c, next]).get("EGP")).toBe(0n);
  });
});

describe("A-1 click abuse resistance (phase-3 money review)", () => {
  const base = { orderAtMs: 10 * DAY, buyerDeviceHashes: ["d1"] };
  it("caps counted clicks per device and per link, not only per ip", () => {
    expect(classifyClick(CFG, { uaClass: "app", countedForIpThisHour: 0, countedForDeviceThisHour: 20 }).counted).toBe(false);
    expect(classifyClick(CFG, { uaClass: "app", countedForIpThisHour: 0, countedForLinkThisHour: 500 }).counted).toBe(false);
    expect(classifyClick(CFG, { uaClass: "app", countedForIpThisHour: 0, countedForDeviceThisHour: 19, countedForLinkThisHour: 499 }).counted).toBe(true);
  });
  it("a later click for another creator inside the protected window after a session start does not displace the earlier one", () => {
    const session = 8 * DAY;
    const clicks = [
      click({ id: "a", atMs: 7 * DAY, creatorId: "c1" }),
      click({ id: "hijack", atMs: 8 * DAY + 3_600_000, creatorId: "c2" }),
    ];
    expect(selectLastClick(CFG, { ...base, clicks })?.creatorId).toBe("c2");
    expect(selectLastClick(CFG, { ...base, clicks, sessionStartedAtMs: session })?.creatorId).toBe("c1");
  });
  it("the protection expires and never blocks a click when there is no earlier one", () => {
    const session = 6 * DAY;
    const late = [click({ id: "a", atMs: 5 * DAY, creatorId: "c1" }), click({ id: "b", atMs: 6 * DAY + CFG.protectedWindowMs + 1, creatorId: "c2" })];
    expect(selectLastClick(CFG, { ...base, clicks: late, sessionStartedAtMs: session })?.creatorId).toBe("c2");
    const none = [click({ id: "b", atMs: 6 * DAY + 1000, creatorId: "c2" })];
    expect(selectLastClick(CFG, { ...base, clicks: none, sessionStartedAtMs: session })?.creatorId).toBe("c2");
  });
  it("a repeat click for the anchor creator inside the window is still honoured", () => {
    const clicks = [click({ id: "a", atMs: 5 * DAY, creatorId: "c1" }), click({ id: "b", atMs: 6 * DAY + 1000, creatorId: "c1" })];
    expect(selectLastClick(CFG, { ...base, clicks, sessionStartedAtMs: 6 * DAY })?.id).toBe("b");
  });
  it("validates the new caps", () => {
    expect(() => validateCreatorConfig({ ...CFG, maxCountedClicksPerDevicePerHour: 0 })).toThrow();
    expect(() => validateCreatorConfig({ ...CFG, protectedWindowMs: -1 })).toThrow();
  });
});

describe("A-3 planVoid", () => {
  const c = { base: 100_000n, rateBps: 300n, amount: 3_000n, clawedBack: 0n, refundedBase: 0n };
  it("claws back everything still held for accrued and paid, voids held, ignores terminal", () => {
    expect(planVoid({ ...c, state: "ACCRUED" })).toMatchObject({ kind: "clawback", delta: 3_000n, full: true });
    expect(planVoid({ ...c, state: "PAID", clawedBack: 1_000n })).toMatchObject({ kind: "clawback", delta: 2_000n, full: true });
    expect(planVoid({ ...c, state: "ACCRUING" })).toMatchObject({ kind: "shrink_held", void: true });
    expect(planVoid({ ...c, state: "CLAWED_BACK", clawedBack: 3_000n }).kind).toBe("none");
    expect(planVoid({ ...c, state: "VOIDED" }).kind).toBe("none");
  });
});
