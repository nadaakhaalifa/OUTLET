// Targeted tests for creator commission, clawback, attribution, eligibility, fraud and payout glue.
// Written to kill Stryker survivors (ADR-0019): exact values, exact boundaries, exact messages.
import { describe, expect, it } from "vitest";
import type { ApprovalRecord } from "../admin/approval";
import {
  DEFAULT_CREATOR_CONFIG,
  applyCreatorPayoutEvent,
  applyMonthlyCap,
  attributionWindowEnd,
  balanceView,
  canEarn,
  checkApplication,
  classifyClick,
  clawbackDelta,
  commissionOn,
  creatorPayoutApproval,
  decideCreatorFraud,
  eligibleBase,
  isHumanClass,
  isReservedHandle,
  normalizeHandle,
  payoutEligible,
  payoutLineAmount,
  planRefund,
  planVoid,
  refundedBaseOf,
  selectLastClick,
  targetCommission,
  type ClickFact,
  type PartyIdentifiers,
  type RefundableCommission,
} from "./index";

const CFG = DEFAULT_CREATOR_CONFIG;
const H = 3_600_000;
const DAY = 24 * H;

describe("eligibleBase", () => {
  it("strips VAT after vouchers; voucher bigger than goods floors at zero", () => {
    expect(eligibleBase({ merchandiseGross: 11_400n, voucherAllocated: 0n, vatBps: 1_400n })).toBe(10_000n);
    expect(eligibleBase({ merchandiseGross: 11_400n, voucherAllocated: 1_140n, vatBps: 1_400n })).toBe(9_000n);
    expect(eligibleBase({ merchandiseGross: 1_000n, voucherAllocated: 1_000n, vatBps: 1_400n })).toBe(0n);
    expect(eligibleBase({ merchandiseGross: 1_000n, voucherAllocated: 5_000n, vatBps: 1_400n })).toBe(0n);
    expect(eligibleBase({ merchandiseGross: 1_001n, voucherAllocated: 1_000n, vatBps: 0n })).toBe(1n);
  });
  it("rejects negative inputs by name", () => {
    expect(() => eligibleBase({ merchandiseGross: -1n, voucherAllocated: 0n, vatBps: 0n })).toThrow("negative base input");
    expect(() => eligibleBase({ merchandiseGross: 1n, voucherAllocated: -1n, vatBps: 0n })).toThrow("negative base input");
    expect(() => eligibleBase({ merchandiseGross: 0n, voucherAllocated: 0n, vatBps: 0n })).not.toThrow();
  });
});

describe("commissionOn", () => {
  it("accepts 0 and 10000 bps, rejects outside with messages", () => {
    expect(commissionOn(1_000n, 0n)).toBe(0n);
    expect(commissionOn(1_000n, 10_000n)).toBe(1_000n);
    expect(commissionOn(0n, 300n)).toBe(0n);
    expect(commissionOn(10_000n, 300n)).toBe(300n);
    expect(() => commissionOn(1_000n, -1n)).toThrow("rate out of range");
    expect(() => commissionOn(1_000n, 10_001n)).toThrow("rate out of range");
    expect(() => commissionOn(-1n, 300n)).toThrow("base must not be negative");
  });
});

describe("targetCommission and clawbackDelta", () => {
  const t = { originalBase: 10_000n, rateBps: 300n };
  it("clamps the refunded base into [0, original]", () => {
    expect(targetCommission(t, -5n)).toBe(300n);
    expect(targetCommission(t, -5_000n)).toBe(300n);
    expect(targetCommission(t, 0n)).toBe(300n);
    expect(targetCommission(t, 4_000n)).toBe(180n);
    expect(targetCommission(t, 10_000n)).toBe(0n);
    expect(targetCommission(t, 20_000n)).toBe(0n);
    expect(targetCommission(t, 9_999n)).toBe(0n);
  });
  it("claws back only the excess over the target, never more than held", () => {
    expect(clawbackDelta(t, 300n, 0n, 4_000n)).toBe(120n);
    expect(clawbackDelta(t, 300n, 120n, 4_000n)).toBe(0n);
    expect(clawbackDelta(t, 300n, 100n, 4_000n)).toBe(20n);
    expect(clawbackDelta(t, 300n, 0n, 0n)).toBe(0n);
    expect(clawbackDelta(t, 100n, 0n, 4_000n)).toBe(0n);
    expect(clawbackDelta(t, 300n, 0n, 10_000n)).toBe(300n);
    expect(clawbackDelta(t, 300n, 300n, 10_000n)).toBe(0n);
  });
});

