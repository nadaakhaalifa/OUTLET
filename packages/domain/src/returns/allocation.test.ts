import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocateRefund, cumulativeShare, type LineAllocationInput } from "./allocation";
import { money } from "../money";

const line = (o: Partial<LineAllocationInput> = {}): LineAllocationInput => ({
  orderLineId: "L1",
  qtyOrdered: 3,
  unitPrice: money(10_000n),
  discountAlloc: money(1_000n),
  deliveryFeeAlloc: money(2_500n),
  alreadyReturnedQty: 0,
  returningQty: 1,
  deliveryFeeRefundable: false,
  ...o,
});

describe("allocateRefund", () => {
  it("subtracts the proportional voucher share and excludes the fee unless refundable", () => {
    const a = allocateRefund([line()]);
    expect(a.itemTotal.amount).toBe(10_000n);
    expect(a.voucherTotal.amount).toBe(333n);
    expect(a.deliveryFeeTotal.amount).toBe(0n);
    expect(a.netTotal.amount).toBe(9_667n);
  });

  it("includes the delivery fee share when refundable", () => {
    const a = allocateRefund([line({ returningQty: 3, deliveryFeeRefundable: true })]);
    expect(a.voucherTotal.amount).toBe(1_000n);
    expect(a.deliveryFeeTotal.amount).toBe(2_500n);
    expect(a.netTotal.amount).toBe(30_000n - 1_000n + 2_500n);
  });

  it("rounds half to even once, on the cumulative share", () => {
    expect(cumulativeShare(5n, 1, 2)).toBe(2n);
    expect(cumulativeShare(7n, 1, 2)).toBe(4n);
    expect(cumulativeShare(100n, 0, 7)).toBe(0n);
    expect(cumulativeShare(100n, 7, 7)).toBe(100n);
  });

  it("rejects inconsistent input with a typed error", () => {
    expect(() => allocateRefund([])).toThrow();
    expect(() => allocateRefund([line({ returningQty: 0 })])).toThrow();
    expect(() => allocateRefund([line({ alreadyReturnedQty: 3, returningQty: 1 })])).toThrow();
    expect(() => allocateRefund([line({ discountAlloc: money(30_001n) })])).toThrow();
    expect(() => allocateRefund([line({ unitPrice: money(-1n) })])).toThrow();
  });
});

describe("allocation properties", () => {
  const lineArb = fc
    .record({
      qty: fc.integer({ min: 1, max: 12 }),
      unit: fc.bigInt({ min: 0n, max: 5_000_000n }),
      feeAlloc: fc.bigInt({ min: 0n, max: 100_000n }),
      discountPct: fc.integer({ min: 0, max: 100 }),
    })
    .map(({ qty, unit, feeAlloc, discountPct }) => ({
      qty,
      unit,
      feeAlloc,
      discount: (unit * BigInt(qty) * BigInt(discountPct)) / 100n,
    }));

  it("sum of parts equals the total, for every split of the line", () => {
    fc.assert(
      fc.property(lineArb, fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 12 }), (l, steps) => {
        let returned = 0;
        let item = 0n;
        let voucher = 0n;
        let fee = 0n;
        for (const s of steps) {
          const r = Math.min(s, l.qty - returned);
          if (r < 1) break;
          const a = allocateRefund([
            {
              orderLineId: "L",
              qtyOrdered: l.qty,
              unitPrice: money(l.unit),
              discountAlloc: money(l.discount),
              deliveryFeeAlloc: money(l.feeAlloc),
              alreadyReturnedQty: returned,
              returningQty: r,
              deliveryFeeRefundable: true,
            },
          ]);
          const part = a.lines[0];
          expect(part).toBeDefined();
          // total equals the parts, and each part is non-negative
          expect(a.netTotal.amount).toBe(a.itemTotal.amount - a.voucherTotal.amount + a.deliveryFeeTotal.amount);
          expect(a.netTotal.amount >= 0n).toBe(true);
          item += a.itemTotal.amount;
          voucher += a.voucherTotal.amount;
          fee += a.deliveryFeeTotal.amount;
          returned += r;
        }
        if (returned === l.qty) {
          expect(item).toBe(l.unit * BigInt(l.qty));
          expect(voucher).toBe(l.discount);
          expect(fee).toBe(l.feeAlloc);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("a multi-line total equals the sum of line nets", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 6 }), (ls) => {
        const a = allocateRefund(
          ls.map((l, i) => ({
            orderLineId: `L${i}`,
            qtyOrdered: l.qty,
            unitPrice: money(l.unit),
            discountAlloc: money(l.discount),
            deliveryFeeAlloc: money(l.feeAlloc),
            alreadyReturnedQty: 0,
            returningQty: l.qty,
            deliveryFeeRefundable: true,
          })),
        );
        const sum = a.lines.reduce((s, x) => s + x.netAmount.amount, 0n);
        expect(a.netTotal.amount).toBe(sum);
        expect(a.itemTotal.amount).toBe(a.lines.reduce((s, x) => s + x.itemAmount.amount, 0n));
      }),
      { numRuns: 200 },
    );
  });

  it("the voucher share of k units is monotonic in k and bounded by the discount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), fc.integer({ min: 1, max: 20 }), (total, qty) => {
        let prev = 0n;
        for (let k = 0; k <= qty; k += 1) {
          const c = cumulativeShare(total, k, qty);
          expect(c >= prev).toBe(true);
          expect(c <= total).toBe(true);
          prev = c;
        }
        expect(prev).toBe(total);
      }),
    );
  });
});
