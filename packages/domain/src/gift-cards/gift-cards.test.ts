import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CODE_LENGTH,
  CROCKFORD,
  GIFT_CARD_LIMITS,
  REDEMPTION_THROTTLE,
  canSpendCreditOn,
  canVoid,
  checkAmount,
  checkContribution,
  closeOutcome,
  evaluateThrottle,
  expiryFrom,
  formatCode,
  generateCode,
  last4,
  next,
  normalizeCode,
  paidTotal,
  planRedemption,
  potMachine,
  redemptionView,
  refundPlan,
  requiredMinimumAge,
  requiresThreeDs,
  type ContributionFacts,
} from "./index";

const bytes = fc.uint8Array({ minLength: 13, maxLength: 32 });

describe("codes", () => {
  it("are 20 Crockford characters, never ambiguous symbols, and survive display formatting", () => {
    fc.assert(
      fc.property(bytes, (b) => {
        const code = generateCode(() => b);
        expect(code).toHaveLength(CODE_LENGTH);
        expect([...code].every((c) => CROCKFORD.includes(c))).toBe(true);
        expect(code).not.toMatch(/[ILOU]/);
        expect(normalizeCode(formatCode(code))).toBe(code);
        expect(normalizeCode(formatCode(code).toLowerCase())).toBe(code);
        expect(last4(code)).toBe(code.slice(-4));
      }),
    );
  });

  it("are unique for distinct random inputs of the same length (injective encoding)", () => {
    fc.assert(
      fc.property(bytes, bytes, (a, b) => {
        const ca = generateCode(() => a);
        const cb = generateCode(() => b);
        // 100 of the 104 bits are used: only the low 4 bits of byte 12 and later bytes are ignored
        const sameBits = a.slice(0, 12).every((v, i) => v === b[i]) && (a[12] ?? 0) >> 4 === (b[12] ?? 0) >> 4;
        expect(ca === cb).toBe(sameBits);
      }),
    );
  });

  it("reads I and L as 1, O as 0, and rejects short, long or foreign input", () => {
    const base = "0123456789ABCDEFGHJK".replace("0", "O").replace("1", "I");
    expect(normalizeCode(base)).toBe("0123456789ABCDEFGHJK");
    expect(normalizeCode("")).toBeNull();
    expect(normalizeCode("ABCD")).toBeNull();
    expect(normalizeCode("U".repeat(20))).toBeNull();
    expect(normalizeCode("A".repeat(40))).toBeNull();
  });
});

describe("amount, age, 3-DS and expiry rules", () => {
  it("enforces 100 to 10,000 EGP in whole pounds", () => {
    expect(checkAmount(9_900n)).toEqual({ ok: false, reason: "below_min" });
    expect(checkAmount(10_000n)).toEqual({ ok: true });
    expect(checkAmount(1_000_000n)).toEqual({ ok: true });
    expect(checkAmount(1_000_100n)).toEqual({ ok: false, reason: "above_max" });
    expect(checkAmount(10_050n)).toEqual({ ok: false, reason: "not_whole_egp" });
  });

  it("needs 21+ strictly above 5,000 EGP and 3-DS strictly above 2,000 EGP on a new card", () => {
    expect(requiredMinimumAge(500_000n)).toBe(18);
    expect(requiredMinimumAge(500_100n)).toBe(21);
    expect(requiresThreeDs(200_000n, true)).toBe(false);
    expect(requiresThreeDs(200_100n, true)).toBe(true);
    expect(requiresThreeDs(300_000n, false)).toBe(false);
  });

  it("expires exactly three calendar years later and rolls 29 February back", () => {
    expect(expiryFrom(Date.UTC(2026, 9, 11, 12))).toBe(Date.UTC(2029, 9, 11, 12));
    expect(expiryFrom(Date.UTC(2028, 1, 29))).toBe(Date.UTC(2031, 1, 28));
  });

  it("refuses to pay for another gift card or Plus", () => {
    expect(canSpendCreditOn("gift_card")).toBe(false);
    expect(canSpendCreditOn("plus")).toBe(false);
    expect(canSpendCreditOn("merchandise")).toBe(true);
  });
});

describe("state machine wiring", () => {
  const live = { nowMs: 10, expiresAtMs: 100 };
  it("redeems before expiry, refuses after, voids only from ISSUED", () => {
    expect(next("DELIVERED", "REDEEM", live)).toBe("REDEEMED");
    expect(() => next("DELIVERED", "REDEEM", { nowMs: 100, expiresAtMs: 100 })).toThrow();
    expect(next("ISSUED", "VOID", live)).toBe("VOIDED");
    expect(canVoid("ISSUED")).toBe(true);
    expect(canVoid("DELIVERED")).toBe(false);
  });
});

