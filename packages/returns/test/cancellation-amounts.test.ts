import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money, percentOf } from "@outlet/money";
import { ReturnsError, cancellationAmounts, refundDraft } from "../src/index.js";

const STORE = "01900000-0000-7000-8000-0000000000a1";
const CLEARING = "psp_clearing:EG:EGP:paymob";

/** A seller order as checkout builds it (split.ts): commission on goods after seller discounts, net = base - commission - VAT - seller delivery waiver. */
const sellerOrder = fc
  .record({
    items: fc.bigInt({ min: 0n, max: 50_000_000n }),
    ship: fc.bigInt({ min: 0n, max: 20_000n }),
    bp: fc.integer({ min: 0, max: 3000 }),
    sdGoodsPct: fc.integer({ min: 0, max: 100 }),
    pdGoodsPct: fc.integer({ min: 0, max: 100 }),
    shipDiscPct: fc.integer({ min: 0, max: 100 }),
    shipBySeller: fc.boolean(),
  })
  .map((r) => {
    const sdGoods = (r.items * BigInt(r.sdGoodsPct)) / 100n;
    const pdGoods = ((r.items - sdGoods) * BigInt(r.pdGoodsPct)) / 100n;
    const shipDisc = (r.ship * BigInt(r.shipDiscPct)) / 100n;
    const shipVat = (r.ship * 1400n) / 11400n;
    const base = r.items - sdGoods;
    const commission = percentOf(money(base, "EGP"), BigInt(r.bp)).amountMinor;
    const commissionVat = percentOf(money(commission, "EGP"), 1400n).amountMinor;
    const sd = sdGoods + (r.shipBySeller ? shipDisc : 0n);
    const pd = pdGoods + (r.shipBySeller ? 0n : shipDisc);
    const net = base - commission - commissionVat - (r.shipBySeller ? shipDisc : 0n);
    return { currency: "EGP" as const, total: r.items - pd - sd + r.ship, shipping: r.ship, shippingVat: shipVat, commission, commissionVat, sellerNet: net, platformDiscount: pd, deliveryDiscount: shipDisc };
  })
  .filter((s) => s.sellerNet >= 0n);

