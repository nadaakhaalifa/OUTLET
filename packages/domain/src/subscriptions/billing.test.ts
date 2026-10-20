import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addMonthsUtc,
  dunningAttemptKey,
  dunningAttemptTimes,
  graceEndsAt,
  nextDunningAction,
  periodEndFor,
  prorationCredit,
  recognitionDue,
  refundEligibility,
  upgradeCharge,
  yearlyMarketing,
} from "./billing";
import { DAY_MS } from "./types";

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
const EGP = (n: number): bigint => BigInt(n) * 100n;

describe("period math", () => {
  it("adds calendar months and clamps to month end", () => {
    expect(addMonthsUtc(Date.UTC(2026, 0, 31, 5), 1)).toBe(Date.UTC(2026, 1, 28, 5));
    expect(addMonthsUtc(Date.UTC(2028, 0, 31), 1)).toBe(Date.UTC(2028, 1, 29));
    expect(addMonthsUtc(Date.UTC(2026, 10, 30), 3)).toBe(Date.UTC(2027, 1, 28));
    expect(addMonthsUtc(Date.UTC(2026, 11, 15), 1)).toBe(Date.UTC(2027, 0, 15));
    expect(addMonthsUtc(Date.UTC(2026, 5, 15, 7, 8, 9, 10), 0)).toBe(Date.UTC(2026, 5, 15, 7, 8, 9, 10));
    expect(addMonthsUtc(Date.UTC(2026, 0, 15, 23, 59, 59, 999), 12)).toBe(Date.UTC(2027, 0, 15, 23, 59, 59, 999));
  });
  it("monthly is one month and yearly is twelve", () => {
    expect(periodEndFor(T0, "month")).toBe(Date.UTC(2026, 1, 1, 10));
    expect(periodEndFor(T0, "year")).toBe(Date.UTC(2027, 0, 1, 10));
  });
});

describe("prorationCredit", () => {
  const start = Date.UTC(2026, 5, 1);
  const end = start + 30 * DAY_MS;
  it("10 days into a 30 day period credits 20 unused days of 200 EGP", () => {
    const r = prorationCredit({ monthlyPriceMinor: EGP(200), periodStartMs: start, periodEndMs: end, nowMs: start + 10 * DAY_MS });
    expect(r).toEqual({ daysInPeriod: 30, unusedDays: 20, creditMinor: 13_333n });
  });
  it("counts whole unused days only", () => {
    const r = prorationCredit({ monthlyPriceMinor: EGP(200), periodStartMs: start, periodEndMs: end, nowMs: start + 10 * DAY_MS + 1 });
    expect(r.unusedDays).toBe(19);
  });
  it("full price at the start, zero at and after the end", () => {
    const at = (nowMs: number) => prorationCredit({ monthlyPriceMinor: EGP(200), periodStartMs: start, periodEndMs: end, nowMs }).creditMinor;
    expect(at(start)).toBe(EGP(200));
    expect(at(start - 5 * DAY_MS)).toBe(EGP(200));
    expect(at(end)).toBe(0n);
    expect(at(end + DAY_MS)).toBe(0n);
  });
  it("rounds half to even at the single rounding point", () => {
    // 50 piastres x 1 day / 4 days = 12.5 -> 12; 150 x 1 / 4 = 37.5 -> 38
    const p = (price: bigint) =>
      prorationCredit({ monthlyPriceMinor: price, periodStartMs: start, periodEndMs: start + 4 * DAY_MS, nowMs: start + 3 * DAY_MS }).creditMinor;
    expect(p(50n)).toBe(12n);
    expect(p(150n)).toBe(38n);
  });
  it("rejects degenerate periods and negative prices", () => {
    expect(() => prorationCredit({ monthlyPriceMinor: 1n, periodStartMs: start, periodEndMs: start, nowMs: start })).toThrow();
    expect(() => prorationCredit({ monthlyPriceMinor: 1n, periodStartMs: start, periodEndMs: start + DAY_MS * 0.4, nowMs: start })).toThrow();
    expect(() => prorationCredit({ monthlyPriceMinor: -1n, periodStartMs: start, periodEndMs: end, nowMs: start })).toThrow();
  });
  it("property: credit is within [0, price] and never grows as time passes", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.integer({ min: 28, max: 31 }),
        fc.integer({ min: 0, max: 40 * 24 }),
        fc.integer({ min: 0, max: 40 * 24 }),
        (price, days, h1, h2) => {
          const e = start + days * DAY_MS;
          const [a, b] = h1 <= h2 ? [h1, h2] : [h2, h1];
          const ca = prorationCredit({ monthlyPriceMinor: price, periodStartMs: start, periodEndMs: e, nowMs: start + a * 3_600_000 }).creditMinor;
          const cb = prorationCredit({ monthlyPriceMinor: price, periodStartMs: start, periodEndMs: e, nowMs: start + b * 3_600_000 }).creditMinor;
          expect(ca >= cb).toBe(true);
          expect(ca >= 0n && ca <= price).toBe(true);
        },
      ),
    );
  });
});