describe("applyMonthlyCap and balanceView", () => {
  it("accrues up to and including the cap, holds above it", () => {
    expect(applyMonthlyCap(900n, 100n, 1_000n)).toEqual({ kind: "accrue" });
    expect(applyMonthlyCap(900n, 101n, 1_000n)).toEqual({ kind: "hold", reason: "monthly_cap" });
    expect(applyMonthlyCap(0n, 0n, 0n)).toEqual({ kind: "accrue" });
  });
  it("splits a signed balance", () => {
    expect(balanceView(5n)).toEqual({ payable: 5n, owesPlatform: 0n, negative: false });
    expect(balanceView(0n)).toEqual({ payable: 0n, owesPlatform: 0n, negative: false });
    expect(balanceView(-7n)).toEqual({ payable: 0n, owesPlatform: 7n, negative: true });
  });
});

describe("planRefund / planVoid / refundedBaseOf", () => {
  const c = (over: Partial<RefundableCommission> = {}): RefundableCommission => ({
    state: "ACCRUED",
    base: 10_000n,
    rateBps: 300n,
    amount: 300n,
    clawedBack: 0n,
    refundedBase: 0n,
    ...over,
  });
  it("accruing commissions shrink in place and void at zero", () => {
    expect(planRefund(c({ state: "ACCRUING" }), 4_000n)).toEqual({ kind: "shrink_held", refundedBase: 4_000n, amount: 180n, void: false });
    expect(planRefund(c({ state: "ACCRUING" }), 10_000n)).toEqual({ kind: "shrink_held", refundedBase: 10_000n, amount: 0n, void: true });
    expect(planRefund(c({ state: "ACCRUING" }), 0n)).toEqual({ kind: "none", refundedBase: 0n });
    // a held amount already below the target is left alone
    expect(planRefund(c({ state: "ACCRUING", amount: 100n }), 4_000n)).toEqual({ kind: "none", refundedBase: 4_000n });
    // equal to target is not a shrink
    expect(planRefund(c({ state: "ACCRUING", amount: 180n }), 4_000n)).toEqual({ kind: "none", refundedBase: 4_000n });
    expect(planRefund(c({ state: "ACCRUING", amount: 181n }), 4_000n)).toEqual({ kind: "shrink_held", refundedBase: 4_000n, amount: 180n, void: false });
  });
  it("accrued and paid commissions claw back the difference", () => {
    for (const state of ["ACCRUED", "PAID"] as const) {
      expect(planRefund(c({ state }), 4_000n)).toEqual({ kind: "clawback", refundedBase: 4_000n, delta: 120n, clawedBack: 120n, full: false });
      expect(planRefund(c({ state }), 10_000n)).toEqual({ kind: "clawback", refundedBase: 10_000n, delta: 300n, clawedBack: 300n, full: true });
      expect(planRefund(c({ state }), 0n)).toEqual({ kind: "none", refundedBase: 0n });
    }
    expect(planRefund(c({ clawedBack: 120n, refundedBase: 4_000n }), 10_000n)).toEqual({
      kind: "clawback",
      refundedBase: 10_000n,
      delta: 180n,
      clawedBack: 300n,
      full: true,
    });
    expect(planRefund(c({ clawedBack: 120n, refundedBase: 4_000n }), 4_000n)).toEqual({ kind: "none", refundedBase: 4_000n });
  });
  it("clamps the new refunded base and never lowers it", () => {
    expect(planRefund(c(), -50n)).toEqual({ kind: "none", refundedBase: 0n });
    expect(planRefund(c(), 99_999n)).toMatchObject({ kind: "clawback", refundedBase: 10_000n });
    expect(planRefund(c({ refundedBase: 5_000n, clawedBack: 150n }), 3_000n)).toEqual({ kind: "none", refundedBase: 5_000n });
    expect(planRefund(c({ refundedBase: 5_000n, clawedBack: 150n }), 5_000n)).toEqual({ kind: "none", refundedBase: 5_000n });
  });
  it("closed commissions never change, but the refunded base still ratchets", () => {
    for (const state of ["VOIDED", "CLAWED_BACK"] as const) {
      expect(planRefund(c({ state }), 4_000n)).toEqual({ kind: "none", refundedBase: 4_000n });
      expect(planRefund(c({ state, refundedBase: 9_000n }), 4_000n)).toEqual({ kind: "none", refundedBase: 9_000n });
    }
  });
  it("planVoid refunds the whole base", () => {
    expect(planVoid(c({ state: "ACCRUING" }))).toEqual({ kind: "shrink_held", refundedBase: 10_000n, amount: 0n, void: true });
    expect(planVoid(c())).toMatchObject({ kind: "clawback", delta: 300n, full: true });
  });
  it("refundedBaseOf is proportional, clamped and zero for non-positive inputs", () => {
    expect(refundedBaseOf(1_000n, 3_000n, 1_000n)).toBe(333n);
    expect(refundedBaseOf(1_000n, 3_000n, 3_000n)).toBe(1_000n);
    expect(refundedBaseOf(1_000n, 3_000n, 9_000n)).toBe(1_000n);
    expect(refundedBaseOf(1_000n, 3_000n, 0n)).toBe(0n);
    expect(refundedBaseOf(1_000n, 3_000n, -5n)).toBe(0n);
    expect(refundedBaseOf(1_000n, 0n, 100n)).toBe(0n);
    expect(refundedBaseOf(1_000n, -1n, 100n)).toBe(0n);
    expect(refundedBaseOf(1_000n, 3_000n, 1n)).toBe(0n);
    expect(refundedBaseOf(1_000n, 2_000n, 1_001n)).toBe(500n);
  });
});

