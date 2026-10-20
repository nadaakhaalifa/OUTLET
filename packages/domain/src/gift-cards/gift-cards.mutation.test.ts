// Targeted tests for gift-card codes, pots, rules and the redemption throttle. Written to kill Stryker
// survivors (ADR-0019): exact vectors, exact boundaries, exact precedence.
import { describe, expect, it } from "vitest";
import {
  CODE_LENGTH,
  CODE_MIN_LENGTH,
  CROCKFORD,
  bytesFor,
  encodeCrockford,
  formatCode,
  generateCode,
  last4,
  normalizeCode,
} from "./code";
import {
  DELIVERY_CHANNELS,
  GIFT_CARD_DESIGNS,
  GIFT_CARD_LIMITS,
  PURCHASE_PAYMENT_METHODS,
  REFUSED_PURCHASE_METHODS,
  canRedeemNow,
  canSpendCreditOn,
  canVoid,
  checkAmount,
  expiryFrom,
  expiryReached,
  isPurchaseMethod,
  next,
  planRedemption,
  redemptionView,
  requiredMinimumAge,
  requiresThreeDs,
} from "./rules";
import { REDEMPTION_THROTTLE, evaluateThrottle } from "./throttle";
import type { ContributionFacts } from "./pot";

// Reference implementation: read the bytes as one big-endian bit string in 5-bit groups.
function reference(bytes: Uint8Array, chars: number): string {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < chars; i++) out += CROCKFORD[parseInt(bits.slice(i * 5, i * 5 + 5).padEnd(5, "0"), 2)];
  return out;
}

describe("crockford encoding", () => {
  it("matches a bit-string reference for fixed and pseudo-random inputs", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    for (const chars of [1, 2, 3, 8, 16, 20, 32]) {
      for (let k = 0; k < 20; k++) {
        const bytes = Uint8Array.from({ length: bytesFor(chars) + (k % 3) }, () => rnd());
        expect(encodeCrockford(bytes, chars), `${chars}/${k}`).toBe(reference(bytes, chars));
      }
    }
    expect(encodeCrockford(new Uint8Array(13), 20)).toBe("0".repeat(20));
    expect(encodeCrockford(new Uint8Array(13).fill(255), 20)).toBe("Z".repeat(20));
    expect(encodeCrockford(Uint8Array.from([0b00000100, 0b00100010]), 3)).toBe("124"[0] === "1" ? reference(Uint8Array.from([4, 34]), 3) : "");
  });
  it("sizes and guards", () => {
    expect(bytesFor(20)).toBe(13);
    expect(bytesFor(16)).toBe(10);
    expect(bytesFor(1)).toBe(1);
    expect(bytesFor(8)).toBe(5);
    expect(bytesFor(9)).toBe(6);
    expect(() => encodeCrockford(new Uint8Array(13), 0)).toThrow("chars must be a positive integer");
    expect(() => encodeCrockford(new Uint8Array(13), 1.5)).toThrow("chars must be a positive integer");
    expect(() => encodeCrockford(new Uint8Array(13), -2)).toThrow("chars must be a positive integer");
    expect(encodeCrockford(new Uint8Array(1), 1)).toBe("0");
    expect(() => encodeCrockford(new Uint8Array(12), 20)).toThrow("not enough random bytes");
    expect(() => encodeCrockford(new Uint8Array(13), 20)).not.toThrow();
  });
  it("generateCode draws exactly the bytes it needs", () => {
    let asked = -1;
    const code = generateCode((n) => {
      asked = n;
      return new Uint8Array(n).fill(255);
    });
    expect(asked).toBe(13);
    expect(code).toBe("Z".repeat(CODE_LENGTH));
    expect([CODE_LENGTH, CODE_MIN_LENGTH]).toEqual([20, 16]);
  });
  it("formatCode groups by five", () => {
    expect(formatCode("ABCDEFGHJKMNPQRSTVWX")).toBe("ABCDE-FGHJK-MNPQR-STVWX");
    expect(formatCode("ABCDEFGHJKMN")).toBe("ABCDE-FGHJK-MN");
    expect(formatCode("ABCDE")).toBe("ABCDE");
    expect(formatCode("")).toBe("");
  });
  it("normalizeCode forgives typing, and nothing else", () => {
    const good = "ABCDEFGHJKMNPQRSTVWX";
    expect(normalizeCode(good)).toBe(good);
    expect(normalizeCode("  abcde-fghjk mnpqr\tstvwx \n")).toBe(good);
    expect(normalizeCode("ILO" + "A".repeat(15))).toBe("110" + "A".repeat(15));
    expect(normalizeCode("ilo" + "a".repeat(15))).toBe("110" + "A".repeat(15));
    expect(normalizeCode("A".repeat(16))).toBe("A".repeat(16));
    expect(normalizeCode("A".repeat(15))).toBeNull();
    expect(normalizeCode("A".repeat(32))).toBe("A".repeat(32));
    expect(normalizeCode("A".repeat(33))).toBeNull();
    expect(normalizeCode("U" + "A".repeat(19))).toBeNull();
    expect(normalizeCode("A".repeat(19) + "*")).toBeNull();
    expect(normalizeCode("*" + "A".repeat(19))).toBeNull();
    expect(normalizeCode("A".repeat(10) + "!" + "A".repeat(9))).toBeNull();
    expect(normalizeCode("")).toBeNull();
    // hyphens and spaces count towards neither the minimum nor the maximum
    expect(normalizeCode("AAAAA-AAAAA-AAAAA-A")).toBe("A".repeat(16));
    expect(normalizeCode("AAAAA-AAAAA-AAAAA")).toBeNull();
  });
  it("last4", () => {
    expect(last4("ABCDEFGH")).toBe("EFGH");
    expect(last4("AB")).toBe("AB");
  });
});

