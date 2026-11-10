import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "@outlet/money";
import { SellerNetError } from "../src/domain/errors.js";
import { platformDiscountExceedsCap, sellerAmounts, splitInstructions } from "../src/domain/split.js";
import type { SellerAmounts } from "../src/domain/split.js";
import type { QuoteLine, StoreQuote } from "../src/domain/types.js";

// Hand-run mutation pass (StrykerJS cannot run in the sandbox). Every expectation below is an exact value computed by hand,
// so a flipped operator, boundary, constant or removed statement in split.ts changes it.
const e = (n: bigint) => money(n, "EGP");
const line = (sellerDiscount: bigint, platformDiscount = 0n): QuoteLine => ({
  cartLineId: "c", skuId: "s", storeId: "A", qty: 1, unitPrice: e(1n), lineGross: e(1n), platformDiscount: e(platformDiscount), sellerDiscount: e(sellerDiscount),
  payable: e(1n), vat: e(0n), vatBp: 1400, taxCategory: "standard", vrp: null, claimType: "plain", verifiedSaving: e(0n),
});
interface Opts { items: bigint; lines?: QuoteLine[]; ship?: bigint; shipVat?: bigint; vat?: bigint; total?: bigint; shipSeller?: bigint; shipPlatform?: bigint; platform?: bigint; seller?: bigint }
const store = (o: Opts): StoreQuote => ({
  storeId: "A", lines: o.lines ?? [], itemsSubtotal: e(o.items),
  shipping: { gross: e(o.ship ?? 0n), vat: e(o.shipVat ?? 0n), quoteRef: "r", etaDaysMin: 1, etaDaysMax: 2 },
  shippingDiscount: { platform: e(o.shipPlatform ?? 0n), seller: e(o.shipSeller ?? 0n) },
  platformDiscount: e(o.platform ?? 0n), sellerDiscount: e(o.seller ?? 0n), vat: e(o.vat ?? 0n), total: e(o.total ?? o.items),
});

describe("sellerAmounts: arithmetic", () => {
  it("base = items - SUM of seller line discounts (not platform), commission = base*bp, vat on commission, net residual", () => {
    // items 100000, seller discounts 6000 + 4000 (summed), platform discount 5000 must NOT enter the base.
    const a = sellerAmounts(store({ items: 100_000n, lines: [line(6_000n, 5_000n), line(4_000n)] }), 1000, 1400);
    expect(a.commission.amountMinor).toBe(9_000n); // 90_000 * 10%
    expect(a.commissionVat.amountMinor).toBe(1_260n); // 9_000 * 14%
    expect(a.net.amountMinor).toBe(79_740n); // 90_000 - 9_000 - 1_260
  });
  it("seller-funded delivery waiver comes off the net, not off the commission base", () => {
    const a = sellerAmounts(store({ items: 100_000n, shipSeller: 3_000n }), 1000, 1400);
    expect(a.commission.amountMinor).toBe(10_000n);
    expect(a.commissionVat.amountMinor).toBe(1_400n);
    expect(a.net.amountMinor).toBe(100_000n - 10_000n - 1_400n - 3_000n);
  });
  it("platform delivery waiver does not touch the seller net", () => {
    const a = sellerAmounts(store({ items: 100_000n, shipPlatform: 3_000n }), 1000, 1400);
    expect(a.net.amountMinor).toBe(88_600n);
  });
  it("net exactly 0 is allowed, net -1 throws SellerNetError carrying the amount", () => {
    expect(sellerAmounts(store({ items: 1_000n, shipSeller: 1_000n }), 0, 0).net.amountMinor).toBe(0n);
    let err: unknown;
    try { sellerAmounts(store({ items: 1_000n, shipSeller: 1_001n }), 0, 0); } catch (x) { err = x; }
    expect(err).toBeInstanceOf(SellerNetError);
    expect(err).toMatchObject({ storeId: "A", netMinor: -1n });
  });
  it("commission bp accepted at 0 and 10000, refused at -1 and 10001 (no off-by-one)", () => {
    expect(sellerAmounts(store({ items: 1_000n }), 0, 0).commission.amountMinor).toBe(0n);
    expect(sellerAmounts(store({ items: 1_000n }), 10_000, 0).commission.amountMinor).toBe(1_000n);
    expect(() => sellerAmounts(store({ items: 1_000n }), -1, 0)).toThrow(RangeError);
    expect(() => sellerAmounts(store({ items: 1_000n }), 10_001, 0)).toThrow(RangeError);
    expect(() => sellerAmounts(store({ items: 1_000n }), 0.5, 0)).toThrow(RangeError);
  });
  it("banker's rounding at the one documented point: .5 goes to even for commission and for commission VAT", () => {
    // 10% of 25 = 2.5 -> 2 ; of 35 = 3.5 -> 4 ; of 15 = 1.5 -> 2 ; of 5 = 0.5 -> 0
    expect([25n, 35n, 15n, 5n].map((b) => sellerAmounts(store({ items: b }), 1000, 0).commission.amountMinor)).toEqual([2n, 4n, 2n, 0n]);
    // VAT 50% of commission 5 = 2.5 -> 2 ; of 7 = 3.5 -> 4 ; 14% of 5 = 0.7 -> 1
    expect(sellerAmounts(store({ items: 50n }), 1000, 5000).commissionVat.amountMinor).toBe(2n);
    expect(sellerAmounts(store({ items: 70n }), 1000, 5000).commissionVat.amountMinor).toBe(4n);
    expect(sellerAmounts(store({ items: 50n }), 1000, 1400).commissionVat.amountMinor).toBe(1n);
  });
  it("shipping and VAT fields are differences, not copies: goodsVat = vat - shippingVat, shippingNet = gross - vat", () => {
    const a = sellerAmounts(store({ items: 10_000n, ship: 6_000n, shipVat: 737n, vat: 2_000n, total: 16_000n, platform: 11n, seller: 7n }), 1000, 1400);
    expect(a.goodsVat.amountMinor).toBe(1_263n);
    expect(a.shippingNet.amountMinor).toBe(5_263n);
    expect(a.shipping.amountMinor).toBe(6_000n);
    expect(a.shippingVat.amountMinor).toBe(737n);
    expect(a.total.amountMinor).toBe(16_000n);
    expect(a.platformDiscount.amountMinor).toBe(11n);
    expect(a.sellerDiscount.amountMinor).toBe(7n);
    expect(a.commissionBp).toBe(1000);
    expect(a.storeId).toBe("A");
    expect(a.items.amountMinor).toBe(10_000n);
  });
  it("largest realistic values stay exact (10^15 piastres, no float)", () => {
    const a = sellerAmounts(store({ items: 10n ** 15n }), 1000, 1400);
    expect(a.commission.amountMinor).toBe(10n ** 14n);
    expect(a.commissionVat.amountMinor).toBe(14n * 10n ** 12n);
    expect(a.net.amountMinor).toBe(10n ** 15n - 10n ** 14n - 14n * 10n ** 12n);
  });
  it("zero items: everything zero", () => {
    const a = sellerAmounts(store({ items: 0n }), 1000, 1400);
    expect([a.commission, a.commissionVat, a.net].map((m) => m.amountMinor)).toEqual([0n, 0n, 0n]);
  });
});

