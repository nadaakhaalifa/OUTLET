import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CurrencyMismatchError, InvalidAmountError } from "./errors";
import {
  add,
  allocate,
  compare,
  divideRoundHalfEven,
  money,
  multiplyRatio,
  negate,
  percentOfBps,
  subtract,
  type Money,
} from "./money";

const sum = (parts: Money[]): bigint => parts.reduce((s, p) => s + p.amount, 0n);
const amountArb = fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n });

describe("divideRoundHalfEven", () => {
  it.each([
    [5n, 2n, 2n], // 2.5 -> 2 (even)
    [7n, 2n, 4n], // 3.5 -> 4 (even)
    [-5n, 2n, -2n],
    [-7n, 2n, -4n],
    [1n, 3n, 0n],
    [2n, 3n, 1n],
    [-2n, 3n, -1n],
    [10n, 5n, 2n],
    [5n, -2n, -2n],
  ])("%s / %s = %s", (n, d, expected) => {
    expect(divideRoundHalfEven(n, d)).toBe(expected);
  });

  it("rejects division by zero", () => {
    expect(() => divideRoundHalfEven(1n, 0n)).toThrow(InvalidAmountError);
  });

  it("is within half a unit of the exact quotient", () => {
    fc.assert(
      fc.property(amountArb, fc.bigInt({ min: 1n, max: 10_000n }), (n, d) => {
        const q = divideRoundHalfEven(n, d);
        const diff2 = (n - q * d) * 2n;
        const abs = diff2 < 0n ? -diff2 : diff2;
        expect(abs <= d).toBe(true);
      }),
    );
  });
});

describe("money arithmetic", () => {
  it("adds and subtracts exactly", () => {
    expect(add(money(150n), money(275n)).amount).toBe(425n);
    expect(subtract(money(150n), money(275n)).amount).toBe(-125n);
    expect(negate(money(5n)).amount).toBe(-5n);
  });

  it("is associative and commutative", () => {
    fc.assert(
      fc.property(amountArb, amountArb, amountArb, (a, b, c) => {
        const [x, y, z] = [money(a), money(b), money(c)] as const;
        expect(add(add(x, y), z)).toEqual(add(x, add(y, z)));
        expect(add(x, y)).toEqual(add(y, x));
      }),
    );
  });

  it("refuses to mix currencies", () => {
    const usd = { amount: 1n, currency: "USD" } as unknown as Money;
    expect(() => add(money(1n), usd)).toThrow(CurrencyMismatchError);
    expect(() => compare(money(1n), usd)).toThrow(CurrencyMismatchError);
  });

  it("applies percentages in basis points: 14% VAT on 230.00 EGP is 32.20 EGP", () => {
    expect(percentOfBps(money(23_000n), 1_400n).amount).toBe(3_220n);
  });

  it("rounds a ratio once, at the end", () => {
    // 1/3 of 100 piastres twice would lose a piastre; one multiplication does not.
    expect(multiplyRatio(money(100n), 2n, 3n).amount).toBe(67n);
  });
});

describe("allocate", () => {
  it("splits evenly when divisible", () => {
    expect(allocate(money(900n), [1n, 1n, 1n]).map((m) => m.amount)).toEqual([300n, 300n, 300n]);
  });

  it("gives leftover units to the largest remainders, ties to the lower index", () => {
    expect(allocate(money(100n), [1n, 1n, 1n]).map((m) => m.amount)).toEqual([34n, 33n, 33n]);
    expect(allocate(money(5n), [1n, 1n]).map((m) => m.amount)).toEqual([3n, 2n]);
  });

  it("never gives a unit to a zero-weight part", () => {
    expect(allocate(money(7n), [0n, 1n, 1n]).map((m) => m.amount)).toEqual([0n, 4n, 3n]);
  });

  it("mirrors negative totals exactly", () => {
    const charge = allocate(money(100n), [1n, 2n, 3n]).map((m) => m.amount);
    const refund = allocate(money(-100n), [1n, 2n, 3n]).map((m) => m.amount);
    expect(refund).toEqual(charge.map((a) => -a));
  });

  it("rejects invalid weights", () => {
    expect(() => allocate(money(10n), [])).toThrow(InvalidAmountError);
    expect(() => allocate(money(10n), [0n, 0n])).toThrow(InvalidAmountError);
    expect(() => allocate(money(10n), [1n, -1n])).toThrow(InvalidAmountError);
  });

  it("always sums exactly to the total", () => {
    fc.assert(
      fc.property(
        amountArb,
        fc.array(fc.bigInt({ min: 0n, max: 1_000n }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          fc.pre(weights.some((w) => w > 0n));
          expect(sum(allocate(money(total), weights))).toBe(total);
        },
      ),
    );
  });

  it("keeps every part within one unit of its exact proportional share", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.array(fc.bigInt({ min: 1n, max: 1_000n }), { minLength: 1, maxLength: 10 }),
        (total, weights) => {
          const parts = allocate(money(total), weights);
          const weightSum = weights.reduce((s, w) => s + w, 0n);
          parts.forEach((p, i) => {
            const exactTimesSum = total * (weights[i] ?? 0n);
            const lower = exactTimesSum / weightSum;
            expect(p.amount === lower || p.amount === lower + 1n).toBe(true);
          });
        },
      ),
    );
  });
});