describe("partial redemption conservation", () => {
  it("sum of redemptions plus remaining equals face value, and REDEEMED only at zero", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10_000 }),
        fc.array(fc.option(fc.integer({ min: 1, max: 12_000 }), { nil: null }), { maxLength: 12 }),
        (egp, requests) => {
          const face = BigInt(egp) * 100n;
          let remaining = face;
          let redeemed = 0n;
          for (const r of requests) {
            const plan = planRedemption(remaining, r === null ? null : BigInt(r) * 100n);
            if (!plan.ok) continue;
            redeemed += plan.amount;
            remaining = plan.remainingAfter;
            expect(plan.full).toBe(remaining === 0n);
            expect(redeemed + remaining).toBe(face);
          }
          expect(redemptionView(face, remaining)).toBe(remaining === 0n ? "full" : remaining < face ? "partial" : "none");
        },
      ),
    );
  });

  it("rejects zero, negative, over-balance and exhausted", () => {
    expect(planRedemption(100n, 0n)).toEqual({ ok: false, reason: "invalid_amount" });
    expect(planRedemption(100n, -1n)).toEqual({ ok: false, reason: "invalid_amount" });
    expect(planRedemption(100n, 101n)).toEqual({ ok: false, reason: "exceeds_balance" });
    expect(planRedemption(0n, null)).toEqual({ ok: false, reason: "nothing_left" });
  });
});

describe("throttle windows", () => {
  const H = REDEMPTION_THROTTLE.accountWindowMs;
  it("blocks the 6th attempt inside the hour and frees it when the oldest failure slides out", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 7_200_000 }), { maxLength: 30 }), fc.integer({ min: 0, max: 7_200_000 }), (times, now) => {
        const past = times.filter((t) => t <= now);
        const d = evaluateThrottle({ nowMs: now, accountFailuresMs: past, deviceFailuresMs: [] });
        const inWindow = past.filter((t) => t > now - H).length;
        expect(d.allowed).toBe(inWindow < REDEMPTION_THROTTLE.accountFailures);
        if (!d.allowed) {
          // exactly at the retry instant the window has room again
          const later = evaluateThrottle({ nowMs: now + d.retryAfterMs, accountFailuresMs: past, deviceFailuresMs: [] });
          expect(later.allowed).toBe(true);
          expect(d.retryAfterMs).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("applies the 20 per day device limit independently of the account", () => {
    const now = 100_000_000;
    const device = Array.from({ length: 20 }, (_, i) => now - 1000 * (i + 1));
    const d = evaluateThrottle({ nowMs: now, accountFailuresMs: [], deviceFailuresMs: device });
    expect(d).toMatchObject({ allowed: false, scope: "device" });
    expect(evaluateThrottle({ nowMs: now, accountFailuresMs: [], deviceFailuresMs: device.slice(1) }).allowed).toBe(true);
  });
});

describe("group pot", () => {
  it("machine has no unreachable state and no dead end", () => {
    expect(potMachine.analyze().ok).toBe(true);
  });

  it("closes funded or unfunded and never earlier than its date unless funded", () => {
    expect(closeOutcome({ target: 100n, paid: 100n, closesAtMs: 10, nowMs: 0 })).toBe("funded");
    expect(closeOutcome({ target: 100n, paid: 50n, closesAtMs: 10, nowMs: 5 })).toBe("stay_open");
    expect(closeOutcome({ target: 100n, paid: 50n, closesAtMs: 10, nowMs: 10 })).toBe("unfunded");
  });

  it("limits contributions to the missing amount and the 50 EGP minimum", () => {
    expect(checkContribution(100_000n, 0n, 4_900n)).toEqual({ ok: false, reason: "below_min" });
    expect(checkContribution(100_000n, 0n, 5_000n)).toEqual({ ok: true });
    expect(checkContribution(100_000n, 98_000n, 2_000n)).toEqual({ ok: true });
    expect(checkContribution(100_000n, 98_000n, 3_000n)).toEqual({ ok: false, reason: "exceeds_target" });
  });

  it("refund plan returns exactly what was paid, to each payer", () => {
    const status = fc.constantFrom<ContributionFacts["status"]>("pending", "paid", "cancelled", "refunded", "refund_failed");
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.uuid(), amount: fc.integer({ min: 50, max: 10_000 }).map((n) => BigInt(n) * 100n), status }), { maxLength: 40 }),
        (cs) => {
          const plan = refundPlan(cs);
          const owed = cs.filter((c) => c.status === "paid" || c.status === "refund_failed").reduce((s, c) => s + c.amount, 0n);
          expect(plan.total).toBe(owed);
          expect(plan.refunds.reduce((s, c) => s + c.amount, 0n)).toBe(plan.total);
          expect(paidTotal(cs)).toBeLessThanOrEqual(plan.total);
          for (const r of plan.refunds) expect(["paid", "refund_failed"]).toContain(r.status);
        },
      ),
    );
  });

  it("limits stay within the spec", () => {
    expect(GIFT_CARD_LIMITS.minAmount).toBe(10_000n);
  });
});

describe("ip throttle window", () => {
  it("blocks on the per-ip window when account and device are quiet", () => {
    const now = 1_000_000_000;
    const ip = Array.from({ length: REDEMPTION_THROTTLE.ipFailures }, (_, i) => now - 1000 * (i + 1));
    expect(evaluateThrottle({ nowMs: now, accountFailuresMs: [], deviceFailuresMs: [], ipFailuresMs: ip })).toMatchObject({
      allowed: false,
      scope: "ip",
    });
    expect(evaluateThrottle({ nowMs: now, accountFailuresMs: [], deviceFailuresMs: [], ipFailuresMs: ip.slice(1) }).allowed).toBe(true);
  });
});