describe("eligibility", () => {
  const app = { ageYears: 30, handle: "nada_style", termsVersionAccepted: 1, sellerConflict: false };
  it("rule order", () => {
    expect(checkApplication(CFG, app)).toBeNull();
    expect(checkApplication(CFG, { ...app, ageYears: null, handle: "!!" })).toBe("age_unknown");
    expect(checkApplication(CFG, { ...app, ageYears: 20, handle: "!!" })).toBe("under_age");
    expect(checkApplication(CFG, { ...app, ageYears: 21 })).toBeNull();
    expect(checkApplication(CFG, { ...app, handle: "!!", termsVersionAccepted: null })).toBe("handle_invalid");
    expect(checkApplication(CFG, { ...app, handle: "outlet", termsVersionAccepted: null })).toBe("handle_reserved");
    expect(checkApplication(CFG, { ...app, termsVersionAccepted: null, sellerConflict: true })).toBe("terms_not_accepted");
    expect(checkApplication(CFG, { ...app, sellerConflict: true })).toBe("seller_conflict");
  });
  it("handles", () => {
    expect(normalizeHandle("  Nada_Style ")).toBe("nada_style");
    expect(normalizeHandle("abc")).toBe("abc");
    expect(normalizeHandle("ab")).toBeNull();
    expect(normalizeHandle("a" + "b".repeat(29))).toBe("a" + "b".repeat(29));
    expect(normalizeHandle("a" + "b".repeat(30))).toBeNull();
    expect(normalizeHandle("1abc")).toBeNull();
    expect(normalizeHandle("_abc")).toBeNull();
    expect(normalizeHandle("abc!")).toBeNull();
    expect(normalizeHandle("abc-d")).toBeNull();
    expect(normalizeHandle("!abc")).toBeNull();
    expect(normalizeHandle("ab c")).toBeNull();
  });
  it("reserved handles fold underscores and hyphens", () => {
    expect(isReservedHandle(CFG, "z_outlet")).toBe(true);
    expect(isReservedHandle(CFG, "zoutlet")).toBe(true);
    expect(isReservedHandle(CFG, "ha_ul")).toBe(true);
    expect(isReservedHandle(CFG, "nada")).toBe(false);
    const cfg = { ...CFG, reservedHandles: ["my-brand", "your_brand"] };
    expect(isReservedHandle(cfg, "mybrand")).toBe(true);
    expect(isReservedHandle(cfg, "my_brand")).toBe(true);
    expect(isReservedHandle(cfg, "yourbrand")).toBe(true);
    expect(isReservedHandle(cfg, "your_brand")).toBe(true);
  });
  const f = { status: "ACTIVE", kycState: "APPROVED", ageYears: 30, termsAccepted: true } as const;
  it("canEarn / payoutEligible", () => {
    expect(canEarn(CFG, f)).toBeNull();
    expect(canEarn(CFG, { ...f, status: "SUSPENDED", ageYears: null })).toBe("not_active");
    expect(canEarn(CFG, { ...f, ageYears: null, termsAccepted: false })).toBe("age_unknown");
    expect(canEarn(CFG, { ...f, ageYears: 20, termsAccepted: false })).toBe("under_age");
    expect(canEarn(CFG, { ...f, ageYears: 21 })).toBeNull();
    expect(canEarn(CFG, { ...f, termsAccepted: false })).toBe("terms_not_accepted");
    expect(payoutEligible(CFG, f)).toBeNull();
    expect(payoutEligible(CFG, { ...f, kycState: "NEEDS_INFO" })).toBe("kyc_incomplete");
    expect(payoutEligible(CFG, { ...f, kycState: "NEEDS_INFO", termsAccepted: false })).toBe("terms_not_accepted");
  });
});