describe("cancellationAmounts (ledger spec 4.1 reversed by differencing)", () => {
  it("property: the refund row meets the refunds CHECKs and refund entry + residual negate the order_recognised share exactly (trial balance 0)", () => {
    fc.assert(
      fc.property(sellerOrder, (so) => {
        const a = cancellationAmounts(so);
        const f = a.refund;
        // refunds table CHECKs
        expect(f.amount.amountMinor).toBe(so.total);
        expect(f.amount.amountMinor).toBe(f.goods.amountMinor + f.deliveryFee.amountMinor);
        expect(f.goods.amountMinor).toBe(f.seller.amountMinor + f.commission.amountMinor + f.commissionVat.amountMinor);
        for (const x of [f.goods, f.deliveryFee, f.deliveryVat, f.commission, f.commissionVat, f.seller]) expect(x.amountMinor >= 0n).toBe(true);
        expect(f.deliveryVat.amountMinor <= f.deliveryFee.amountMinor).toBe(true);
        for (const x of [a.residual.commission, a.residual.vat, a.residual.shippingNet, a.residual.platformPromo]) expect(x >= 0n).toBe(true);
        // L2: the refund reports the delivery the shopper actually paid
        expect(f.deliveryFee.amountMinor).toBe(so.shipping - so.deliveryDiscount < so.total ? so.shipping - so.deliveryDiscount : so.total);

        // combine the two entries per account
        const sum = new Map<string, bigint>();
        const put = (k: string, v: bigint): void => { sum.set(k, (sum.get(k) ?? 0n) + v); };
        if (f.amount.amountMinor > 0n) {
          const d = refundDraft({
            marketId: "EG", refundId: "r1", storeId: STORE, occurredAt: new Date(0), currency: "EGP", sellerAccount: "seller_pending", seller: f.seller, commission: f.commission,
            commissionVat: f.commissionVat, deliveryFee: f.deliveryFee, deliveryVat: f.deliveryVat, destinations: [{ route: "psp_original", amount: f.amount, accountCode: CLEARING }],
          });
          for (const p of d.postings) put(p.accountCode, p.amount.amountMinor);
        }
        const r = a.residual;
        put(`seller_pending:EG:EGP:${STORE}`, r.seller);
        put("commission_revenue:EG:EGP", r.commission);
        put("platform_vat_output:EG:EGP", r.vat);
        put("shipping_revenue:EG:EGP", r.shippingNet);
        put("promo_expense_platform:EG:EGP", -r.platformPromo);
        const get = (k: string): bigint => [...sum].filter(([code]) => code.startsWith(k)).reduce((x, [, v]) => x + v, 0n);
        // exact negation of the seller order's share of order_recognised (Cr seller net, commission, VAT, delivery net; Dr promo, Dr clearing)
        expect(get("seller_pending")).toBe(so.sellerNet);
        expect(get("commission_revenue")).toBe(so.commission);
        expect(get("platform_vat_output")).toBe(so.commissionVat + so.shippingVat);
        expect(get("shipping_revenue")).toBe(so.shipping - so.shippingVat);
        expect(get("promo_expense_platform")).toBe(-so.platformDiscount);
        expect(get("psp_clearing")).toBe(-so.total);
        expect([...sum.values()].reduce((x, v) => x + v, 0n)).toBe(0n);
      }),
      { numRuns: 500 },
    );
  });

  it("delivery fully waived by the platform: the refund reports goods only (no delivery fee paid), the residual reverses the delivery revenue", () => {
    const a = cancellationAmounts({ currency: "EGP", total: 10_000n, shipping: 6000n, shippingVat: 737n, commission: 1000n, commissionVat: 140n, sellerNet: 8860n, platformDiscount: 6000n, deliveryDiscount: 6000n });
    expect([a.refund.goods.amountMinor, a.refund.deliveryFee.amountMinor, a.refund.deliveryVat.amountMinor, a.refund.seller.amountMinor]).toEqual([10_000n, 0n, 0n, 8860n]);
    expect(a.residual).toEqual({ seller: 0n, commission: 0n, vat: 737n, shippingNet: 5263n, platformPromo: 6000n });
  });

  it("half the delivery waived: fee and its VAT are the paid part (VAT floor-proportional)", () => {
    const a = cancellationAmounts({ currency: "EGP", total: 13_000n, shipping: 6000n, shippingVat: 737n, commission: 1000n, commissionVat: 140n, sellerNet: 8860n, platformDiscount: 3000n, deliveryDiscount: 3000n });
    expect([a.refund.deliveryFee.amountMinor, a.refund.deliveryVat.amountMinor, a.refund.goods.amountMinor]).toEqual([3000n, 368n, 10_000n]);
    expect(() => cancellationAmounts({ currency: "EGP", total: 13_000n, shipping: 6000n, shippingVat: 737n, commission: 1000n, commissionVat: 140n, sellerNet: 8860n, platformDiscount: 3000n, deliveryDiscount: 6001n })).toThrow(ReturnsError);
  });

  it("nothing paid (100% platform voucher): no refund amount, the residual reverses everything", () => {
    const a = cancellationAmounts({ currency: "EGP", total: 0n, shipping: 0n, shippingVat: 0n, commission: 1000n, commissionVat: 140n, sellerNet: 8860n, platformDiscount: 10_000n });
    expect(a.refund.amount.amountMinor).toBe(0n);
    expect(a.residual).toEqual({ seller: 8860n, commission: 1000n, vat: 140n, shippingNet: 0n, platformPromo: 10_000n });
  });

  it("refuses a snapshot that does not match its order_recognised share (fail closed)", () => {
    const ok = { currency: "EGP" as const, total: 10_000n, shipping: 0n, shippingVat: 0n, commission: 1000n, commissionVat: 140n, sellerNet: 8860n, platformDiscount: 0n };
    expect(() => cancellationAmounts({ ...ok, sellerNet: 9000n })).toThrow(ReturnsError);
    expect(() => cancellationAmounts({ ...ok, total: -1n })).toThrow(ReturnsError);
    expect(() => cancellationAmounts({ ...ok, shippingVat: 1n })).toThrow(ReturnsError);
    expect(() => cancellationAmounts({ ...ok, platformDiscount: 5n })).toThrow(ReturnsError);
  });
});
