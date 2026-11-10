import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { accountCode } from "@outlet/ledger";
import { money, percentOf } from "@outlet/money";
import {
  ReturnsError, addBusinessDays, cancellationAmounts, checkEligibility, computeRefund, cumulativeDiscount, decideResolution, isSerialReturner, returnShippingPayer, routeRefund, tenderSplit, windowEnd,
} from "../src/index.js";
import type { CalcInput, CancelledSellerOrder, ReturnedLine, RouteInput } from "../src/index.js";

// Hand-run mutation pass (StrykerJS cannot run in the sandbox). Exact expected values are hand-computed.
const m = (n: bigint) => money(n, "EGP");
const L = (o: Partial<ReturnedLine> = {}): ReturnedLine => ({ orderLineId: "l1", unitPrice: 10_000n, qty: 3, qtyAlreadyReturned: 0, returnQty: 1, discount: 1_000n, ...o });
const I = (o: Partial<CalcInput> = {}): CalcInput => ({ currency: "EGP", lines: [L()], base: 29_000n, goodsRefundedBefore: 0n, commissionBp: 1000, commissionVatBp: 1400, delivery: null, ...o });
const code = (r: unknown): unknown => (r as ReturnsError).code;
const thrown = (f: () => unknown): unknown => { try { f(); } catch (x) { return x; } return undefined; };

describe("cumulativeDiscount", () => {
  it("floors the cumulative share; the three units of 1000/3 are 333 + 333 + 334", () => {
    expect([1, 2, 3].map((k) => cumulativeDiscount(1_000n, 3, k))).toEqual([333n, 666n, 1_000n]);
    expect(cumulativeDiscount(1_000n, 3, 0)).toBe(0n);
  });
  it("multiplies before dividing (a divide-first mutation gives 0 here)", () => {
    expect(cumulativeDiscount(5n, 10, 5)).toBe(2n);
  });
});