describe("pots", () => {
  const load = () => import("./pot");
  it("machine table", async () => {
    const p = await load();
    expect([...p.POT_STATES]).toEqual(["OPEN", "CLOSED_FUNDED", "CLOSED_UNFUNDED", "REFUNDING", "REFUNDED"]);
    expect([...p.POT_EVENTS]).toEqual(["CLOSE_FUNDED", "CLOSE_UNFUNDED", "START_REFUND", "REFUND_DONE"]);
    const want: Record<string, Record<string, string>> = {
      OPEN: { CLOSE_FUNDED: "CLOSED_FUNDED", CLOSE_UNFUNDED: "CLOSED_UNFUNDED" },
      CLOSED_FUNDED: {},
      CLOSED_UNFUNDED: { START_REFUND: "REFUNDING" },
      REFUNDING: { REFUND_DONE: "REFUNDED" },
      REFUNDED: {},
    };
    for (const s of p.POT_STATES) {
      for (const e of p.POT_EVENTS) {
        const to = want[s]?.[e];
        if (to === undefined) expect(() => p.potMachine.transition(s, e), `${s} ${e}`).toThrow();
        else expect(p.potMachine.transition(s, e)).toBe(to);
      }
    }
    expect(p.potMachine.name).toBe("GiftPot");
    expect(p.potMachine.initial).toBe("OPEN");
    expect([...p.potMachine.terminalStates]).toEqual(["CLOSED_FUNDED", "REFUNDED"]);
  });
  const c = (id: string, amount: bigint, status: ContributionFacts["status"]): ContributionFacts => ({ id, amount, status });
  it("paidTotal and refundPlan", async () => {
    const p = await load();
    const cs = [c("a", 100n, "paid"), c("b", 200n, "pending"), c("c", 400n, "refund_failed"), c("d", 800n, "refunded"), c("e", 1_600n, "cancelled"), c("f", 3_200n, "pending_void")];
    expect(p.paidTotal(cs)).toBe(100n);
    expect(p.refundPlan(cs)).toEqual({ refunds: [cs[0], cs[2]], total: 500n });
    expect(p.refundPlan([])).toEqual({ refunds: [], total: 0n });
  });
  it("checkContribution", async () => {
    const p = await load();
    const chk = p.checkContribution;
    expect(chk(100_000n, 0n, 0n)).toEqual({ ok: false, reason: "not_whole_egp" });
    expect(chk(100_000n, 0n, -100n)).toEqual({ ok: false, reason: "not_whole_egp" });
    expect(chk(100_000n, 0n, 5_050n)).toEqual({ ok: false, reason: "not_whole_egp" });
    expect(chk(100_000n, 0n, 5_000n)).toEqual({ ok: true });
    expect(chk(100_000n, 0n, 4_900n)).toEqual({ ok: false, reason: "below_min" });
    expect(chk(100_000n, 98_000n, 2_000n)).toEqual({ ok: true });
    expect(chk(100_000n, 98_000n, 2_100n)).toEqual({ ok: false, reason: "exceeds_target" });
    expect(chk(100_000n, 98_000n, 1_900n)).toEqual({ ok: false, reason: "below_min" });
    expect(chk(100_000n, 0n, 100_000n)).toEqual({ ok: true });
    expect(chk(100_000n, 0n, 100_100n)).toEqual({ ok: false, reason: "exceeds_target" });
    expect(chk(100_000n, 100_000n, 100n)).toEqual({ ok: false, reason: "exceeds_target" });
    expect(p.checkTarget(9_900n)).toEqual({ ok: false, reason: "below_min" });
    expect(p.checkTarget(10_000n)).toEqual({ ok: true });
  });
  it("closeOutcome", async () => {
    const p = await load();
    const o = (paid: bigint, now: number) => p.closeOutcome({ target: 1_000n, paid, closesAtMs: 100, nowMs: now });
    expect(o(1_000n, 0)).toBe("funded");
    expect(o(1_001n, 0)).toBe("funded");
    expect(o(999n, 99)).toBe("stay_open");
    expect(o(999n, 100)).toBe("unfunded");
    expect(o(999n, 101)).toBe("unfunded");
    expect(o(1_000n, 500)).toBe("funded");
    expect(p.closeOutcome({ target: 1n, paid: 0n, closesAtMs: 1, nowMs: 0 })).toBe("stay_open");
  });
});

