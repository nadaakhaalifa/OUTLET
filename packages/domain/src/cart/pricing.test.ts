import { describe, expect, it } from "vitest";
import { money, type Money } from "../money";
import { effectiveThreshold, freeDelivery, priceBag, priceChange, thresholdChange } from "./pricing";
import { InvalidCartInputError } from "./errors";
import type { BagLineInput, StoreTerms } from "./types";

const egp = (piastres: bigint): Money => money(piastres);
const EGP = (pounds: bigint): Money => money(pounds * 100n);
const PLATFORM = EGP(2000n);
const FEE = EGP(45n);
const open = (over: Partial<StoreTerms> = {}): StoreTerms => ({
  open: true,
  thresholdOverride: null,
  standardDeliveryFee: FEE,
  ...over,
});
let n = 0;
const line = (store: string, price: Money, over: Partial<BagLineInput> = {}): BagLineInput => {
  n += 1;
  return {
    lineId: `line-${n}`,
    skuId: `sku-${n}`,
    storeId: store,
    qty: 1,
    unitPrice: price,
    priceAtAdd: price,
    state: "IN_BAG",
    available: true,
    ...over,
  };
};
const price = (lines: BagLineInput[], stores: Record<string, StoreTerms>, plus = false) =>
  priceBag({ lines, stores: new Map(Object.entries(stores)), platformThreshold: PLATFORM, plusMember: plus });

describe("acceptance (spec 6)", () => {
  it("store A 1,950 + a 60 EGP item unlocks free delivery", () => {
    const before = price([line("A", EGP(1950n))], { A: open() });
    expect(before[0]?.freeDelivery.unlocked).toBe(false);
    expect(before[0]?.freeDelivery.remaining).toEqual(EGP(50n));
    expect(before[0]?.deliveryFee).toEqual(FEE);
    const after = price([line("A", EGP(1950n)), line("A", EGP(60n))], { A: open() });
    expect(after[0]?.merchandiseSubtotal).toEqual(EGP(2010n));
    expect(after[0]?.freeDelivery.unlocked).toBe(true);
    expect(after[0]?.freeDelivery.remaining).toEqual(EGP(0n));
    expect(after[0]?.deliveryFee).toEqual(EGP(0n));
  });

  it("store B at 2,100 EGP alone is free", () => {
    const g = price([line("B", EGP(2100n))], { B: open() });
    expect(g[0]?.freeDelivery.unlocked).toBe(true);
    expect(g[0]?.deliveryFee.amount).toBe(0n);
  });

  it("a single billable piastre already owes the delivery fee", () => {
    const g = price([line("A", egp(1n))], { A: open() });
    expect(g[0]?.deliveryFee).toEqual(FEE);
  });

  it("exactly at the threshold unlocks; one piastre below does not", () => {
    expect(price([line("A", egp(200_000n))], { A: open() })[0]?.freeDelivery.unlocked).toBe(true);
    const below = price([line("A", egp(199_999n))], { A: open() })[0];
    expect(below?.freeDelivery.unlocked).toBe(false);
    expect(below?.freeDelivery.remaining.amount).toBe(1n);
  });

  it("Plus member: every group unlocked, every fee 0", () => {
    const g = price([line("A", EGP(10n)), line("B", EGP(20n))], { A: open(), B: open() }, true);
    for (const x of g) {
      expect(x.freeDelivery.unlocked).toBe(true);
      expect(x.freeDelivery.plusMember).toBe(true);
      expect(x.freeDelivery.remaining.amount).toBe(0n);
      expect(x.deliveryFee.amount).toBe(0n);
    }
  });
});