describe("computeRefund: exact amounts", () => {
  it("one of three units: voucher share, commission and VAT by differencing, seller residual", () => {
    // gross 10000, share 333 -> goods 9667; before 29000 after 19333; c: 2900 - 1933 = 967; vat: 406 - 271 = 135; seller 9667-967-135
    const r = computeRefund(I());
    expect(r.lines[0]).toMatchObject({ qty: 1, gross: 10_000n, discountShare: 333n, amount: 9_667n, commission: 967n, commissionVat: 135n });
    expect(r.goods.amountMinor).toBe(9_667n);
    expect(r.commission.amountMinor).toBe(967n);
    expect(r.commissionVat.amountMinor).toBe(135n);
    expect(r.seller.amountMinor).toBe(8_565n);
    expect(r.total.amountMinor).toBe(9_667n);
    expect(r.deliveryFee.amountMinor).toBe(0n);
    expect(r.deliveryVat.amountMinor).toBe(0n);
  });
  it("later units use the already-returned offset: second unit share 333, third 334", () => {
    expect(computeRefund(I({ lines: [L({ qtyAlreadyReturned: 1 })], goodsRefundedBefore: 9_667n })).lines[0]?.discountShare).toBe(333n);
    expect(computeRefund(I({ lines: [L({ qtyAlreadyReturned: 2 })], goodsRefundedBefore: 19_334n })).lines[0]?.discountShare).toBe(334n);
  });
  it("delivery fee is added to the total (not to goods) and VAT is reported separately; null means zero", () => {
    const r = computeRefund(I({ delivery: { gross: 6_000n, vat: 737n } }));
    expect(r.deliveryFee.amountMinor).toBe(6_000n);
    expect(r.deliveryVat.amountMinor).toBe(737n);
    expect(r.goods.amountMinor).toBe(9_667n);
    expect(r.total.amountMinor).toBe(15_667n);
    expect(r.seller.amountMinor).toBe(8_565n);
  });
  it("qty guards: 0 returns nothing; exactly the remaining qty passes; one more is refused", () => {
    expect(code(thrown(() => computeRefund(I({ lines: [L({ returnQty: 0 })] }))))).toBe("nothing_to_return");
    expect(code(thrown(() => computeRefund(I({ lines: [L({ qtyAlreadyReturned: 1, returnQty: 3 })], goodsRefundedBefore: 0n }))))).toBe("qty_exceeds_purchased");
    expect(() => computeRefund(I({ lines: [L({ qtyAlreadyReturned: 1, returnQty: 2 })], goodsRefundedBefore: 9_667n }))).not.toThrow();
  });
  it("refund_exceeds_paid at one piastre over the remaining base, ok exactly at it", () => {
    // goods 9667: before = base - refundedBefore
    expect(() => computeRefund(I({ base: 9_667n }))).not.toThrow();
    expect(code(thrown(() => computeRefund(I({ base: 9_666n }))))).toBe("refund_exceeds_paid");
    expect(code(thrown(() => computeRefund(I({ base: 29_000n, goodsRefundedBefore: 19_334n }))))).toBe("refund_exceeds_paid");
    expect(() => computeRefund(I({ base: 29_000n, goodsRefundedBefore: 19_333n }))).not.toThrow();
  });
  it("seller_net_negative when commission plus VAT exceed the goods, fine at exactly zero", () => {
    expect(code(thrown(() => computeRefund(I({ base: 9_667n, commissionBp: 10_000 }))))).toBe("seller_net_negative");
    const zero = computeRefund(I({ base: 9_667n, commissionBp: 10_000, commissionVatBp: 0 }));
    expect(zero.seller.amountMinor).toBe(0n);
    expect(zero.commission.amountMinor).toBe(9_667n);
  });
  it("a fully discounted unit (goods 0) allocates nothing and does not throw", () => {
    const r = computeRefund(I({ lines: [L({ qty: 1, discount: 10_000n })], base: 5_000n }));
    expect(r.goods.amountMinor).toBe(0n);
    expect(r.lines[0]).toMatchObject({ amount: 0n, commission: 0n, commissionVat: 0n });
    expect(r.seller.amountMinor).toBe(0n);
  });
  it("zero commission and zero VAT bp leave line commissions at 0 and seller = goods", () => {
    const r = computeRefund(I({ commissionBp: 0, commissionVatBp: 0 }));
    expect(r.lines[0]).toMatchObject({ commission: 0n, commissionVat: 0n });
    expect(r.seller.amountMinor).toBe(9_667n);
  });
  it("banker's rounding in the commission differencing: .5 goes to even (c(25)=2, c(35)=4)", () => {
    // refund 10 of base 35: c(35)=3.5->4, after=25: c(25)=2.5->2 => 2 (half-up would give 4-3=1)
    const r = computeRefund(I({ lines: [L({ qty: 1, unitPrice: 10n, discount: 0n })], base: 35n, commissionVatBp: 0 }));
    expect(r.commission.amountMinor).toBe(2n);
    const r2 = computeRefund(I({ lines: [L({ qty: 1, unitPrice: 25n, discount: 0n })], base: 25n, commissionVatBp: 0 }));
    expect(r2.commission.amountMinor).toBe(2n);
  });
  it("remainder assignment is deterministic: the leftover piastre goes to the first of equal lines", () => {
    const base = 10_000n;
    const r = computeRefund(I({ lines: [L({ orderLineId: "a", qty: 1, unitPrice: 5_000n, discount: 0n }), L({ orderLineId: "b", qty: 1, unitPrice: 5_000n, discount: 0n })], base, commissionBp: 1, commissionVatBp: 0 }));
    expect(r.commission.amountMinor).toBe(1n);
    expect(r.lines.map((l) => l.commission)).toEqual([1n, 0n]);
    // repeated calls identical
    expect(computeRefund(I({ lines: [L({ orderLineId: "a", qty: 1, unitPrice: 5_000n, discount: 0n }), L({ orderLineId: "b", qty: 1, unitPrice: 5_000n, discount: 0n })], base, commissionBp: 1, commissionVatBp: 0 })).lines.map((l) => l.commission)).toEqual([1n, 0n]);
  });
  it("largest values stay exact (10^15 piastres)", () => {
    const big = 10n ** 15n;
    const r = computeRefund(I({ lines: [L({ qty: 1, unitPrice: big, discount: 0n })], base: big }));
    expect(r.commission.amountMinor).toBe(big / 10n);
    expect(r.commissionVat.amountMinor).toBe(14n * 10n ** 12n);
  });
});