describe("attribution", () => {
  const click = (o: Partial<ClickFact> & { id: string; atMs: number }): ClickFact => ({
    linkId: "l1",
    creatorId: "c1",
    deviceHash: "d1",
    counted: true,
    uaClass: "app",
    ...o,
  });
  const orderAtMs = 30 * DAY;
  const base = { orderAtMs, buyerDeviceHashes: ["d1"] };
  it("human classes and window end", () => {
    expect(isHumanClass("app")).toBe(true);
    expect(isHumanClass("browser")).toBe(true);
    expect(isHumanClass("bot")).toBe(false);
    expect(isHumanClass("headless")).toBe(false);
    expect(attributionWindowEnd(CFG, 1_000)).toBe(1_000 + 7 * DAY);
  });
  it("a click at the order instant counts; browser clicks count; ties pick the largest id", () => {
    expect(selectLastClick(CFG, { ...base, clicks: [click({ id: "x", atMs: orderAtMs, uaClass: "browser" })] })?.id).toBe("x");
    const ties = [click({ id: "m", atMs: 5 * DAY + 30 * DAY - 10 * DAY }), click({ id: "z", atMs: 25 * DAY }), click({ id: "a", atMs: 25 * DAY })];
    expect(selectLastClick(CFG, { ...base, clicks: ties })?.id).toBe("z");
    expect(selectLastClick(CFG, { ...base, clicks: [...ties].reverse() })?.id).toBe("z");
    const later = [click({ id: "a", atMs: 26 * DAY }), click({ id: "z", atMs: 25 * DAY })];
    expect(selectLastClick(CFG, { ...base, clicks: later })?.id).toBe("a");
  });
  it("sessions: a later click by another creator inside the protected window does not steal the sale", () => {
    const s = 28 * DAY;
    const anchor = click({ id: "a", atMs: s - H, creatorId: "c1" });
    const thief = click({ id: "t", atMs: s + H, creatorId: "c2" });
    const r = (clicks: ClickFact[], sessionStartedAtMs: number | null | undefined) =>
      selectLastClick(CFG, { ...base, clicks, ...(sessionStartedAtMs === undefined ? {} : { sessionStartedAtMs }) })?.id;
    expect(r([anchor, thief], s)).toBe("a");
    // no session => plain last click
    expect(r([anchor, thief], null)).toBe("t");
    expect(r([anchor, thief], undefined)).toBe("t");
    // same creator after the session start is not protected against
    expect(r([anchor, click({ id: "u", atMs: s + H, creatorId: "c1" })], s)).toBe("u");
    // an anchor click exactly at session start is still the anchor
    expect(r([click({ id: "a", atMs: s, creatorId: "c1" }), thief], s)).toBe("a");
    // protected window upper bound is inclusive
    const edge = click({ id: "e", atMs: s + CFG.protectedWindowMs, creatorId: "c2" });
    expect(r([anchor, edge], s)).toBe("a");
    const past = click({ id: "p", atMs: s + CFG.protectedWindowMs + 1, creatorId: "c2" });
    expect(r([anchor, past], s)).toBe("p");
    // no anchor (every click is after the session start): plain last click
    expect(r([thief], s)).toBe("t");
    // click exactly at session start by another creator is not "after" it
    expect(r([anchor, click({ id: "q", atMs: s, creatorId: "c2" })], s)).toBe("q");
  });
  it("a click at time zero with no session is a plain last click", () => {
    const cfg = { ...CFG, attributionWindowMs: 10 * DAY };
    const r = selectLastClick(cfg, {
      orderAtMs: 2 * H,
      buyerDeviceHashes: ["d1"],
      clicks: [click({ id: "a", atMs: 0, creatorId: "c1" }), click({ id: "b", atMs: H, creatorId: "c2" })],
    });
    expect(r?.id).toBe("b");
  });
  it("classifyClick applies all three caps independently", () => {
    const c = { ...CFG, maxCountedClicksPerIpPerHour: 5, maxCountedClicksPerDevicePerHour: 3, maxCountedClicksPerLinkPerHour: 7 };
    expect(classifyClick(c, { uaClass: "app", countedForIpThisHour: 4, countedForDeviceThisHour: 2, countedForLinkThisHour: 6 })).toEqual({ counted: true, attributable: true });
    expect(classifyClick(c, { uaClass: "app", countedForIpThisHour: 5 })).toEqual({ counted: false, attributable: false });
    expect(classifyClick(c, { uaClass: "app", countedForIpThisHour: 0, countedForDeviceThisHour: 3 })).toEqual({ counted: false, attributable: false });
    expect(classifyClick(c, { uaClass: "app", countedForIpThisHour: 0, countedForLinkThisHour: 7 })).toEqual({ counted: false, attributable: false });
    expect(classifyClick(c, { uaClass: "browser", countedForIpThisHour: 0 })).toEqual({ counted: true, attributable: true });
    expect(classifyClick(c, { uaClass: "headless", countedForIpThisHour: 0 })).toEqual({ counted: true, attributable: false });
    expect(classifyClick(c, { uaClass: "bot", countedForIpThisHour: 9 })).toEqual({ counted: false, attributable: false });
  });
});

