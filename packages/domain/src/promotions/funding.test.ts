import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidAmountError } from "../errors";
import { capAmounts, splitFunding } from "./funding";

describe("splitFunding", () => {
  it("splits exactly and gives the odd piastre to the platform column", () => {
    expect(splitFunding(101n, { platformPct: 50, sellerPct: 50 })).toEqual({
      amount: 101n,
      platformFunded: 51n,
      sellerFunded: 50n,
    });
    expect(splitFunding(0n, { platformPct: 30, sellerPct: 70 })).toEqual({ amount: 0n, platformFunded: 0n, sellerFunded: 0n });
    expect(splitFunding(999n, { platformPct: 0, sellerPct: 100 })).toEqual({
      amount: 999n,
      platformFunded: 0n,
      sellerFunded: 999n,
    });
  });
  it("rejects negative amounts", () => {
    expect(() => splitFunding(-1n, { platformPct: 50, sellerPct: 50 })).toThrow(InvalidAmountError);
  });
  it("always sums to the amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.integer({ min: 0, max: 100 }), (amount, p) => {
        const s = splitFunding(amount, { platformPct: p, sellerPct: 100 - p });
        expect(s.platformFunded + s.sellerFunded).toBe(amount);
        expect(s.platformFunded).toBeGreaterThanOrEqual(0n);
        expect(s.sellerFunded).toBeGreaterThanOrEqual(0n);
      }),
    );
  });
});

describe("capAmounts", () => {
  it("leaves amounts alone under the cap", () => {
    expect(capAmounts([3n, 4n], 7n)).toEqual([3n, 4n]);
    expect(capAmounts([3n, 4n], 100n)).toEqual([3n, 4n]);
  });
  it("zeroes everything for a non-positive cap", () => {
    expect(capAmounts([3n, 4n], 0n)).toEqual([0n, 0n]);
    expect(capAmounts([3n, 4n], -5n)).toEqual([0n, 0n]);
  });
  it("rejects negative parts", () => {
    expect(() => capAmounts([-1n], 5n)).toThrow(InvalidAmountError);
  });
  it("scales proportionally to exactly the cap, never raising a part", () => {
    expect(capAmounts([10n, 30n], 20n)).toEqual([5n, 15n]);
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 100_000n }), { minLength: 1, maxLength: 8 }), fc.bigInt({ min: 0n, max: 200_000n }), (xs, cap) => {
        const out = capAmounts(xs, cap);
        const sum = xs.reduce((a, b) => a + b, 0n);
        expect(out.reduce((a, b) => a + b, 0n)).toBe(sum <= cap ? sum : cap);
        out.forEach((v, i) => expect(v).toBeLessThanOrEqual(xs[i] ?? 0n));
      }),
    );
  });
});