describe("computeRefund: tiny-amount rounding edge (platform absorbs the rounding piastre)", () => {
  it("a 1-piastre goods refund whose differenced commission and VAT would be 1 + 1 is not refused: seller 0, commission + VAT = 1", () => {
    // base 503404, commission 18.35%, VAT 11.31%: c diff = 1, v diff = 1 -> 1 - 1 - 1 < 0, clamped
    const r = computeRefund(I({ lines: [L({ qty: 1, unitPrice: 1n, discount: 0n })], base: 503_404n, commissionBp: 1835, commissionVatBp: 1131 }));
    expect(r.goods.amountMinor).toBe(1n);
    expect(r.seller.amountMinor).toBe(0n);
    expect(r.commission.amountMinor + r.commissionVat.amountMinor).toBe(1n);
  });
  it("PROPERTY: single-piastre steps never throw, seller >= 0, and each step stays within 1 piastre of the unclamped split", () => {
    fc.assert(fc.property(fc.bigInt({ min: 2n, max: 2_000_000n }), fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: 0, max: 2_000 }), (base, cbp, vbp) => {
      const r = computeRefund(I({ lines: [L({ qty: 1, unitPrice: 1n, discount: 0n })], base, commissionBp: cbp, commissionVatBp: vbp }));
      const c = (x: bigint): bigint => percentOf(m(x), BigInt(cbp)).amountMinor;
      const v = (x: bigint): bigint => percentOf(m(x), BigInt(vbp)).amountMinor;
      const rawC = c(base) - c(base - 1n); const rawV = v(c(base)) - v(c(base - 1n));
      expect(r.seller.amountMinor >= 0n).toBe(true);
      expect(r.commission.amountMinor + r.commissionVat.amountMinor).toBe(1n - r.seller.amountMinor);
      expect(rawC + rawV - (r.commission.amountMinor + r.commissionVat.amountMinor) <= 1n).toBe(true);
    }), { numRuns: 500 });
  });
});

describe("computeRefund: properties", () => {
  const cartArb = fc.array(fc.record({ unit: fc.bigInt({ min: 1_000n, max: 2_000_000n }), qty: fc.integer({ min: 1, max: 5 }), pct: fc.integer({ min: 0, max: 90 }) }), { minLength: 1, maxLength: 5 });
  it("per-line allocation sums exactly to the refund total, commission and VAT (random carts, random multi-line returns)", () => {
    fc.assert(fc.property(cartArb, fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: 0, max: 2_000 }), (cart, cbp, vbp) => {
      const lines = cart.map((c, i) => L({ orderLineId: `l${String(i)}`, unitPrice: c.unit, qty: c.qty, returnQty: 1 + (i % c.qty), discount: (c.unit * BigInt(c.qty) * BigInt(c.pct)) / 100n }));
      const base = cart.reduce((a, c, i) => a + c.unit * BigInt(c.qty) - (lines[i]?.discount ?? 0n), 0n);
      const r = computeRefund(I({ lines, base, commissionBp: cbp, commissionVatBp: vbp }));
      expect(r.lines.reduce((a, l) => a + l.amount, 0n)).toBe(r.goods.amountMinor);
      expect(r.lines.reduce((a, l) => a + l.commission, 0n)).toBe(r.commission.amountMinor);
      expect(r.lines.reduce((a, l) => a + l.commissionVat, 0n)).toBe(r.commissionVat.amountMinor);
      expect(r.lines.reduce((a, l) => a + l.gross - l.discountShare, 0n)).toBe(r.goods.amountMinor);
      expect(r.goods.amountMinor - r.commission.amountMinor - r.commissionVat.amountMinor).toBe(r.seller.amountMinor);
    }), { numRuns: 500 });
  });
  it("I10: returning every unit one at a time refunds exactly the base, the voucher and the full commission", () => {
    fc.assert(fc.property(cartArb, fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: 0, max: 2_000 }), (cart, cbp, vbp) => {
      const discs = cart.map((c) => (c.unit * BigInt(c.qty) * BigInt(c.pct)) / 100n);
      const base = cart.reduce((a, c, i) => a + c.unit * BigInt(c.qty) - (discs[i] ?? 0n), 0n);
      let refunded = 0n; let comm = 0n; let vat = 0n; const shares = cart.map(() => 0n);
      cart.forEach((c, i) => {
        for (let k = 0; k < c.qty; k++) {
          const r = computeRefund(I({ lines: [L({ unitPrice: c.unit, qty: c.qty, qtyAlreadyReturned: k, returnQty: 1, discount: discs[i] ?? 0n })], base, goodsRefundedBefore: refunded, commissionBp: cbp, commissionVatBp: vbp }));
          refunded += r.goods.amountMinor; comm += r.commission.amountMinor; vat += r.commissionVat.amountMinor; shares[i] = (shares[i] ?? 0n) + (r.lines[0]?.discountShare ?? 0n);
        }
      });
      expect(refunded).toBe(base);
      expect(shares).toEqual(discs);
      const c0 = percentOf(m(base), BigInt(cbp)).amountMinor;
      expect(comm).toBe(c0);
      expect(vat).toBe(percentOf(m(c0), BigInt(vbp)).amountMinor);
    }), { numRuns: 300 });
  });
});