describe("decideCreatorFraud extras", () => {
  const party = (userId: string, o: Partial<PartyIdentifiers> = {}): PartyIdentifiers => ({
    userId,
    deviceHashes: [],
    paymentFingerprintHashes: [],
    addressHashes: [],
    ...o,
  });
  it("a different payment fingerprint is not shared", () => {
    const creator = party("c", { paymentFingerprintHashes: ["f1"] });
    expect(decideCreatorFraud({ creator, buyer: party("b", { paymentFingerprintHashes: ["f2"] }), otherBuyers: [], clusterThreshold: 3 })).toBeNull();
    expect(decideCreatorFraud({ creator, buyer: party("b", { paymentFingerprintHashes: ["f2", "f1"] }), otherBuyers: [], clusterThreshold: 3 })).toBe(
      "shared_payment",
    );
  });
  it("cluster size equal to the threshold is allowed, one more is voided", () => {
    const creator = party("c");
    const ring = ["b1", "b2"].map((id) => party(id, { deviceHashes: ["ring"] }));
    const buyer = party("b3", { deviceHashes: ["ring"] });
    expect(decideCreatorFraud({ creator, buyer, otherBuyers: ring, clusterThreshold: 3 })).toBeNull();
    expect(decideCreatorFraud({ creator, buyer, otherBuyers: ring, clusterThreshold: 2 })).toBe("cluster");
  });
  it("different identifiers of the same kind never link", () => {
    const creator = party("c");
    const run = (a: Partial<PartyIdentifiers>, b: Partial<PartyIdentifiers>) =>
      decideCreatorFraud({ creator, buyer: party("b", a), otherBuyers: [party("o", b)], clusterThreshold: 1 });
    expect(run({ deviceHashes: ["d1"] }, { deviceHashes: ["d2"] })).toBeNull();
    expect(run({ paymentFingerprintHashes: ["f1"] }, { paymentFingerprintHashes: ["f2"] })).toBeNull();
    expect(run({ addressHashes: ["a1"] }, { addressHashes: ["a2"] })).toBeNull();
    expect(run({ deviceHashes: ["d1"] }, { deviceHashes: ["d1"] })).toBe("cluster");
    expect(run({ paymentFingerprintHashes: ["f1"] }, { paymentFingerprintHashes: ["f1"] })).toBe("cluster");
    expect(run({ addressHashes: ["a1"] }, { addressHashes: ["a1"] })).toBe("cluster");
  });
  it("identifiers of different kinds never link, even with the same hash", () => {
    const creator = party("c");
    const buyer = party("b", { addressHashes: ["X"] });
    const other = party("o", { deviceHashes: ["X"] });
    expect(decideCreatorFraud({ creator, buyer, otherBuyers: [other], clusterThreshold: 1 })).toBeNull();
    const otherFp = party("o2", { paymentFingerprintHashes: ["X"] });
    expect(decideCreatorFraud({ creator, buyer, otherBuyers: [otherFp], clusterThreshold: 1 })).toBeNull();
    const sameKind = party("o3", { addressHashes: ["X"] });
    // same address is a shared-address signal only against the creator; among buyers it clusters
    expect(decideCreatorFraud({ creator, buyer, otherBuyers: [sameKind], clusterThreshold: 1 })).toBe("cluster");
    const fpBuyer = party("b", { paymentFingerprintHashes: ["Y"] });
    expect(decideCreatorFraud({ creator, buyer: fpBuyer, otherBuyers: [party("o4", { paymentFingerprintHashes: ["Y"] })], clusterThreshold: 1 })).toBe("cluster");
    expect(decideCreatorFraud({ creator, buyer: fpBuyer, otherBuyers: [party("o5", { deviceHashes: ["Y"] })], clusterThreshold: 1 })).toBeNull();
  });
});

