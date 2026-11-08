import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MoneyError, add, allocate, compare, equals, money, moneySchema, negate, fraction, percentOf, roundHalfEven, sub, toWire } from "../src/index.js";

const egp = (n: bigint) => money(n, "EGP");
const amount = fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n });
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof MoneyError ? error.code : "OTHER";
  }
  return undefined;
};

describe("roundHalfEven", () => {
  it.each([
    [5n, 2n, 2n], [7n, 2n, 4n], [-5n, 2n, -2n], [-7n, 2n, -4n], [1n, 3n, 0n], [2n, 3n, 1n], [15n, 10n, 2n], [25n, 10n, 2n],
  ])("%s / %s = %s", (n, d, expected) => {
    expect(roundHalfEven(n, d)).toBe(expected);
  });
  it("rejects non-positive denominators", () => {
    expect(codeOf(() => roundHalfEven(1n, 0n))).toBe("INVALID_DIVISOR");
    expect(codeOf(() => roundHalfEven(1n, -2n))).toBe("INVALID_DIVISOR");
  });
  it("is within half a unit of the exact value, is odd-symmetric, and exact on multiples", () => {
    fc.assert(
      fc.property(amount, fc.bigInt({ min: 1n, max: 100_000n }), (n, d) => {
        const r = roundHalfEven(n, d);
        expect(2n * (n - r * d) <= d && 2n * (r * d - n) <= d).toBe(true);
        expect(roundHalfEven(-n, d)).toBe(-r);
        expect(roundHalfEven(n * d, d)).toBe(n);
      }),
    );
  });
  it("ties go to even", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -100_000n, max: 100_000n }), (k) => {
        expect(roundHalfEven(2n * k + 1n, 2n) % 2n === 0n).toBe(true);
      }),
    );
  });
});

describe("add / sub / compare", () => {
  it("add and sub are inverse", () => {
    fc.assert(
      fc.property(amount, amount, (a, b) => {
        expect(equals(sub(add(egp(a), egp(b)), egp(b)), egp(a))).toBe(true);
        expect(equals(add(sub(egp(a), egp(b)), egp(b)), egp(a))).toBe(true);
      }),
    );
  });
  it("compare is consistent with bigint order and negate flips it", () => {
    fc.assert(
      fc.property(amount, amount, (a, b) => {
        const expected = a === b ? 0 : a < b ? -1 : 1;
        expect(compare(egp(a), egp(b))).toBe(expected);
        // `-0` is not `0` under Object.is, so negate the sign explicitly.
        expect(compare(negate(egp(a)), negate(egp(b)))).toBe(expected === 0 ? 0 : -expected);
      }),
    );
  });
  it("rejects mixed currencies with a typed error", () => {
    const usd = money(1n, "USD");
    expect(codeOf(() => add(egp(1n), usd))).toBe("CURRENCY_MISMATCH");
    expect(codeOf(() => sub(egp(1n), usd))).toBe("CURRENCY_MISMATCH");
    expect(codeOf(() => compare(egp(1n), usd))).toBe("CURRENCY_MISMATCH");
    expect(equals(egp(1n), usd)).toBe(false);
  });
  it("rejects bad construction input", () => {
    expect(codeOf(() => money(1 as unknown as bigint, "EGP"))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => money(1n, "XXX" as unknown as "EGP"))).toBe("UNKNOWN_CURRENCY");
  });
});

describe("percentOf", () => {
  it("applies 14% VAT in bps with half-even rounding", () => {
    expect(percentOf(egp(10_000n), 1400n).amountMinor).toBe(1400n);
    expect(percentOf(egp(1n), 5000n).amountMinor).toBe(0n); // 0.5 -> 0
    expect(percentOf(egp(3n), 5000n).amountMinor).toBe(2n); // 1.5 -> 2
    expect(percentOf(egp(-3n), 5000n).amountMinor).toBe(-2n);
  });
  it("rejects negative bps", () => {
    expect(codeOf(() => percentOf(egp(1n), -1n))).toBe("INVALID_BPS");
  });
  it("0 bps is zero and 10000 bps is identity", () => {
    fc.assert(
      fc.property(amount, (a) => {
        expect(percentOf(egp(a), 0n).amountMinor).toBe(0n);
        expect(percentOf(egp(a), 10_000n).amountMinor).toBe(a);
      }),
    );
  });
});

describe("fraction", () => {
  it("extracts VAT from a VAT-inclusive price with one rounding", () => {
    expect(fraction(egp(6000n), 1400n, 11400n).amountMinor).toBe(737n);
  });
  it("rejects bad numerator/denominator", () => {
    expect(codeOf(() => fraction(egp(1n), -1n, 10n))).toBe("INVALID_BPS");
    expect(codeOf(() => fraction(egp(1n), 1n, 0n))).toBe("INVALID_DIVISOR");
  });
});