describe("tenderSplit", () => {
  it("splits on the tender ratio: 100 of 1000 with 300 credit paid gives 30 credit / 70 external", () => {
    const s = tenderSplit(m(100n), 0n, 300n, 700n);
    expect([s.credit.amountMinor, s.external.amountMinor]).toEqual([30n, 70n]);
  });
  it("cumulative differencing with half-even: 5 then 5 of 1000 gives credit 2 then 1 (total 3, exact)", () => {
    expect(tenderSplit(m(5n), 0n, 300n, 700n).credit.amountMinor).toBe(2n);
    expect(tenderSplit(m(5n), 5n, 300n, 700n).credit.amountMinor).toBe(1n);
  });
  it("refunding exactly the grand total passes (credit = creditPaid); one over, or a zero grand, is refused", () => {
    expect(tenderSplit(m(1_000n), 0n, 300n, 700n).credit.amountMinor).toBe(300n);
    expect(code(thrown(() => tenderSplit(m(1_001n), 0n, 300n, 700n)))).toBe("refund_exceeds_paid");
    expect(code(thrown(() => tenderSplit(m(1n), 1_000n, 300n, 700n)))).toBe("refund_exceeds_paid");
    expect(code(thrown(() => tenderSplit(m(0n), 0n, 0n, 0n)))).toBe("refund_exceeds_paid");
  });
  it("PROPERTY: any sequence of partial refunds returns exactly creditPaid to credit and the rest to external", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 8 }), (credit, ext, cuts) => {
      const grand = credit + ext;
      const total = cuts.reduce((a, c) => a + c, 0);
      let done = 0n; let c = 0n; let x = 0n;
      cuts.forEach((w, i) => {
        const part = i === cuts.length - 1 ? grand - done : (grand * BigInt(w)) / BigInt(total + 1);
        const s = tenderSplit(m(part), done, credit, ext);
        expect(s.credit.amountMinor + s.external.amountMinor).toBe(part);
        expect(s.credit.amountMinor >= 0n && s.external.amountMinor >= 0n).toBe(true);
        done += part; c += s.credit.amountMinor; x += s.external.amountMinor;
      });
      expect([c, x]).toEqual([credit, ext]);
    }), { numRuns: 300 });
  });
});

describe("cancellationAmounts", () => {
  const S = (o: Partial<CancelledSellerOrder> = {}): CancelledSellerOrder => ({
    currency: "EGP", total: 10_600n, shipping: 600n, shippingVat: 74n, commission: 1_000n, commissionVat: 140n, sellerNet: 8_860n, platformDiscount: 0n, ...o,
  });
  it("undiscounted order: refund is the total, residual is all zero", () => {
    const r = cancellationAmounts(S());
    expect(r.refund).toEqual({ amount: m(10_600n), goods: m(10_000n), deliveryFee: m(600n), deliveryVat: m(74n), commission: m(1_000n), commissionVat: m(140n), seller: m(8_860n) });
    expect(r.residual).toEqual({ seller: 0n, commission: 0n, vat: 0n, shippingNet: 0n, platformPromo: 0n });
  });
  it("platform discount stays in the residual (seller_pending reversed by it) and debits equal the promo", () => {
    const r = cancellationAmounts(S({ total: 9_600n, platformDiscount: 1_000n }));
    expect(r.refund.goods.amountMinor).toBe(9_000n);
    expect(r.refund.seller.amountMinor).toBe(7_860n);
    expect(r.residual).toEqual({ seller: 1_000n, commission: 0n, vat: 0n, shippingNet: 0n, platformPromo: 1_000n });
  });
  it("seller-funded delivery waiver: fee and fee VAT are proportional (floor), residual seller is negative, still balanced", () => {
    const r = cancellationAmounts(S({ total: 10_400n, sellerNet: 8_660n, deliveryDiscount: 200n }));
    expect(r.refund.deliveryFee.amountMinor).toBe(400n);
    expect(r.refund.deliveryVat.amountMinor).toBe(49n);
    expect(r.residual).toEqual({ seller: -200n, commission: 0n, vat: 25n, shippingNet: 175n, platformPromo: 0n });
  });
  it("delivery discount equal to the shipping is allowed (fee 0); one more is refused", () => {
    const r = cancellationAmounts(S({ total: 10_000n, sellerNet: 8_260n, deliveryDiscount: 600n }));
    expect(r.refund.deliveryFee.amountMinor).toBe(0n);
    expect(r.refund.deliveryVat.amountMinor).toBe(0n);
    expect(code(thrown(() => cancellationAmounts(S({ deliveryDiscount: 601n }))))).toBe("refund_exceeds_paid");
  });
  it("shipping VAT equal to shipping is allowed, one more is refused; zero shipping divides nothing", () => {
    expect(() => cancellationAmounts(S({ shippingVat: 600n, sellerNet: 8_860n }))).not.toThrow();
    expect(code(thrown(() => cancellationAmounts(S({ shippingVat: 601n }))))).toBe("refund_exceeds_paid");
    const r = cancellationAmounts({ currency: "EGP", total: 10_000n, shipping: 0n, shippingVat: 0n, commission: 1_000n, commissionVat: 140n, sellerNet: 8_860n, platformDiscount: 0n });
    expect(r.refund.deliveryVat.amountMinor).toBe(0n);
  });
  it("every negative input is refused, a zero is not", () => {
    for (const k of ["total", "shipping", "shippingVat", "commission", "commissionVat", "sellerNet", "platformDiscount"] as const) {
      expect(code(thrown(() => cancellationAmounts(S({ [k]: -1n }))))).toBe("refund_exceeds_paid");
    }
    expect(code(thrown(() => cancellationAmounts(S({ deliveryDiscount: -1n }))))).toBe("refund_exceeds_paid");
  });
  it("a snapshot that does not match its order_recognised share (net off by one) is refused", () => {
    expect(code(thrown(() => cancellationAmounts(S({ sellerNet: 8_861n }))))).toBe("refund_exceeds_paid");
    expect(code(thrown(() => cancellationAmounts(S({ sellerNet: 8_859n }))))).toBe("refund_exceeds_paid");
  });
});

