import { describe, expect, it } from "vitest";
import { formatAmount, formatMoney } from "../money-display";
import {
  DEFAULT_FREE_DELIVERY_THRESHOLD as T, FIXTURE_BAG, InMemoryBagPort, applySaved, buildBag, priceChange, rankSuggestions,
  type BagLine, type BagSnapshot,
} from "./model";

const line = (o: Partial<BagLine> & { id: string }): BagLine => ({
  storeId: "a", title: "t", sizeLabel: "M", qty: 1, unitPrice: 100n, priceAtAdd: 100n, availability: "available", savedForLater: false, ...o,
});
const snap = (lines: BagLine[], over: Partial<BagSnapshot> = {}): BagSnapshot => ({
  isPlusMember: false,
  stores: [{ id: "a", name: "A", status: "active", freeDeliveryThreshold: T }],
  lines,
  ...over,
});

describe("free delivery", () => {
  it("is locked below the threshold with an honest remaining amount", () => {
    const g = buildBag(snap([line({ id: "1", unitPrice: 195_000n, priceAtAdd: 195_000n })])).groups[0]!;
    expect(g.freeDelivery.unlocked).toBe(false);
    expect(g.freeDelivery.remaining).toBe(5_000n);
    expect(g.freeDelivery.progressPct).toBe(97);
  });
  it("unlocks at the threshold and adding 60 EGP to 1,950 unlocks", () => {
    const g = buildBag(snap([line({ id: "1", unitPrice: 195_000n }), line({ id: "2", unitPrice: 6_000n })])).groups[0]!;
    expect(g.freeDelivery.unlocked).toBe(true);
    expect(g.freeDelivery.progressPct).toBe(100);
    expect(g.freeDelivery.remaining).toBe(0n);
  });
  it("multiplies by quantity, and Plus is free with no minimum", () => {
    const g = buildBag(snap([line({ id: "1", unitPrice: 10_000n, qty: 3 })], { isPlusMember: true })).groups[0]!;
    expect(g.subtotal).toBe(30_000n);
    expect(g.freeDelivery.viaPlus).toBe(true);
    expect(g.freeDelivery.unlocked).toBe(true);
  });
  it("excludes unavailable, saved-for-later and suspended lines", () => {
    const v = buildBag(snap([
      line({ id: "1", unitPrice: 50_000n }),
      line({ id: "2", unitPrice: 999_000n, availability: "soldOut" }),
      line({ id: "3", unitPrice: 999_000n, savedForLater: true }),
    ]));
    expect(v.groups[0]!.subtotal).toBe(50_000n);
    expect(v.groups[0]!.saved).toHaveLength(1);
    const s = buildBag(snap([line({ id: "1", unitPrice: 999_000n })], { stores: [{ id: "a", name: "A", status: "suspended", freeDeliveryThreshold: T }], isPlusMember: true }));
    expect(s.groups[0]!.locked).toBe(true);
    expect(s.groups[0]!.subtotal).toBe(0n);
    expect(s.groups[0]!.freeDelivery.viaPlus).toBe(false);
    expect(s.purchasableLineCount).toBe(0);
  });
  it("uses the per-store threshold", () => {
    const g = buildBag(snap([line({ id: "1", unitPrice: 50_000n })], { stores: [{ id: "a", name: "A", status: "active", freeDeliveryThreshold: 40_000n }] })).groups[0]!;
    expect(g.freeDelivery.unlocked).toBe(true);
  });
});

describe("price changes", () => {
  it("reports both directions", () => {
    expect(priceChange({ unitPrice: 90n, priceAtAdd: 100n })).toEqual({ kind: "dropped", delta: 10n });
    expect(priceChange({ unitPrice: 110n, priceAtAdd: 100n })).toEqual({ kind: "rose", delta: 10n });
    expect(priceChange({ unitPrice: 100n, priceAtAdd: 100n })).toEqual({ kind: "same" });
  });
});

describe("rankSuggestions", () => {
  const c = [
    { skuId: "a", title: "a", sizeLabel: "M", unitPrice: 8_000n },
    { skuId: "b", title: "b", sizeLabel: "M", unitPrice: 30_000n },
    { skuId: "c", title: "c", sizeLabel: "M", unitPrice: 15_000n },
  ];
  it("puts the cheapest gap-closing item first", () => {
    expect(rankSuggestions(c, 10_000n).map((s) => s.skuId)).toEqual(["c", "b", "a"]);
  });
  it("returns nothing when already unlocked and caps the list", () => {
    expect(rankSuggestions(c, 0n)).toEqual([]);
    expect(rankSuggestions(c, 100_000n, 2)).toHaveLength(2);
  });
});

describe("fake port and fixtures", () => {
  it("toggles saved-for-later and builds the fixture honestly", async () => {
    const port = new InMemoryBagPort();
    await port.setSavedForLater("l1", true);
    const v = buildBag(await port.load());
    expect(v.groups.find((g) => g.store.id === "s1")!.saved).toHaveLength(1);
    expect(buildBag(FIXTURE_BAG).groups.find((g) => g.store.id === "s4")!.locked).toBe(true);
    expect(buildBag(applySaved(FIXTURE_BAG, "l5", false)).groups.find((g) => g.store.id === "s3")!.saved).toHaveLength(0);
  });
  it("is empty when nothing remains", () => {
    expect(buildBag(snap([])).isEmpty).toBe(true);
  });
});

describe("money display", () => {
  it("formats Western and Eastern numerals from piastres", () => {
    expect(formatAmount(200_000n, "en")).toBe("2,000");
    expect(formatAmount(125_050n, "en")).toBe("1,250.50");
    expect(formatAmount(200_000n, "ar")).toBe("٢٬٠٠٠");
    expect(formatMoney(5_000n, "ar", "ج.م")).toBe("٥٠ ج.م");
    expect(formatAmount(-100n, "en")).toBe("-1");
  });
});
