import { describe, expect, it } from "vitest";
import { priceView } from "../view-models/price";
import type { PriceBlock, PriceEvidence } from "../view-models/types";

const m = (a: number) => ({ amount: String(a), currency: "EGP" as const });
const CLAIM = "00000000-0000-4000-8000-000000000850";
const block = (over: Partial<PriceBlock> = {}): PriceBlock => ({ price: m(99900), badge: "verified_discount", reference_price: m(129900), discount_pct: 23, claim_id: CLAIM, ...over });
const ev = (kind: PriceEvidence["display_kind"]): PriceEvidence => ({ product_id: CLAIM, tier: "E2", display_kind: kind, evidence_classes: ["INTERNAL"] });

describe("priceView (honest discount)", () => {
  it("grants a claim only for a consistent verified block", () => {
    const v = priceView(block(), ev("verified_discount"));
    expect(v.claim).toEqual({ reference: 129900n, pct: 23 });
    expect(v.amount).toBe(99900n);
  });
  it("listing cards (evidence not fetched) use the block alone", () => {
    expect(priceView(block(), undefined).claim?.pct).toBe(23);
  });
  it("fails closed when evidence failed to load or disagrees", () => {
    expect(priceView(block(), null).claim).toBeNull();
    expect(priceView(block(), ev("plain")).claim).toBeNull();
    expect(priceView(block(), ev("lowest_30d")).badge).toBe("none");
  });
  it("rejects missing claim id, missing reference, wrong percent, reference not above price", () => {
    expect(priceView(block({ claim_id: null }), undefined).claim).toBeNull();
    expect(priceView(block({ reference_price: null }), undefined).claim).toBeNull();
    expect(priceView(block({ discount_pct: 40 }), undefined).claim).toBeNull();
    expect(priceView(block({ reference_price: m(99900), discount_pct: 5 }), undefined).claim).toBeNull();
    expect(priceView(block({ reference_price: m(50000) }), undefined).claim).toBeNull();
  });
  it("no strike-through for non-claim badges even when a reference is present", () => {
    const v = priceView(block({ badge: "lowest_30d" }), undefined);
    expect(v.claim).toBeNull();
    expect(v.badge).toBe("lowest_30d");
    expect(priceView(block({ badge: "none" }), undefined).claim).toBeNull();
    expect(priceView(block({ badge: "launch_price", reference_price: null, discount_pct: null, claim_id: null }), ev("plain")).badge).toBe("none");
  });
  it("percent uses integer floor", () => {
    expect(priceView(block({ price: m(1), reference_price: m(3), discount_pct: 66 }), undefined).claim?.pct).toBe(66);
  });
});