describe("grouping and counting", () => {
  it("groups by first appearance and keeps stores independent", () => {
    const g = price([line("B", EGP(1n)), line("A", EGP(2n)), line("B", EGP(3n))], { A: open(), B: open() });
    expect(g.map((x) => x.storeId)).toEqual(["B", "A"]);
    expect(g[0]?.merchandiseSubtotal).toEqual(EGP(4n));
    expect(g[1]?.merchandiseSubtotal).toEqual(EGP(2n));
  });

  it("multiplies by quantity", () => {
    const g = price([line("A", EGP(100n), { qty: 3 })], { A: open() });
    expect(g[0]?.merchandiseSubtotal).toEqual(EGP(300n));
    expect(g[0]?.lines[0]?.lineTotal).toEqual(EGP(300n));
  });

  it("does not count saved-for-later or unavailable lines", () => {
    const g = price(
      [
        line("A", EGP(100n)),
        line("A", EGP(500n), { state: "SAVED_FOR_LATER" }),
        line("A", EGP(900n), { available: false }),
      ],
      { A: open() },
    );
    expect(g[0]?.merchandiseSubtotal).toEqual(EGP(100n));
    expect(g[0]?.lines.map((l) => l.counted)).toEqual([true, false, false]);
  });

  it("a suspended store is locked, counts nothing, never unlocks, charges no fee", () => {
    const g = price([line("A", EGP(5000n))], { A: open({ open: false }) }, true);
    expect(g[0]?.status).toBe("locked_store_suspended");
    expect(g[0]?.merchandiseSubtotal.amount).toBe(0n);
    expect(g[0]?.freeDelivery.unlocked).toBe(false);
    expect(g[0]?.deliveryFee.amount).toBe(0n);
  });

  it("an unknown store is treated as not open", () => {
    expect(price([line("Z", EGP(5000n))], {})[0]?.status).toBe("locked_store_suspended");
  });

  it("an empty billable group owes no delivery fee", () => {
    const g = price([line("A", EGP(100n), { state: "SAVED_FOR_LATER" })], { A: open() });
    expect(g[0]?.deliveryFee.amount).toBe(0n);
    expect(g[0]?.freeDelivery.remaining).toEqual(PLATFORM);
  });

  it("per-store threshold overrides the platform default", () => {
    const g = price([line("A", EGP(600n))], { A: open({ thresholdOverride: EGP(500n) }) });
    expect(g[0]?.freeDelivery.threshold).toEqual(EGP(500n));
    expect(g[0]?.freeDelivery.unlocked).toBe(true);
    expect(effectiveThreshold(undefined, PLATFORM)).toEqual(PLATFORM);
  });

  it("zero threshold is always unlocked", () => {
    const g = price([line("A", EGP(1n))], { A: open({ thresholdOverride: egp(0n) }) });
    expect(g[0]?.freeDelivery.unlocked).toBe(true);
  });
});

describe("price change", () => {
  it("is honest in both directions", () => {
    expect(priceChange(EGP(100n), EGP(90n))).toBe("dropped");
    expect(priceChange(EGP(100n), EGP(110n))).toBe("rose");
    expect(priceChange(EGP(100n), EGP(100n))).toBe("none");
  });
});

describe("threshold change", () => {
  it("is null when unchanged or unknown, reported when different", () => {
    expect(thresholdChange(null, EGP(2000n))).toBeNull();
    expect(thresholdChange(EGP(2000n), EGP(2000n))).toBeNull();
    expect(thresholdChange(EGP(2000n), EGP(1500n))).toEqual({ previous: EGP(2000n), current: EGP(1500n) });
  });
});

describe("invalid input", () => {
  it("rejects negative prices, zero or fractional quantity, negative thresholds", () => {
    expect(() => price([line("A", egp(-1n))], { A: open() })).toThrow(InvalidCartInputError);
    expect(() => price([line("A", EGP(1n), { qty: 0 })], { A: open() })).toThrow(InvalidCartInputError);
    expect(() => price([line("A", EGP(1n), { qty: 1.5 })], { A: open() })).toThrow(InvalidCartInputError);
    expect(() => price([line("A", EGP(1n), { priceAtAdd: egp(-1n) })], { A: open() })).toThrow(InvalidCartInputError);
    expect(() => freeDelivery(egp(-1n), PLATFORM, false, true)).toThrow(InvalidCartInputError);
    expect(() => price([line("A", EGP(1n))], { A: open({ thresholdOverride: egp(-5n) }) })).toThrow(InvalidCartInputError);
    expect(() => price([line("A", EGP(1n))], { A: open({ standardDeliveryFee: egp(-5n) }) })).toThrow(InvalidCartInputError);
  });
});

describe("freeDelivery", () => {
  it("remaining never goes negative for a locked store above threshold", () => {
    const fd = freeDelivery(EGP(5000n), PLATFORM, false, false);
    expect(fd.unlocked).toBe(false);
    expect(fd.remaining.amount).toBe(0n);
  });
});