describe("amount rules", () => {
  it("limits and lists are exact", () => {
    expect(GIFT_CARD_LIMITS).toEqual({
      minAmount: 10_000n,
      maxAmount: 1_000_000n,
      age21Above: 500_000n,
      threeDsAbove: 200_000n,
      minContribution: 5_000n,
      expiryYears: 3,
      maxMessageChars: 500,
    });
    expect([...GIFT_CARD_DESIGNS]).toEqual(["birthday", "eid", "ramadan", "wedding", "new_baby", "graduation", "thank_you"]);
    expect([...DELIVERY_CHANNELS]).toEqual(["whatsapp", "sms", "email", "in_app"]);
    expect([...PURCHASE_PAYMENT_METHODS]).toEqual(["card", "apple_pay", "meeza", "mobile_wallet", "instapay", "fawry"]);
    expect([...REFUSED_PURCHASE_METHODS]).toEqual(["store_credit", "gift_card", "bnpl", "cod"]);
    for (const m of PURCHASE_PAYMENT_METHODS) expect(isPurchaseMethod(m)).toBe(true);
    for (const m of REFUSED_PURCHASE_METHODS) expect(isPurchaseMethod(m)).toBe(false);
    expect(isPurchaseMethod("")).toBe(false);
  });
  it("checkAmount boundaries and precedence", () => {
    expect(checkAmount(9_999n)).toEqual({ ok: false, reason: "below_min" });
    expect(checkAmount(10_000n)).toEqual({ ok: true });
    expect(checkAmount(10_050n)).toEqual({ ok: false, reason: "not_whole_egp" });
    expect(checkAmount(1_000_000n)).toEqual({ ok: true });
    expect(checkAmount(1_000_001n)).toEqual({ ok: false, reason: "above_max" });
    expect(checkAmount(1_000_100n)).toEqual({ ok: false, reason: "above_max" });
    expect(checkAmount(-100n)).toEqual({ ok: false, reason: "below_min" });
    expect(checkAmount(10_100n)).toEqual({ ok: true });
  });
  it("age and 3-D Secure thresholds are strict", () => {
    expect(requiredMinimumAge(500_000n)).toBe(18);
    expect(requiredMinimumAge(500_100n)).toBe(21);
    expect(requiresThreeDs(200_000n, true)).toBe(false);
    expect(requiresThreeDs(200_100n, true)).toBe(true);
    expect(requiresThreeDs(900_000n, false)).toBe(false);
  });
  it("expiry is three years, clamped to the month end", () => {
    expect(expiryFrom(Date.UTC(2026, 5, 15, 13, 14, 15, 16))).toBe(Date.UTC(2029, 5, 15, 13, 14, 15, 16));
    expect(expiryFrom(Date.UTC(2028, 1, 29, 8))).toBe(Date.UTC(2031, 1, 28, 8));
    expect(expiryFrom(Date.UTC(2026, 0, 31), 1)).toBe(Date.UTC(2027, 0, 31));
    expect(expiryFrom(Date.UTC(2028, 1, 29), 4)).toBe(Date.UTC(2032, 1, 29));
    expect(expiryFrom(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe(Date.UTC(2029, 11, 31, 23, 59, 59, 999));
  });
  it("credit can pay for goods and delivery only", () => {
    expect(canSpendCreditOn("merchandise")).toBe(true);
    expect(canSpendCreditOn("delivery")).toBe(true);
    expect(canSpendCreditOn("gift_card")).toBe(false);
    expect(canSpendCreditOn("plus")).toBe(false);
  });
});

describe("redemption", () => {
  it("planRedemption", () => {
    expect(planRedemption(0n, null)).toEqual({ ok: false, reason: "nothing_left" });
    expect(planRedemption(-5n, 1n)).toEqual({ ok: false, reason: "nothing_left" });
    expect(planRedemption(500n, null)).toEqual({ ok: true, amount: 500n, remainingAfter: 0n, full: true });
    expect(planRedemption(500n, 200n)).toEqual({ ok: true, amount: 200n, remainingAfter: 300n, full: false });
    expect(planRedemption(500n, 500n)).toEqual({ ok: true, amount: 500n, remainingAfter: 0n, full: true });
    expect(planRedemption(500n, 501n)).toEqual({ ok: false, reason: "exceeds_balance" });
    expect(planRedemption(500n, 0n)).toEqual({ ok: false, reason: "invalid_amount" });
    expect(planRedemption(500n, -1n)).toEqual({ ok: false, reason: "invalid_amount" });
    expect(planRedemption(1n, 1n)).toEqual({ ok: true, amount: 1n, remainingAfter: 0n, full: true });
  });
  it("redemptionView", () => {
    expect(redemptionView(1_000n, 1_000n)).toBe("none");
    expect(redemptionView(1_000n, 999n)).toBe("partial");
    expect(redemptionView(1_000n, 1n)).toBe("partial");
    expect(redemptionView(1_000n, 0n)).toBe("full");
    expect(redemptionView(1_000n, -1n)).toBe("full");
  });
  it("expiry reached at the instant, never when open-ended", () => {
    expect(expiryReached({ nowMs: 10, expiresAtMs: 10 })).toBe(true);
    expect(expiryReached({ nowMs: 9, expiresAtMs: 10 })).toBe(false);
    expect(expiryReached({ nowMs: 10 ** 12, expiresAtMs: null })).toBe(false);
  });
  it("canRedeemNow and canVoid follow the state machine", () => {
    const open = { nowMs: 1, expiresAtMs: 10 };
    const over = { nowMs: 10, expiresAtMs: 10 };
    expect(canRedeemNow("ISSUED", open)).toBe(true);
    expect(canRedeemNow("DELIVERED", open)).toBe(true);
    expect(canRedeemNow("ISSUED", over)).toBe(false);
    expect(canRedeemNow("DELIVERED", over)).toBe(false);
    expect(canRedeemNow("REDEEMED", open)).toBe(false);
    expect(canRedeemNow("VOIDED", open)).toBe(false);
    expect(canRedeemNow("POT_OPEN", open)).toBe(false);
    expect(canVoid("ISSUED")).toBe(true);
    expect(canVoid("DELIVERED")).toBe(false);
    expect(canVoid("REDEEMED")).toBe(false);
    expect(canVoid("PENDING_PAYMENT")).toBe(false);
  });
  it("next applies guards from the expiry context and funded pots", () => {
    const open = { nowMs: 1, expiresAtMs: 10 };
    const over = { nowMs: 10, expiresAtMs: 10 };
    expect(next("ISSUED", "REDEEM", open)).toBe("REDEEMED");
    expect(() => next("ISSUED", "REDEEM", over)).toThrow();
    expect(next("ISSUED", "EXPIRE", over)).toBe("EXPIRED");
    expect(() => next("ISSUED", "EXPIRE", open)).toThrow();
    expect(() => next("POT_OPEN", "CLOSE_POT", open)).toThrow();
    expect(next("POT_OPEN", "CLOSE_POT", { ...open, potFunded: true })).toBe("ISSUED");
    expect(() => next("POT_OPEN", "CLOSE_POT", { ...open, potFunded: false })).toThrow();
    expect(next("CREATED", "START_CHECKOUT", open)).toBe("PENDING_PAYMENT");
    expect(next("ISSUED", "VOID", open)).toBe("VOIDED");
  });
});

describe("redemption throttle", () => {
  const NOW = 10_000_000_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const times = (n: number, from: number, step = 1) => Array.from({ length: n }, (_, i) => from + i * step);
  it("constants", () => {
    expect(REDEMPTION_THROTTLE).toEqual({
      accountFailures: 5,
      accountWindowMs: HOUR,
      deviceFailures: 20,
      deviceWindowMs: DAY,
      ipFailures: 50,
      ipWindowMs: DAY,
    });
  });
  it("the sixth wrong attempt in an hour is the first refusal; the right code works again once the oldest ages out", () => {
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: times(4, NOW - 100), deviceFailuresMs: [] })).toEqual({ allowed: true });
    const five = times(5, NOW - 100);
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: five, deviceFailuresMs: [] })).toEqual({
      allowed: false,
      scope: "account",
      retryAfterMs: five[0]! + HOUR - NOW,
    });
    // six failures: the pivot is the second-oldest, so the wait is measured from it
    const six = times(6, NOW - 100, 10);
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: six, deviceFailuresMs: [] })).toMatchObject({ retryAfterMs: six[1]! + HOUR - NOW });
    // unsorted input gives the same answer
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: [...six].reverse(), deviceFailuresMs: [] })).toMatchObject({ retryAfterMs: six[1]! + HOUR - NOW });
  });
  it("window edges: exactly one window ago is out, a future timestamp is ignored", () => {
    const old = Array.from({ length: 5 }, () => NOW - HOUR);
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: old, deviceFailuresMs: [] })).toEqual({ allowed: true });
    const edge = Array.from({ length: 5 }, () => NOW - HOUR + 1);
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: edge, deviceFailuresMs: [] })).toMatchObject({ allowed: false, retryAfterMs: 1 });
    const future = [...times(4, NOW - 100), NOW + 1];
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: future, deviceFailuresMs: [] })).toEqual({ allowed: true });
    const atNow = [...times(4, NOW - 100), NOW];
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: atNow, deviceFailuresMs: [] })).toMatchObject({ allowed: false });
  });
  it("account vs device precedence and retry times", () => {
    const acc = times(5, NOW - 100); // retry = HOUR - 100
    const devLong = times(20, NOW - 100); // retry = DAY - 100
    const devShort = times(20, NOW - DAY + 1000, 1); // retry ~ 1000
    const both = evaluateThrottle({ nowMs: NOW, accountFailuresMs: acc, deviceFailuresMs: devLong });
    // device wait (DAY - 100) is longer than the account wait (HOUR - 100): the longer wait is reported
    expect(both).toEqual({ allowed: false, scope: "device", retryAfterMs: devLong[0]! + DAY - NOW });
    const accWins = evaluateThrottle({ nowMs: NOW, accountFailuresMs: acc, deviceFailuresMs: devShort });
    expect(accWins).toEqual({ allowed: false, scope: "account", retryAfterMs: acc[0]! + HOUR - NOW });
    // equal waits: account is reported
    const tieNow = NOW;
    const accTie = Array.from({ length: 5 }, () => tieNow - 1000);
    const devTie = Array.from({ length: 20 }, () => tieNow - 1000 - (DAY - HOUR));
    const tie = evaluateThrottle({ nowMs: tieNow, accountFailuresMs: accTie, deviceFailuresMs: devTie });
    expect(tie).toEqual({ allowed: false, scope: "account", retryAfterMs: HOUR - 1000 });
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: [], deviceFailuresMs: devLong })).toEqual({
      allowed: false,
      scope: "device",
      retryAfterMs: devLong[0]! + DAY - NOW,
    });
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: [], deviceFailuresMs: times(19, NOW - 100) })).toEqual({ allowed: true });
  });
  it("ip limit applies only when account and device are clear", () => {
    const ip = times(50, NOW - 100);
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: [], deviceFailuresMs: [], ipFailuresMs: ip })).toEqual({
      allowed: false,
      scope: "ip",
      retryAfterMs: ip[0]! + DAY - NOW,
    });
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: [], deviceFailuresMs: [], ipFailuresMs: times(49, NOW - 100) })).toEqual({ allowed: true });
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: times(5, NOW - 100), deviceFailuresMs: [], ipFailuresMs: ip })).toMatchObject({ scope: "account" });
    expect(evaluateThrottle({ nowMs: NOW, accountFailuresMs: [], deviceFailuresMs: [] })).toEqual({ allowed: true });
  });
});