describe("routeRefund: BNPL is provider-only", () => {
  const base = (o: Partial<RouteInput> = {}): RouteInput => ({
    marketId: "EG", userId: "u1", method: "bnpl", clearingOwner: "valu", pspReversible: true, refund: m(1_000n), credit: m(0n), external: m(1_000n), creditLegs: [], choice: null, ...o,
  });
  const bnpl = accountCode({ type: "bnpl_clearing", market: "EG", currency: "EGP", owner: "valu" });
  it("default and 'original' route to the provider's bnpl_clearing account, never psp_clearing or store credit", () => {
    for (const choice of [null, "original"] as const) {
      const d = routeRefund(base({ choice }));
      expect(d).toEqual([{ route: "bnpl_provider", amount: m(1_000n), accountCode: bnpl }]);
    }
  });
  it("a store-credit choice is refused, not ignored, whatever else is set", () => {
    for (const pspReversible of [true, false]) expect(code(thrown(() => routeRefund(base({ choice: "store_credit", pspReversible }))))).toBe("bnpl_provider_only");
  });
  it("without a clearing owner the BNPL leg fails closed", () => {
    expect(code(thrown(() => routeRefund(base({ clearingOwner: null }))))).toBe("not_found");
  });
  it("PROPERTY: for any BNPL refund the external part goes only to bnpl_provider; credit legs go back to their own account", () => {
    const leg = accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: "u1", sub: "goodwill" });
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.constantFrom(null, "original" as const), (credit, ext, choice) => {
      const d = routeRefund(base({ refund: m(credit + ext), credit: m(credit), external: m(ext), creditLegs: credit > 0n ? [{ accountCode: leg, amount: m(credit) }] : [], choice }));
      expect(d.filter((x) => x.route === "bnpl_provider").reduce((a, x) => a + x.amount.amountMinor, 0n)).toBe(ext);
      expect(d.filter((x) => x.route !== "bnpl_provider").every((x) => x.route === "store_credit" && x.accountCode === leg)).toBe(true);
      expect(d.reduce((a, x) => a + x.amount.amountMinor, 0n)).toBe(credit + ext);
    }), { numRuns: 200 });
  });
  it("tender parts that do not sum to the refund are refused", () => {
    expect(code(thrown(() => routeRefund(base({ refund: m(1_001n) }))))).toBe("refund_exceeds_paid");
  });
});

