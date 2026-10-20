import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "../money";
import { DEFAULT_VAT_BPS, addVatToNet, splitVatInclusive } from "./vat";

describe("splitVatInclusive", () => {
  it("splits 11,400 at 14% into 10,000 net and 1,400 vat", () => {
    const s = splitVatInclusive(money(11_400n), DEFAULT_VAT_BPS);
    expect([s.net.amount, s.vat.amount, s.gross.amount]).toEqual([10_000n, 1_400n, 11_400n]);
  });
  it("rounds net half-even once and keeps net+vat==gross", () => {
    const s = splitVatInclusive(money(100n), DEFAULT_VAT_BPS); // 100/1.14 = 87.719
    expect([s.net.amount, s.vat.amount]).toEqual([88n, 12n]);
  });
  it("zero rate leaves gross untouched", () => {
    const s = splitVatInclusive(money(12_345n), 0n);
    expect([s.net.amount, s.vat.amount]).toEqual([12_345n, 0n]);
  });
  it("rejects out of range rates", () => {
    expect(() => splitVatInclusive(money(1n), -1n)).toThrow();
    expect(() => splitVatInclusive(money(1n), 10_001n)).toThrow();
  });
  it("addVatToNet adds half-even VAT", () => {
    const s = addVatToNet(money(1_000n), DEFAULT_VAT_BPS);
    expect([s.vat.amount, s.gross.amount]).toEqual([140n, 1_140n]);
    expect(addVatToNet(money(5n), DEFAULT_VAT_BPS).vat.amount).toBe(1n); // 0.7 -> 1
  });
  it("property: net+vat==gross, vat in [0,gross], monotone net", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.bigInt({ min: 0n, max: 5_000n }), (g, r) => {
        const s = splitVatInclusive(money(g), r);
        expect(s.net.amount + s.vat.amount).toBe(g);
        expect(s.vat.amount >= 0n && s.vat.amount <= g).toBe(true);
      }),
    );
  });
  it("property: credit note mirrors the charge", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 9n }), (g) => {
        const a = splitVatInclusive(money(g), DEFAULT_VAT_BPS);
        const b = splitVatInclusive(money(-g), DEFAULT_VAT_BPS);
        expect(b.net.amount).toBe(-a.net.amount);
        expect(b.vat.amount).toBe(-a.vat.amount);
      }),
    );
  });
});