describe("upgradeCharge", () => {
  it("800 minus the credit, and the ledger sum is conserved", () => {
    const r = upgradeCharge(EGP(800), 13_333n);
    expect(r).toEqual({ creditAppliedMinor: 13_333n, chargeMinor: 66_667n });
    expect(r.creditAppliedMinor + r.chargeMinor).toBe(EGP(800));
  });
  it("caps the credit at the price and rejects negatives", () => {
    expect(upgradeCharge(100n, 500n)).toEqual({ creditAppliedMinor: 100n, chargeMinor: 0n });
    expect(upgradeCharge(100n, 100n)).toEqual({ creditAppliedMinor: 100n, chargeMinor: 0n });
    expect(() => upgradeCharge(-1n, 0n)).toThrow();
    expect(() => upgradeCharge(1n, -1n)).toThrow();
  });
});

describe("yearlyMarketing", () => {
  it("800 = 4 x 200, 8 months free, saving 1,600 EGP", () => {
    expect(yearlyMarketing(EGP(200), EGP(800))).toEqual({ payMonths: 4, freeMonths: 8, savingMinor: EGP(1600) });
  });
  it("rounds pay months up, never negative savings", () => {
    expect(yearlyMarketing(EGP(200), EGP(801)).payMonths).toBe(5);
    expect(yearlyMarketing(EGP(200), EGP(3000))).toEqual({ payMonths: 15, freeMonths: 0, savingMinor: 0n });
    expect(yearlyMarketing(EGP(200), EGP(2400))).toEqual({ payMonths: 12, freeMonths: 0, savingMinor: 0n });
    expect(() => yearlyMarketing(0n, 1n)).toThrow();
  });
});

describe("dunning", () => {
  const f = T0;
  it("retries at day 1, 3 and 7, grace ends at day 7", () => {
    expect(dunningAttemptTimes(f)).toEqual([f + DAY_MS, f + 3 * DAY_MS, f + 7 * DAY_MS]);
    expect(graceEndsAt(f)).toBe(f + 7 * DAY_MS);
    expect(dunningAttemptKey("s1", 3, 2)).toBe("sub:s1:cycle:3:attempt:2");
  });
  it("walks the schedule", () => {
    expect(nextDunningAction(f, 0, f)).toEqual({ kind: "wait", untilMs: f + DAY_MS });
    expect(nextDunningAction(f, 0, f + DAY_MS)).toEqual({ kind: "retry", attempt: 1, dueAtMs: f + DAY_MS });
    expect(nextDunningAction(f, 1, f + DAY_MS + 1)).toEqual({ kind: "wait", untilMs: f + 3 * DAY_MS });
    expect(nextDunningAction(f, 1, f + 3 * DAY_MS)).toEqual({ kind: "retry", attempt: 2, dueAtMs: f + 3 * DAY_MS });
    expect(nextDunningAction(f, 2, f + 7 * DAY_MS)).toEqual({ kind: "retry", attempt: 3, dueAtMs: f + 7 * DAY_MS });
    expect(nextDunningAction(f, 3, f + 7 * DAY_MS - 1)).toEqual({ kind: "wait", untilMs: f + 7 * DAY_MS });
    expect(nextDunningAction(f, 3, f + 7 * DAY_MS)).toEqual({ kind: "expire" });
  });
  it("expires without a late retry once the grace has passed", () => {
    expect(nextDunningAction(f, 0, f + 7 * DAY_MS + 1)).toEqual({ kind: "expire" });
    expect(nextDunningAction(f, 2, f + 7 * DAY_MS + 1)).toEqual({ kind: "expire" });
  });
});

describe("refundEligibility", () => {
  const charged = T0;
  const base = { chargedAtMs: charged, benefitUsedSinceCharge: false, alreadyRefunded: false };
  it("eligible 5 days after a charge with no benefit used", () => {
    expect(refundEligibility({ ...base, nowMs: charged + 5 * DAY_MS })).toEqual({ eligible: true });
  });
  it("boundary: exactly 14 days is eligible, one millisecond later is not", () => {
    expect(refundEligibility({ ...base, nowMs: charged + 14 * DAY_MS }).eligible).toBe(true);
    expect(refundEligibility({ ...base, nowMs: charged + 14 * DAY_MS + 1 })).toEqual({ eligible: false, reason: "window_elapsed" });
  });
  it("a used benefit or a prior refund blocks", () => {
    expect(refundEligibility({ ...base, nowMs: charged + DAY_MS, benefitUsedSinceCharge: true })).toEqual({ eligible: false, reason: "benefit_used" });
    expect(refundEligibility({ ...base, nowMs: charged + DAY_MS, alreadyRefunded: true })).toEqual({ eligible: false, reason: "already_refunded" });
  });
});

describe("recognitionDue", () => {
  it("one entry per elapsed month, capped, minus recognised", () => {
    const i = { periodStartMs: T0, periodsTotal: 12, periodsRecognised: 0 };
    expect(recognitionDue({ ...i, nowMs: T0 })).toBe(0);
    expect(recognitionDue({ ...i, nowMs: addMonthsUtc(T0, 1) - 1 })).toBe(0);
    expect(recognitionDue({ ...i, nowMs: addMonthsUtc(T0, 1) })).toBe(1);
    expect(recognitionDue({ ...i, nowMs: addMonthsUtc(T0, 5), periodsRecognised: 2 })).toBe(3);
    expect(recognitionDue({ ...i, nowMs: addMonthsUtc(T0, 30) })).toBe(12);
    expect(recognitionDue({ ...i, nowMs: addMonthsUtc(T0, 30), periodsRecognised: 12 })).toBe(0);
    expect(recognitionDue({ periodStartMs: T0, periodsTotal: 1, periodsRecognised: 0, nowMs: addMonthsUtc(T0, 1) })).toBe(1);
  });
});