describe("platformDiscountExceedsCap boundary", () => {
  // items 100000 -> commission 10000, VAT 1400, cap 11400
  const withPlatform = (p: bigint) => store({ items: 100_000n, platform: p });
  it("exactly equal to commission + commission VAT is NOT over the cap", () => {
    expect(platformDiscountExceedsCap(withPlatform(11_400n), 1000, 1400)).toBe(false);
  });
  it("one piastre over is over the cap; one under is not", () => {
    expect(platformDiscountExceedsCap(withPlatform(11_401n), 1000, 1400)).toBe(true);
    expect(platformDiscountExceedsCap(withPlatform(11_399n), 1000, 1400)).toBe(false);
  });
  it("zero discount never exceeds, even with zero commission (0 > 0 is false)", () => {
    expect(platformDiscountExceedsCap(withPlatform(0n), 0, 0)).toBe(false);
    expect(platformDiscountExceedsCap(withPlatform(1n), 0, 0)).toBe(true);
  });
  it("cap uses commission AND its VAT (VAT bp changes the answer)", () => {
    expect(platformDiscountExceedsCap(withPlatform(11_000n), 1000, 1400)).toBe(false);
    expect(platformDiscountExceedsCap(withPlatform(11_000n), 1000, 0)).toBe(true); // cap 10000
  });
  it("cap is computed on the seller-discounted base", () => {
    // seller discount 50000 -> base 50000 -> commission 5000 + 700 = 5700
    const s = store({ items: 100_000n, lines: [line(50_000n)], platform: 5_700n });
    expect(platformDiscountExceedsCap(s, 1000, 1400)).toBe(false);
    expect(platformDiscountExceedsCap({ ...s, platformDiscount: e(5_701n) }, 1000, 1400)).toBe(true);
  });
  it("propagates the net guard (a seller waiver beyond net still throws)", () => {
    expect(() => platformDiscountExceedsCap(store({ items: 100n, shipSeller: 1_000n }), 1000, 1400)).toThrow(SellerNetError);
  });
});

const seller = (id: string, total: bigint, net: bigint): SellerAmounts => ({
  storeId: id, items: e(total), shipping: e(0n), shippingVat: e(0n), shippingNet: e(0n), goodsVat: e(0n), commissionBp: 0, commission: e(0n), commissionVat: e(0n),
  net: e(net), total: e(total), platformDiscount: e(0n), sellerDiscount: e(0n),
});

