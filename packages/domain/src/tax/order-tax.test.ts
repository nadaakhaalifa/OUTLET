import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "../money";
import { DEFAULT_TAX_CATEGORIES, applyExemptionChange, type TaxCategory } from "./exemptions";
import { computeOrderTax } from "./order-tax";

const cats = (list: readonly TaxCategory[] = DEFAULT_TAX_CATEGORIES): ReadonlyMap<string, TaxCategory> => new Map(list.map((c) => [c.code, c]));
const NOW = 1_800_000_000_000;

describe("computeOrderTax", () => {
  it("computes line level values whose sums equal the totals", () => {
    const t = computeOrderTax({
      lines: [
        { id: "a", unitGross: money(9_999n), qty: 3, categoryCode: "standard" },
        { id: "b", unitGross: money(1_234n), qty: 1, categoryCode: "shipping" },
      ],
      orderDiscount: money(1_001n),
      categories: cats(),
      atMs: NOW,
    });
    expect(t.totals.gross.amount).toBe(9_999n * 3n + 1_234n - 1_001n);
    for (const l of t.lines) expect(l.net.amount + l.vat.amount).toBe(l.gross.amount);
    expect(t.lines.reduce((s, l) => s + l.discountShare.amount, 0n)).toBe(1_001n);
    expect(t.totals.net.amount + t.totals.vat.amount).toBe(t.totals.gross.amount);
  });

  it("applies an active exemption as zero VAT and ignores an expired one", () => {
    const base = DEFAULT_TAX_CATEGORIES.find((c) => c.code === "standard");
    if (base === undefined) throw new Error("seed");
    const { category } = applyExemptionChange(
      base,
      {
        kind: "set",
        reason: "decision 123",
        exemption: { reasonAr: "إعفاء", reasonEn: "Exempt", legalBasis: "Decision 1", effectiveFromMs: NOW - 1000, effectiveToMs: NOW + 1000 },
      },
      "admin-1",
      NOW,
    );
    const input = { lines: [{ id: "a", unitGross: money(1_000n), qty: 1, categoryCode: "standard" }], orderDiscount: money(0n) };
    const inForce = computeOrderTax({ ...input, categories: cats([category]), atMs: NOW });
    expect(inForce.lines[0]?.vat.amount).toBe(0n);
    expect(inForce.lines[0]?.exempt).toBe(true);
    const after = computeOrderTax({ ...input, categories: cats([category]), atMs: NOW + 1000 });
    expect(after.lines[0]?.vat.amount).toBe(123n);
  });

  it("rejects bad input", () => {
    const c = cats();
    const l = { id: "a", unitGross: money(100n), qty: 1, categoryCode: "standard" };
    expect(() => computeOrderTax({ lines: [], orderDiscount: money(0n), categories: c, atMs: NOW })).toThrow();
    expect(() => computeOrderTax({ lines: [l, l], orderDiscount: money(0n), categories: c, atMs: NOW })).toThrow(/duplicate/);
    expect(() => computeOrderTax({ lines: [l], orderDiscount: money(101n), categories: c, atMs: NOW })).toThrow(/exceeds/);
    expect(() => computeOrderTax({ lines: [{ ...l, categoryCode: "nope" }], orderDiscount: money(0n), categories: c, atMs: NOW })).toThrow(/unknown/);
    expect(() => computeOrderTax({ lines: [{ ...l, qty: 0 }], orderDiscount: money(0n), categories: c, atMs: NOW })).toThrow();
  });

  it("property: no piastre is lost, every line balances, discount fully allocated", () => {
    const lineArb = fc.record({
      unit: fc.bigInt({ min: 0n, max: 5_000_000n }),
      qty: fc.integer({ min: 1, max: 20 }),
      cat: fc.constantFrom("standard", "shipping", "gift_card"),
    });
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 12 }), fc.double({ min: 0, max: 1, noNaN: true }), (ls, frac) => {
        const lines = ls.map((l, i) => ({ id: `l${i}`, unitGross: money(l.unit), qty: l.qty, categoryCode: l.cat }));
        const merch = ls.reduce((s, l) => s + l.unit * BigInt(l.qty), 0n);
        const discount = BigInt(Math.floor(Number(merch) * frac));
        const t = computeOrderTax({ lines, orderDiscount: money(discount), categories: cats(), atMs: NOW });
        expect(t.totals.discount.amount).toBe(discount);
        expect(t.totals.gross.amount).toBe(merch - discount);
        expect(t.totals.net.amount + t.totals.vat.amount).toBe(t.totals.gross.amount);
        for (const l of t.lines) {
          expect(l.net.amount + l.vat.amount).toBe(l.gross.amount);
          expect(l.gross.amount >= 0n).toBe(true);
          expect(l.discountShare.amount <= l.grossBeforeDiscount.amount).toBe(true);
        }
      }),
    );
  });
});