describe("statutory windows end at the last millisecond of the Cairo day", () => {
  const winter = new Date("2030-01-01T10:00:00Z");
  it("7, 14 and 30 days: exact inclusive ends (winter UTC+2)", () => {
    expect(windowEnd(winter, 7).toISOString()).toBe("2030-01-08T21:59:59.999Z");
    expect(windowEnd(winter, 14).toISOString()).toBe("2030-01-15T21:59:59.999Z");
    expect(windowEnd(winter, 30).toISOString()).toBe("2030-01-31T21:59:59.999Z");
  });
  it("delivered at 00:30 Cairo counts from that Cairo day, not the previous UTC day", () => {
    expect(windowEnd(new Date("2029-12-31T22:30:00Z"), 14).toISOString()).toBe("2030-01-15T21:59:59.999Z");
    expect(windowEnd(new Date("2030-01-01T21:59:59Z"), 14).toISOString()).toBe("2030-01-15T21:59:59.999Z");
    expect(windowEnd(new Date("2030-01-01T22:00:00Z"), 14).toISOString()).toBe("2030-01-16T21:59:59.999Z");
  });
  it("a window that crosses the Egypt DST start uses the summer offset at its end (+3)", () => {
    // DST starts Fri 26 Apr 2030; delivered 20 Apr 12:00 Cairo; day 14 = 4 May ends 23:59:59.999 +03:00
    expect(windowEnd(new Date("2030-04-20T10:00:00Z"), 14).toISOString()).toBe("2030-05-04T20:59:59.999Z");
  });
  it("changed-mind uses 14 days, defect uses 30, and the instant after each end is refused", () => {
    const base = { deliveredAt: winter, nonReturnable: false, disclosedDefect: false, evidenceCount: 1 };
    expect(checkEligibility({ ...base, reason: "changed_mind", now: new Date("2030-01-15T21:59:59.999Z") }).ok).toBe(true);
    expect(checkEligibility({ ...base, reason: "changed_mind", now: new Date("2030-01-15T22:00:00.000Z") })).toEqual({ ok: false, code: "window_closed" });
    expect(checkEligibility({ ...base, reason: "defect_worse_than_shown", now: new Date("2030-01-31T21:59:59.999Z") }).ok).toBe(true);
    expect(checkEligibility({ ...base, reason: "defect_worse_than_shown", now: new Date("2030-01-31T22:00:00.000Z") })).toEqual({ ok: false, code: "window_closed" });
  });
  it("not delivered is refused before any other rule", () => {
    expect(checkEligibility({ reason: "changed_mind", deliveredAt: null, now: winter, nonReturnable: true, disclosedDefect: true, evidenceCount: 0 })).toEqual({ ok: false, code: "not_delivered" });
  });
  it("business days skip Friday and Saturday", () => {
    expect(addBusinessDays(new Date("2030-01-03T09:00:00Z"), 1).toISOString()).toBe("2030-01-06T09:00:00.000Z"); // Thu -> Sun
    expect(addBusinessDays(new Date("2030-01-06T09:00:00Z"), 5).toISOString()).toBe("2030-01-13T09:00:00.000Z"); // Sun -> next Sun
    expect(addBusinessDays(new Date("2030-01-06T09:00:00Z"), 0).toISOString()).toBe("2030-01-06T09:00:00.000Z");
  });
});

describe("serial returner and resolution boundaries", () => {
  it("needs >= 10 delivered orders and STRICTLY more than 60% returned", () => {
    expect(isSerialReturner(10, 6)).toBe(false);
    expect(isSerialReturner(10, 7)).toBe(true);
    expect(isSerialReturner(9, 9)).toBe(false);
    expect(isSerialReturner(10, 10)).toBe(true);
  });
  it("return shipping payer: seller for defects, serial returners pay even with Plus, exchange or Plus is free", () => {
    expect(returnShippingPayer("defect_worse_than_shown", "refund", false, true)).toBe("seller");
    expect(returnShippingPayer("changed_mind", "refund", true, true)).toBe("shopper");
    expect(returnShippingPayer("changed_mind", "refund", true, false)).toBe("free");
    expect(returnShippingPayer("changed_mind", "exchange", false, false)).toBe("free");
    expect(returnShippingPayer("changed_mind", "refund", false, false)).toBe("shopper");
  });
  it("exchange-first only for size reasons with stock and no refund preference", () => {
    expect(decideResolution("too_small", true, false)).toBe("exchange");
    expect(decideResolution("too_small", true, true)).toBe("refund");
    expect(decideResolution("too_small", false, false)).toBe("refund");
    expect(decideResolution("changed_mind", true, false)).toBe("refund");
  });
});
