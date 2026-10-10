import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CurrencyMismatchError, DomainError, InvalidAmountError } from "./errors";
import {
  add,
  allocate,
  compare,
  divideRoundHalfEven,
  equals,
  isZero,
  money,
  multiplyRatio,
  negate,
  percentOfBps,
  subtract,
  type Money,
} from "./money";

const usd = (amount: bigint): Money => ({ amount, currency: "USD" }) as unknown as Money;

describe("money()", () => {
  it("defaults to EGP and keeps the amount exactly", () => {
    expect(money(5n)).toEqual({ amount: 5n, currency: "EGP" });
    expect(money(-123_456_789_012_345_678_901n).amount).toBe(-123_456_789_012_345_678_901n);
  });

  it("refuses non-bigint amounts (floats and numbers) at runtime", () => {
    const bad = 5 as unknown as bigint;
    expect(() => money(bad)).toThrow(InvalidAmountError);
    expect(() => money(bad)).toThrow("amount must be a bigint");
    expect(() => money(1.5 as unknown as bigint)).toThrow(InvalidAmountError);
    expect(() => money("5" as unknown as bigint)).toThrow(InvalidAmountError);
  });
});

describe("error type hierarchy", () => {
  it("names errors after their class and extends DomainError", () => {
    const e = new InvalidAmountError("x");
    expect(e).toBeInstanceOf(DomainError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("InvalidAmountError");
    expect(e.message).toBe("x");
    expect(new CurrencyMismatchError("y").name).toBe("CurrencyMismatchError");
  });
});

describe("currency guard", () => {
  it("reports both currencies in the message for add, subtract and compare", () => {
    const msg = "cannot combine EGP with USD";
    expect(() => add(money(1n), usd(1n))).toThrow(msg);
    expect(() => subtract(money(1n), usd(1n))).toThrow(msg);
    expect(() => compare(money(1n), usd(1n))).toThrow(msg);
    expect(() => subtract(money(1n), usd(1n))).toThrow(CurrencyMismatchError);
    expect(() => add(usd(1n), money(1n))).toThrow("cannot combine USD with EGP");
  });

  it("preserves currency through arithmetic", () => {
    expect(add(money(1n), money(2n)).currency).toBe("EGP");
    expect(subtract(money(1n), money(2n)).currency).toBe("EGP");
    expect(negate(money(1n)).currency).toBe("EGP");
    expect(multiplyRatio(money(1n), 1n, 1n).currency).toBe("EGP");
    expect(percentOfBps(money(1n), 1n).currency).toBe("EGP");
  });
});

describe("isZero / equals / compare / negate", () => {
  it("isZero is true only for zero", () => {
    expect(isZero(money(0n))).toBe(true);
    expect(isZero(money(1n))).toBe(false);
    expect(isZero(money(-1n))).toBe(false);
    expect(isZero(negate(money(0n)))).toBe(true);
  });

  it("equals requires both currency and amount to match", () => {
    expect(equals(money(5n), money(5n))).toBe(true);
    expect(equals(money(5n), money(6n))).toBe(false);
    expect(equals(money(6n), money(5n))).toBe(false);
    expect(equals(money(5n), usd(5n))).toBe(false);
    expect(equals(usd(5n), usd(6n))).toBe(false);
    expect(equals(usd(5n), usd(5n))).toBe(true);
  });

  it("compare returns -1, 0 and 1", () => {
    expect(compare(money(1n), money(2n))).toBe(-1);
    expect(compare(money(2n), money(1n))).toBe(1);
    expect(compare(money(2n), money(2n))).toBe(0);
    expect(compare(money(-3n), money(-2n))).toBe(-1);
    expect(compare(money(0n), money(0n))).toBe(0);
  });

  it("subtract and negate are consistent", () => {
    expect(subtract(money(10n), money(3n)).amount).toBe(7n);
    expect(subtract(money(3n), money(10n)).amount).toBe(-7n);
    expect(negate(money(-4n)).amount).toBe(4n);
    expect(negate(money(0n)).amount).toBe(0n);
  });
});

describe("divideRoundHalfEven", () => {
  // [numerator, denominator, expected]; every sign combination at .5 ties and off-tie values.
  it.each([
    [1n, 2n, 0n],
    [3n, 2n, 2n],
    [5n, 2n, 2n],
    [7n, 2n, 4n],
    [-1n, 2n, 0n],
    [-3n, 2n, -2n],
    [-5n, 2n, -2n],
    [-7n, 2n, -4n],
    [1n, -2n, 0n],
    [3n, -2n, -2n],
    [5n, -2n, -2n],
    [7n, -2n, -4n],
    [-1n, -2n, 0n],
    [-3n, -2n, 2n],
    [-5n, -2n, 2n],
    [-7n, -2n, 4n],
    [25n, 10n, 2n],
    [35n, 10n, 4n],
    [-25n, 10n, -2n],
    [-35n, 10n, -4n],
    [26n, 10n, 3n],
    [24n, 10n, 2n],
    [-26n, 10n, -3n],
    [-24n, 10n, -2n],
    [26n, -10n, -3n],
    [-26n, -10n, 3n],
    [-24n, -10n, 2n],
    [24n, -10n, -2n],
    [2n, 3n, 1n],
    [1n, 3n, 0n],
    [-2n, 3n, -1n],
    [-1n, 3n, 0n],
    [2n, -3n, -1n],
    [-2n, -3n, 1n],
    [-7n, -3n, 2n],
    [0n, 5n, 0n],
    [0n, -5n, 0n],
    [10n, 5n, 2n],
    [-10n, 5n, -2n],
    [10n, -5n, -2n],
    [-10n, -5n, 2n],
    [1n, 1n, 1n],
    [-1n, 1n, -1n],
    [1n, -1n, -1n],
    [-1n, -1n, 1n],
  ])("%s / %s = %s", (n, d, expected) => {
    expect(divideRoundHalfEven(n, d)).toBe(expected);
  });

  it("rejects a zero denominator with the documented message", () => {
    expect(() => divideRoundHalfEven(1n, 0n)).toThrow("division by zero");
    expect(() => divideRoundHalfEven(0n, 0n)).toThrow(InvalidAmountError);
  });

  it("matches an independent exact-rational reference for every sign combination", () => {
    const reference = (n: bigint, d: bigint): bigint => {
      // floor-based round-half-even on |n|/|d|, then apply the sign.
      const an = n < 0n ? -n : n;
      const ad = d < 0n ? -d : d;
      let q = an / ad;
      const twice = (an % ad) * 2n;
      if (twice > ad || (twice === ad && q % 2n === 1n)) q += 1n;
      return n < 0n !== d < 0n ? -q : q;
    };
    fc.assert(
      fc.property(
        fc.bigInt({ min: -100_000n, max: 100_000n }),
        fc.bigInt({ min: -500n, max: 500n }).filter((d) => d !== 0n),
        (n, d) => {
          expect(divideRoundHalfEven(n, d)).toBe(reference(n, d));
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("multiplyRatio and percentOfBps", () => {
  it("multiplies before dividing and rounds half-even exactly once", () => {
    expect(multiplyRatio(money(100n), 2n, 3n).amount).toBe(67n);
    expect(multiplyRatio(money(5n), 1n, 2n).amount).toBe(2n); // 2.5 -> 2
    expect(multiplyRatio(money(7n), 1n, 2n).amount).toBe(4n); // 3.5 -> 4
    expect(multiplyRatio(money(-5n), 1n, 2n).amount).toBe(-2n);
    expect(multiplyRatio(money(-7n), 1n, 2n).amount).toBe(-4n);
    expect(multiplyRatio(money(10n), 3n, 1n).amount).toBe(30n);
    expect(() => multiplyRatio(money(1n), 1n, 0n)).toThrow(InvalidAmountError);
  });

  it("applies basis points: 10_000 bps is 100%, 1 bp of 10_000 is 1", () => {
    expect(percentOfBps(money(12_345n), 10_000n).amount).toBe(12_345n);
    expect(percentOfBps(money(10_000n), 1n).amount).toBe(1n);
    expect(percentOfBps(money(12_345n), 0n).amount).toBe(0n);
    expect(percentOfBps(money(5n), 5_000n).amount).toBe(2n); // 2.5 -> 2
    expect(percentOfBps(money(15n), 5_000n).amount).toBe(8n); // 7.5 -> 8
    expect(percentOfBps(money(-15n), 5_000n).amount).toBe(-8n);
    expect(percentOfBps(money(23_000n), 1_400n).amount).toBe(3_220n);
  });
});

describe("allocate", () => {
  const amounts = (total: bigint, weights: bigint[]): bigint[] =>
    allocate(money(total), weights).map((m) => m.amount);

  it("rejects bad weight lists with the documented messages", () => {
    expect(() => allocate(money(10n), [])).toThrow("allocate needs at least one weight");
    expect(() => allocate(money(10n), [1n, -1n])).toThrow("weights must not be negative");
    expect(() => allocate(money(10n), [-1n, 5n])).toThrow("weights must not be negative");
    expect(() => allocate(money(10n), [0n, 0n])).toThrow("at least one weight must be positive");
    expect(() => allocate(money(10n), [0n])).toThrow(InvalidAmountError);
  });

  it("gives the leftover to the largest remainder even when it sits at a later index", () => {
    // 10 * [1,2,3] / 6 = 1.67, 3.33, 5.0 -> floors 1,3,5 leftover 1; remainders 4,2,0 -> index 0
    expect(amounts(10n, [1n, 2n, 3n])).toEqual([2n, 3n, 5n]);
    // 1 * [1,2] / 3: remainders 1,2 -> the single unit goes to index 1
    expect(amounts(1n, [1n, 2n])).toEqual([0n, 1n]);
    // 2 * [1,1,2] / 4 = 0.5,0.5,1 -> floors 0,0,1 leftover 1; tie between 0 and 1 -> lower index
    expect(amounts(2n, [1n, 1n, 2n])).toEqual([1n, 0n, 1n]);
    // 5 * [3,3,4] / 10 = 1.5, 1.5, 2 -> floors 1,1,2 leftover 1 -> tie 0 vs 1 -> index 0
    expect(amounts(5n, [3n, 3n, 4n])).toEqual([2n, 1n, 2n]);
    // 7 * [1,1,1,1,1,1,1,1] / 8: floors 0, leftover 7, all tie -> first seven indices
    expect(amounts(7n, [1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n])).toEqual([1n, 1n, 1n, 1n, 1n, 1n, 1n, 0n]);
  });

  it("distributes remainders in descending remainder order, then ascending index", () => {
    // total 11, weights [5,3,2,1] sum 11 -> exact, no leftover
    expect(amounts(11n, [5n, 3n, 2n, 1n])).toEqual([5n, 3n, 2n, 1n]);
    // total 10, weights [1,1,3,5] sum 10 -> exact
    expect(amounts(10n, [1n, 1n, 3n, 5n])).toEqual([1n, 1n, 3n, 5n]);
    // total 3, weights [1,1,1,1]: leftover 3 -> indices 0,1,2
    expect(amounts(3n, [1n, 1n, 1n, 1n])).toEqual([1n, 1n, 1n, 0n]);
    // total 100, weights [1,2,4]: 14.28,28.57,57.14 -> floors 14,28,57 leftover 1; remainders
    // 100%7=2, 200%7=4, 400%7=1 -> index 1 gets it
    expect(amounts(100n, [1n, 2n, 4n])).toEqual([14n, 29n, 57n]);
    // total 100, weights [2,1,4] -> remainders 4,2,1 -> index 0 gets it
    expect(amounts(100n, [2n, 1n, 4n])).toEqual([29n, 14n, 57n]);
  });

  it("never gives anything to zero-weight parts, even when it would sort first", () => {
    expect(amounts(5n, [0n, 0n, 1n])).toEqual([0n, 0n, 5n]);
    expect(amounts(1n, [0n, 1n, 1n])).toEqual([0n, 1n, 0n]);
  });

  it("allocates zero and negative totals", () => {
    expect(amounts(0n, [1n, 2n])).toEqual([0n, 0n]);
    expect(amounts(-1n, [1n, 2n])).toEqual([0n, -1n]);
    expect(amounts(-10n, [1n, 2n, 3n])).toEqual([-2n, -3n, -5n]);
    expect(amounts(-3n, [1n, 1n, 1n, 1n])).toEqual([-1n, -1n, -1n, 0n]);
  });

  it("breaks ties by index for long weight lists (exercises the merge phase of the sort)", () => {
    for (const n of [40, 100, 257]) {
      const weights = Array.from({ length: n }, () => 1n);
      const parts = amounts(BigInt(n) / 3n, weights);
      expect(parts.filter((v) => v === 1n)).toHaveLength(Number(BigInt(n) / 3n));
      const firstZero = parts.indexOf(0n);
      expect(parts.slice(0, firstZero).every((v) => v === 1n)).toBe(true);
      expect(parts.slice(firstZero).every((v) => v === 0n)).toBe(true);
    }
  });

  it("keeps a single weight whole and preserves the currency", () => {
    expect(amounts(12_345n, [7n])).toEqual([12_345n]);
    expect(allocate(money(10n), [1n, 1n]).every((m) => m.currency === "EGP")).toBe(true);
  });

  it("matches an independent largest-remainder reference exactly", () => {
    const reference = (total: bigint, weights: bigint[]): bigint[] => {
      const neg = total < 0n;
      const mag = neg ? -total : total;
      const sum = weights.reduce((s, w) => s + w, 0n);
      const rows = weights.map((w, i) => ({
        i,
        floor: (mag * w) / sum,
        rem: (mag * w) % sum,
      }));
      let left = mag - rows.reduce((s, r) => s + r.floor, 0n);
      const byRem = [...rows].sort((x, y) => (x.rem === y.rem ? x.i - y.i : x.rem > y.rem ? -1 : 1));
      const out = rows.map((r) => r.floor);
      for (const r of byRem) {
        if (left === 0n) break;
        out[r.i] = (out[r.i] ?? 0n) + 1n;
        left -= 1n;
      }
      return out.map((v) => (neg ? -v : v));
    };
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000n, max: 10_000n }),
        fc.array(fc.bigInt({ min: 0n, max: 20n }), { minLength: 1, maxLength: 9 }),
        (total, weights) => {
          fc.pre(weights.some((w) => w > 0n));
          expect(amounts(total, weights)).toEqual(reference(total, weights));
        },
      ),
      { numRuns: 3000 },
    );
  });
});