describe("splitInstructions: min(net, share) and exact sums", () => {
  const ids = new Map([["A", "so-a"], ["B", "so-b"]]);
  const subs = new Map<string, string | null>([["A", "m-a"], ["B", null]]);
  it("net == share gives the seller the share and the platform 0; net below share caps at net; net above share caps at share", () => {
    const out = splitInstructions([seller("A", 1_000n, 1_000n), seller("B", 1_000n, 400n)], e(2_000n), ids, subs);
    expect(out[0]?.sellerAmount.amountMinor).toBe(1_000n);
    expect(out[0]?.platformAmount.amountMinor).toBe(0n);
    expect(out[1]?.sellerAmount.amountMinor).toBe(400n);
    expect(out[1]?.platformAmount.amountMinor).toBe(600n);
    const capped = splitInstructions([seller("A", 1_000n, 5_000n)], e(1_000n), ids, subs);
    expect(capped[0]?.sellerAmount.amountMinor).toBe(1_000n);
    expect(capped[0]?.platformAmount.amountMinor).toBe(0n);
  });
  it("net one piastre under the share is taken whole; one over is capped to the share", () => {
    expect(splitInstructions([seller("A", 1_000n, 999n)], e(1_000n), ids, subs)[0]?.sellerAmount.amountMinor).toBe(999n);
    expect(splitInstructions([seller("A", 1_000n, 1_001n)], e(1_000n), ids, subs)[0]?.sellerAmount.amountMinor).toBe(1_000n);
  });
  it("store credit shrinks every share by largest remainder, ties to the lowest index (1 piastre across 2 equal sellers)", () => {
    const out = splitInstructions([seller("A", 500n, 500n), seller("B", 500n, 500n)], e(1n), ids, subs);
    expect(out.map((o) => o.sellerAmount.amountMinor + o.platformAmount.amountMinor)).toEqual([1n, 0n]);
  });
  it("zero external amount gives all-zero instructions and keeps ids and sub-merchant refs mapped in order", () => {
    const out = splitInstructions([seller("A", 500n, 500n), seller("B", 500n, 500n)], e(0n), ids, subs);
    expect(out.map((o) => [o.sellerOrderId, o.storeId, o.subMerchantRef, o.sellerAmount.amountMinor, o.platformAmount.amountMinor])).toEqual([
      ["so-a", "A", "m-a", 0n, 0n], ["so-b", "B", null, 0n, 0n],
    ]);
  });
  it("a store with total 0 among others gets nothing", () => {
    const out = splitInstructions([seller("A", 0n, 0n), seller("B", 700n, 700n)], e(700n), ids, subs);
    expect(out[0]?.sellerAmount.amountMinor).toBe(0n);
    expect(out[1]?.sellerAmount.amountMinor).toBe(700n);
  });
  it("PROPERTY: instructions sum exactly to the external amount, seller <= net, platform >= 0, and share = total when no credit used", () => {
    const sellerArb = fc.record({ total: fc.bigInt({ min: 1n, max: 10n ** 12n }), frac: fc.integer({ min: 0, max: 120 }) });
    fc.assert(fc.property(fc.array(sellerArb, { minLength: 1, maxLength: 6 }), fc.integer({ min: 0, max: 100 }), (xs, pct) => {
      const ss = xs.map((x, i) => seller(`S${String(i)}`, x.total, (x.total * BigInt(x.frac)) / 100n));
      const totals = ss.reduce((a, s) => a + s.total.amountMinor, 0n);
      const external = (totals * BigInt(pct)) / 100n;
      const out = splitInstructions(ss, e(external), new Map(), new Map());
      const sum = out.reduce((a, o) => a + o.sellerAmount.amountMinor + o.platformAmount.amountMinor, 0n);
      expect(sum).toBe(external);
      out.forEach((o, i) => {
        expect(o.platformAmount.amountMinor >= 0n).toBe(true);
        expect(o.sellerAmount.amountMinor <= (ss[i]?.net.amountMinor ?? 0n)).toBe(true);
      });
      if (pct === 100) out.forEach((o, i) => { expect(o.sellerAmount.amountMinor + o.platformAmount.amountMinor).toBe(ss[i]?.total.amountMinor); });
    }), { numRuns: 500 });
  });
  it("PROPERTY: sellerAmounts parts reconcile (commission + VAT + net = base - seller shipping waiver) for random inputs", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 0, max: 2_000 }), (items, bp, vbp) => {
      const a = sellerAmounts(store({ items }), bp, vbp);
      expect(a.commission.amountMinor + a.commissionVat.amountMinor + a.net.amountMinor).toBe(items);
    }), { numRuns: 500 });
  });
});