describe("payout glue", () => {
  it("payoutLineAmount is the smaller positive side", () => {
    expect(payoutLineAmount(5n, 5n)).toBe(5n);
    expect(payoutLineAmount(3n, 5n)).toBe(3n);
    expect(payoutLineAmount(5n, 3n)).toBe(3n);
    expect(payoutLineAmount(0n, 5n)).toBe(0n);
    expect(payoutLineAmount(5n, 0n)).toBe(0n);
    expect(payoutLineAmount(-4n, 5n)).toBe(0n);
    expect(payoutLineAmount(5n, -4n)).toBe(0n);
  });
  const rec = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
    id: "ap1",
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
  it("small payouts need no approval; big ones need a covering approval", () => {
    expect(creatorPayoutApproval({ payoutId: "p1", amountMinor: 100n, records: [], nowMs: 5 })).toEqual({ status: { kind: "not_required" }, met: true });
    expect(creatorPayoutApproval({ payoutId: "p1", amountMinor: 6_000_000n, records: [], nowMs: 5 })).toEqual({ status: { kind: "missing" }, met: false });
    expect(creatorPayoutApproval({ payoutId: "p1", amountMinor: 6_000_000n, records: [rec({ subjectId: "other" })], nowMs: 5 })).toEqual({
      status: { kind: "not_covering" },
      met: false,
    });
    expect(creatorPayoutApproval({ payoutId: "p1", amountMinor: 6_000_000n, records: [rec()], nowMs: 5 })).toEqual({
      status: { kind: "covered", approvalId: "ap1" },
      met: true,
    });
  });
  it("applyCreatorPayoutEvent delegates to the payout machine with its guards", () => {
    const ok = { approvalRequirementMet: true, noOpenDispute: true, ibanNameMatched: true };
    expect(applyCreatorPayoutEvent("SCHEDULED", "APPROVE", ok)).toBe("APPROVED");
    expect(applyCreatorPayoutEvent("APPROVED", "SEND", ok)).toBe("SENT");
    expect(() => applyCreatorPayoutEvent("SCHEDULED", "APPROVE", { ...ok, approvalRequirementMet: false })).toThrow();
    expect(() => applyCreatorPayoutEvent("APPROVED", "SEND", { ...ok, ibanNameMatched: false })).toThrow();
  });
});
