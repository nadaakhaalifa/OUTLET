import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "../money";
import { freeDelivery, priceBag } from "./pricing";
import type { BagLineInput, StoreTerms } from "./types";

const priceArb = fc.bigInt({ min: 0n, max: 10_000_000n });
const storeArb = fc.constantFrom("A", "B", "C");
const lineArb = fc.record({
  storeId: storeArb,
  qty: fc.integer({ min: 1, max: 10 }),
  unit: priceArb,
  atAdd: priceArb,
  state: fc.constantFrom("IN_BAG" as const, "SAVED_FOR_LATER" as const),
  available: fc.boolean(),
});
const termsArb = fc.record({
  open: fc.boolean(),
  override: fc.option(fc.bigInt({ min: 0n, max: 1_000_000n }), { nil: null }),
  fee: fc.bigInt({ min: 0n, max: 20_000n }),
});

interface RawLine {
  storeId: string;
  qty: number;
  unit: bigint;
  atAdd: bigint;
  state: "IN_BAG" | "SAVED_FOR_LATER";
  available: boolean;
}
interface RawTerms {
  open: boolean;
  override: bigint | null;
  fee: bigint;
}

function build(raw: RawLine[], t: Record<string, RawTerms>, plus: boolean) {
  const lines: BagLineInput[] = raw.map((r, i) => ({
    lineId: `l${i}`,
    skuId: `s${i}`,
    storeId: r.storeId,
    qty: r.qty,
    unitPrice: money(r.unit),
    priceAtAdd: money(r.atAdd),
    state: r.state,
    available: r.available,
  }));
  const stores = new Map<string, StoreTerms>(
    Object.entries(t).map(([k, v]) => [
      k,
      { open: v.open, thresholdOverride: v.override === null ? null : money(v.override), standardDeliveryFee: money(v.fee) },
    ]),
  );
  return { lines, groups: priceBag({ lines, stores, platformThreshold: money(200_000n), plusMember: plus }) };
}

const world = fc.record({
  lines: fc.array(lineArb, { maxLength: 30 }),
  terms: fc.record({ A: termsArb, B: termsArb, C: termsArb }),
  plus: fc.boolean(),
});

describe("bag pricing invariants", () => {
  it("totals, remaining and fees are never negative", () => {
    fc.assert(
      fc.property(world, (w) => {
        for (const g of build(w.lines, w.terms, w.plus).groups) {
          expect(g.merchandiseSubtotal.amount >= 0n).toBe(true);
          expect(g.freeDelivery.remaining.amount >= 0n).toBe(true);
          expect(g.deliveryFee.amount >= 0n).toBe(true);
        }
      }),
    );
  });

  it("group subtotal equals the sum of counted lines and counted lines equal billable rules", () => {
    fc.assert(
      fc.property(world, (w) => {
        for (const g of build(w.lines, w.terms, w.plus).groups) {
          const sum = g.lines.filter((l) => l.counted).reduce((a, l) => a + l.unitPrice.amount * BigInt(l.qty), 0n);
          expect(g.merchandiseSubtotal.amount).toBe(sum);
          for (const l of g.lines) {
            expect(l.counted).toBe(g.status === "open" && l.state === "IN_BAG" && l.available);
          }
        }
      }),
    );
  });

  it("every input line lands in exactly one group", () => {
    fc.assert(
      fc.property(world, (w) => {
        const { lines, groups } = build(w.lines, w.terms, w.plus);
        expect(groups.reduce((a, g) => a + g.lines.length, 0)).toBe(lines.length);
        expect(new Set(groups.map((g) => g.storeId)).size).toBe(groups.length);
      }),
    );
  });

  it("threshold is monotonic: a larger subtotal never un-unlocks free delivery", () => {
    fc.assert(
      fc.property(priceArb, priceArb, fc.bigInt({ min: 0n, max: 1_000_000n }), fc.boolean(), (a, b, t, plus) => {
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        const low = freeDelivery(money(lo), money(t), plus, true);
        const high = freeDelivery(money(hi), money(t), plus, true);
        if (low.unlocked) expect(high.unlocked).toBe(true);
        expect(high.remaining.amount <= low.remaining.amount).toBe(true);
        if (!low.unlocked) expect(low.remaining.amount + lo >= t).toBe(true);
      }),
    );
  });

  it("a Plus member in an open store is always unlocked with a zero fee", () => {
    fc.assert(
      fc.property(world, (w) => {
        for (const g of build(w.lines, w.terms, true).groups) {
          if (g.status === "open") {
            expect(g.freeDelivery.unlocked).toBe(true);
            expect(g.deliveryFee.amount).toBe(0n);
          }
        }
      }),
    );
  });

  it("an open non-Plus group is unlocked iff subtotal >= threshold, and fee is 0 exactly when unlocked or empty", () => {
    fc.assert(
      fc.property(world, (w) => {
        for (const g of build(w.lines, w.terms, false).groups) {
          if (g.status !== "open") continue;
          expect(g.freeDelivery.unlocked).toBe(g.merchandiseSubtotal.amount >= g.freeDelivery.threshold.amount);
          if (g.freeDelivery.unlocked || g.merchandiseSubtotal.amount === 0n) expect(g.deliveryFee.amount).toBe(0n);
        }
      }),
    );
  });
});