describe("ledger fixtures", () => {
  it.each([
    [89_950n, 1500n, 13_492n],
    [59_950n, 1500n, 8_992n],
    [10_003n, 1500n, 1_500n],
    [2_625n, 1400n, 368n],
    [13_492n, 1400n, 1_889n],
  ])("percentOf(%s, %s bps) = %s", (v, bps, expected) => {
    expect(percentOf(egp(v), bps).amountMinor).toBe(expected);
  });
  it("allocates the 10,000 voucher over A/B/C", () => {
    expect(allocate(egp(10_000n), [249_900n, 89_950n, 45_000n]).map((p) => p.amountMinor)).toEqual([6_494n, 2_337n, 1_169n]);
  });
  it("allocates 1,000,000 over 12 equal parts", () => {
    const parts = allocate(egp(1_000_000n), Array<bigint>(12).fill(1n)).map((p) => p.amountMinor);
    expect(parts).toEqual([...Array<bigint>(4).fill(83_334n), ...Array<bigint>(8).fill(83_333n)]);
  });
  it("allocate(negate(t)) is the negation of allocate(t)", () => {
    fc.assert(
      fc.property(amount, fc.array(fc.bigInt({ min: 1n, max: 1000n }), { minLength: 1, maxLength: 8 }), (a, r) => {
        const neg = allocate(negate(egp(a)), r).map((p) => p.amountMinor);
        expect(neg).toEqual(allocate(egp(a), r).map((p) => -p.amountMinor));
      }),
    );
  });
});

describe("allocate", () => {
  const ratios = fc.array(fc.bigInt({ min: 0n, max: 1000n }), { minLength: 1, maxLength: 12 }).filter((r) => r.some((x) => x > 0n));
  it("parts sum exactly to the total and keep the currency", () => {
    fc.assert(
      fc.property(amount, ratios, (a, r) => {
        const parts = allocate(egp(a), r);
        expect(parts).toHaveLength(r.length);
        expect(parts.reduce((s, p) => s + p.amountMinor, 0n)).toBe(a);
        expect(parts.every((p) => p.currency === "EGP")).toBe(true);
      }),
    );
  });
  it("is deterministic, gives zero ratios zero, and is within one unit of the exact share", () => {
    fc.assert(
      fc.property(amount, ratios, (a, r) => {
        const parts = allocate(egp(a), r);
        expect(allocate(egp(a), r)).toEqual(parts);
        const sum = r.reduce((s, x) => s + x, 0n);
        r.forEach((ratio, i) => {
          const part = parts[i]?.amountMinor ?? 0n;
          if (ratio === 0n) expect(part).toBe(0n);
          const diff = part * sum - a * ratio;
          expect((diff < 0n ? -diff : diff) < sum).toBe(true);
        });
      }),
    );
  });
  it("ties go to the earliest index", () => {
    expect(allocate(egp(100n), [1n, 1n, 1n]).map((p) => p.amountMinor)).toEqual([34n, 33n, 33n]);
    expect(allocate(egp(-100n), [1n, 1n, 1n]).map((p) => p.amountMinor)).toEqual([-34n, -33n, -33n]);
    expect(allocate(egp(1n), [1n, 1n]).map((p) => p.amountMinor)).toEqual([1n, 0n]);
  });
  it("rejects empty, negative and all-zero ratios", () => {
    expect(codeOf(() => allocate(egp(1n), []))).toBe("INVALID_RATIOS");
    expect(codeOf(() => allocate(egp(1n), [-1n, 2n]))).toBe("INVALID_RATIOS");
    expect(codeOf(() => allocate(egp(1n), [0n, 0n]))).toBe("INVALID_RATIOS");
  });
});

describe("wire format", () => {
  it("round-trips through the Zod schema", () => {
    fc.assert(
      fc.property(amount, (a) => {
        const parsed = moneySchema.parse(toWire(egp(a)));
        expect(parsed.amountMinor).toBe(a);
        expect(parsed.currency).toBe("EGP");
      }),
    );
  });
  it("rejects numbers, floats and bad currencies at the boundary", () => {
    expect(moneySchema.safeParse({ amountMinor: 100, currency: "EGP" }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMinor: "1.5", currency: "EGP" }).success).toBe(false);
    for (const bad of ["+5", " 5", "1e3", "", "-", "٥", "1.5", "100000000000000000000", "9223372036854775808", "-9223372036854775809"]) {
      expect(moneySchema.safeParse({ amountMinor: bad, currency: "EGP" }).success, bad).toBe(false);
    }
    for (const ok of ["-0", "0", "123", "9223372036854775807", "-9223372036854775808"]) {
      expect(moneySchema.safeParse({ amountMinor: ok, currency: "EGP" }).success, ok).toBe(true);
    }
    expect(moneySchema.safeParse({ amountMinor: "10", currency: "XXX" }).success).toBe(false);
  });
});
