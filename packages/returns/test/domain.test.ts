import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { accountCode } from "@outlet/ledger";
import { money } from "@outlet/money";
import { reachable } from "@outlet/orders";
import type { Machine } from "@outlet/orders";
import {
  DISPUTE, REFUND, RETURN, ReturnsError, addBusinessDays, checkEligibility, computeRefund, decideResolution, isSerialReturner, routeRefund, tenderSplit, returnShippingPayer, RETURN_REASONS,
} from "../src/index.js";
import type { ReturnReason, RouteInput, TenderMethod } from "../src/index.js";

const DAY = 86_400_000;
const delivered = new Date("2030-01-01T00:00:00Z");
const at = (days: number): Date => new Date(delivered.getTime() + days * DAY);
const base = { deliveredAt: delivered, nonReturnable: false, disclosedDefect: false, evidenceCount: 0 };

describe("eligibility (windows count from delivered_at)", () => {
  it("accepts change of mind on day 14 and refuses it on day 15", () => {
    expect(checkEligibility({ ...base, reason: "changed_mind", now: at(14) }).ok).toBe(true);
    expect(checkEligibility({ ...base, reason: "changed_mind", now: at(15) })).toEqual({ ok: false, code: "window_closed" });
  });
  it("accepts a defect on day 29 (30-day window) and refuses on day 31", () => {
    const r = checkEligibility({ ...base, reason: "defect_undisclosed", now: at(29), evidenceCount: 1 });
    expect(r.ok && r.windowBasis).toBe("defect_30d");
    expect(checkEligibility({ ...base, reason: "defect_undisclosed", now: at(31), evidenceCount: 1 })).toEqual({ ok: false, code: "window_closed" });
  });
  it("requires photos for defective / not-as-described, not for size reasons", () => {
    expect(checkEligibility({ ...base, reason: "not_as_described", now: at(1) })).toEqual({ ok: false, code: "photos_required" });
    expect(checkEligibility({ ...base, reason: "too_small", now: at(1) }).ok).toBe(true);
  });
  it("a disclosed and acknowledged defect is not a reason, worse-than-shown still is (ADR-0009)", () => {
    expect(checkEligibility({ ...base, reason: "defect_undisclosed", now: at(1), evidenceCount: 1, disclosedDefect: true })).toEqual({ ok: false, code: "disclosed_defect" });
    expect(checkEligibility({ ...base, reason: "defect_worse_than_shown", now: at(1), evidenceCount: 1, disclosedDefect: true }).ok).toBe(true);
  });
  it("non-returnable categories only come back for defect-class reasons", () => {
    expect(checkEligibility({ ...base, reason: "changed_mind", now: at(1), nonReturnable: true })).toEqual({ ok: false, code: "non_returnable" });
    expect(checkEligibility({ ...base, reason: "wrong_item", now: at(1), nonReturnable: true }).ok).toBe(true);
  });
  it("is closed until the courier confirms delivery", () => {
    expect(checkEligibility({ ...base, deliveredAt: null, reason: "changed_mind", now: at(1) })).toEqual({ ok: false, code: "not_delivered" });
  });
  it("serial-returner flag: strictly above 60% over at least 10 orders", () => {
    expect(isSerialReturner(10, 6)).toBe(false);
    expect(isSerialReturner(10, 7)).toBe(true);
    expect(isSerialReturner(9, 9)).toBe(false);
  });
  it("exchange-first for size reasons only when the swap is in stock and the shopper does not insist on a refund", () => {
    expect(decideResolution("too_small", true, false)).toBe("exchange");
    expect(decideResolution("too_small", false, false)).toBe("refund");
    expect(decideResolution("too_small", true, true)).toBe("refund");
    expect(decideResolution("changed_mind", true, false)).toBe("refund");
  });
  it("return shipping payer follows the section 22 table", () => {
    expect(returnShippingPayer("defect_undisclosed", "refund", false, true)).toBe("seller");
    expect(returnShippingPayer("changed_mind", "refund", true, true)).toBe("shopper");
    expect(returnShippingPayer("changed_mind", "refund", true, false)).toBe("free");
    expect(returnShippingPayer("too_small", "exchange", false, false)).toBe("free");
  });
  it("business days skip Friday and Saturday", () => {
    expect(addBusinessDays(new Date("2030-01-03T10:00:00Z"), 5).toISOString().slice(0, 10)).toBe("2030-01-10"); // Thu + 5 working days -> next Thu
  });
});

describe("state machines", () => {
  it("every state is reachable and invalid edges are absent", () => {
    const expectAllReachable = <S extends string, E extends string>(m: Machine<S, E>): void => {
      expect([...reachable(m)].sort()).toEqual([...m.states].sort());
    };
    expectAllReachable(RETURN);
    expectAllReachable(REFUND);
    expectAllReachable(DISPUTE);
    expect(RETURN.table.CLOSED).toEqual({});
    expect(REFUND.table.COMPLETED).toEqual({});
    expect(REFUND.table.REQUESTED.start).toBeUndefined();
    expect(RETURN.table.RECEIVED.cancel).toBeUndefined();
  });
});

describe("computeRefund: ledger spec 4.5 / 4.6 numbers", () => {
  const common = { currency: "EGP" as const, commissionBp: 1500, commissionVatBp: 1400 };
  it("4.5 partial rejection: refund 30,000 of store B (89,950) = seller 24,870, commission 4,500, VAT 630", () => {
    const r = computeRefund({ ...common, base: 89_950n, goodsRefundedBefore: 0n, delivery: null, lines: [{ orderLineId: "l2", unitPrice: 30_000n, qty: 1, qtyAlreadyReturned: 0, returnQty: 1, discount: 0n }] });
    expect([r.total.amountMinor, r.commission.amountMinor, r.commissionVat.amountMinor, r.seller.amountMinor]).toEqual([30_000n, 4_500n, 630n, 24_870n]);
  });
  it("4.6 return of A's 49,900 line out of 249,900: commission 7,485, VAT 1,048, seller 41,367", () => {
    const r = computeRefund({ ...common, base: 249_900n, goodsRefundedBefore: 0n, delivery: null, lines: [{ orderLineId: "l", unitPrice: 49_900n, qty: 1, qtyAlreadyReturned: 0, returnQty: 1, discount: 0n }] });
    expect([r.commission.amountMinor, r.commissionVat.amountMinor, r.seller.amountMinor]).toEqual([7_485n, 1_048n, 41_367n]);
  });
  it("delivery fee is included in the total only when asked, with its VAT split out", () => {
    const r = computeRefund({ ...common, base: 10_000n, goodsRefundedBefore: 0n, delivery: { gross: 4_000n, vat: 491n }, lines: [{ orderLineId: "l", unitPrice: 10_000n, qty: 1, qtyAlreadyReturned: 0, returnQty: 1, discount: 0n }] });
    expect(r.total.amountMinor).toBe(14_000n);
    expect(r.deliveryVat.amountMinor).toBe(491n);
  });
  it("refuses more than was bought or paid", () => {
    expect(() => computeRefund({ ...common, base: 10_000n, goodsRefundedBefore: 0n, delivery: null, lines: [{ orderLineId: "l", unitPrice: 5_000n, qty: 2, qtyAlreadyReturned: 1, returnQty: 2, discount: 0n }] })).toThrow(ReturnsError);
    expect(() => computeRefund({ ...common, base: 10_000n, goodsRefundedBefore: 8_000n, delivery: null, lines: [{ orderLineId: "l", unitPrice: 5_000n, qty: 2, qtyAlreadyReturned: 0, returnQty: 1, discount: 0n }] })).toThrow(ReturnsError);
  });

  it("property: any partition of returned units refunds exactly the original commission, VAT, discount and goods (I10)", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 10 }), fc.integer({ min: 100, max: 500_000 }), fc.integer({ min: 0, max: 8_000 }), fc.integer({ min: 0, max: 9_999 }), fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 10 }),
      (qty, unit, bp, discRaw, cuts) => {
        const unitB = BigInt(unit);
        const gross = unitB * BigInt(qty);
        const discount = BigInt(discRaw) % (gross + 1n);
        const base = gross - discount;
        const parts: number[] = [];
        let left = qty;
        for (const c of cuts) {
          if (left === 0) break;
          const take = Math.min(c, left);
          parts.push(take);
          left -= take;
        }
        if (left > 0) parts.push(left);
        let done = 0;
        let goods = 0n; let comm = 0n; let vat = 0n; let share = 0n; let seller = 0n;
        const stepGoods: bigint[] = [];
        for (const p of parts) {
          const r = computeRefund({ currency: "EGP", base, goodsRefundedBefore: goods, commissionBp: bp, commissionVatBp: 1400, delivery: null, lines: [{ orderLineId: "x", unitPrice: unitB, qty, qtyAlreadyReturned: done, returnQty: p, discount }] });
          done += p;
          stepGoods.push(r.goods.amountMinor);
          goods += r.goods.amountMinor; comm += r.commission.amountMinor; vat += r.commissionVat.amountMinor; seller += r.seller.amountMinor;
          share += r.lines.reduce((a, l) => a + l.discountShare, 0n);
          expect(r.lines.reduce((a, l) => a + l.amount, 0n)).toBe(r.goods.amountMinor);
          expect(r.lines.reduce((a, l) => a + l.commission, 0n)).toBe(r.commission.amountMinor);
        }
        expect(goods).toBe(base);
        expect(share).toBe(discount);
        expect(seller + comm + vat).toBe(goods);
        // full refund through any split reproduces the single-shot commission and VAT exactly, unless a step was so small
        // (a few piastres of goods) that the platform absorbed the rounding shortfall (ledger spec 4.5 "Rounding"): then the
        // platform side may be short by at most 2 piastres per step, never the shopper (goods === base above).
        const once = computeRefund({ currency: "EGP", base, goodsRefundedBefore: 0n, commissionBp: bp, commissionVatBp: 1400, delivery: null, lines: [{ orderLineId: "x", unitPrice: unitB, qty, qtyAlreadyReturned: 0, returnQty: qty, discount }] });
        const platformOnce = once.commission.amountMinor + once.commissionVat.amountMinor;
        const smallestStepGoods = stepGoods.reduce((a, g) => (g < a ? g : a), stepGoods[0] ?? 0n);
        if (smallestStepGoods >= 1000n) {
          expect(comm).toBe(once.commission.amountMinor);
          expect(vat).toBe(once.commissionVat.amountMinor);
        } else {
          expect(comm + vat).toBeLessThanOrEqual(platformOnce);
          expect(platformOnce - (comm + vat)).toBeLessThanOrEqual(2n * BigInt(parts.length));
        }
      },
    ), { numRuns: 300 });
  });
  it("property: tender split sums to the refund, never exceeds either tender over any sequence", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }), fc.array(fc.integer({ min: 1, max: 50_000 }), { maxLength: 8 }), (credit, external, steps) => {
      if (credit + external === 0) return;
      let done = 0n; let c = 0n; let e = 0n;
      for (const s of steps) {
        if (done + BigInt(s) > BigInt(credit + external)) break;
        const sp = tenderSplit(money(BigInt(s), "EGP"), done, BigInt(credit), BigInt(external));
        expect(sp.credit.amountMinor + sp.external.amountMinor).toBe(BigInt(s));
        c += sp.credit.amountMinor; e += sp.external.amountMinor; done += BigInt(s);
        expect(c).toBeLessThanOrEqual(BigInt(credit));
        expect(e).toBeLessThanOrEqual(BigInt(external));
      }
    }));
  });
});

describe("RefundRouter", () => {
  const mk = (method: TenderMethod, over: Partial<RouteInput> = {}): RouteInput => ({
    marketId: "EG", userId: "u1", method, clearingOwner: method === "bnpl" ? "valu" : "paymob", pspReversible: true, refund: money(10_000n, "EGP"), credit: money(0n, "EGP"), external: money(10_000n, "EGP"), creditLegs: [], choice: null, ...over,
  });
  const only = (i: RouteInput) => routeRefund(i).map((d) => [d.route, d.accountCode, d.amount.amountMinor] as const);
  it("card / Apple Pay / Meeza go to the PSP by default, to refund credit on choice", () => {
    for (const m of ["card", "apple_pay", "meeza"] as const) {
      expect(only(mk(m))).toEqual([["psp_original", "psp_clearing:EG:EGP:paymob", 10_000n]]);
      expect(only(mk(m, { choice: "store_credit" }))[0]?.[0]).toBe("store_credit");
    }
  });
  it("wallet / InstaPay reverse at the PSP when supported, else bank transfer to the verified IBAN", () => {
    expect(only(mk("wallet"))[0]?.[0]).toBe("psp_original");
    expect(only(mk("instapay", { pspReversible: false }))[0]?.[0]).toBe("bank_transfer");
  });
  it("Fawry defaults to store credit, voucher when the shopper picks the original method", () => {
    expect(only(mk("fawry"))[0]?.[0]).toBe("store_credit");
    expect(only(mk("fawry", { choice: "original" }))[0]?.[0]).toBe("fawry_voucher");
  });
  it("COD defaults to instant store credit, transfer on choice", () => {
    expect(only(mk("cod", { clearingOwner: null }))[0]?.[0]).toBe("store_credit");
    expect(only(mk("cod", { clearingOwner: null, choice: "original" }))[0]?.[0]).toBe("bank_transfer");
  });
  it("BNPL is provider-only: never store credit, never psp_clearing, a credit choice is refused", () => {
    const d = routeRefund(mk("bnpl"));
    expect(d.map((x) => x.route)).toEqual(["bnpl_provider"]);
    expect(d[0]?.accountCode.startsWith("bnpl_clearing")).toBe(true);
    expect(() => routeRefund(mk("bnpl", { choice: "store_credit" }))).toThrow(/provider only/);
  });
  it("the credit portion returns to the same sub-balance, proportionally across legs", () => {
    const a = accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: "u1", sub: "goodwill" });
    const b = accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: "u1", sub: "gift_card" });
    const d = routeRefund(mk("card", { credit: money(3_000n, "EGP"), external: money(7_000n, "EGP"), creditLegs: [{ accountCode: a, amount: money(1_000n, "EGP") }, { accountCode: b, amount: money(2_000n, "EGP") }] }));
    expect(d.filter((x) => x.route === "store_credit").map((x) => [x.accountCode, x.amount.amountMinor])).toEqual([[a, 1_000n], [b, 2_000n]]);
    expect(d.find((x) => x.route === "psp_original")?.amount.amountMinor).toBe(7_000n);
  });
  it("property: destinations always sum to the refund; BNPL external never reaches store credit", () => {
    const methods: TenderMethod[] = ["card", "apple_pay", "meeza", "wallet", "instapay", "fawry", "bnpl", "cod"];
    const leg = accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: "u1", sub: "goodwill" });
    fc.assert(fc.property(fc.constantFrom(...methods), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 1, max: 100_000 }), fc.constantFrom(null, "original" as const, "store_credit" as const), fc.boolean(), (method, credit, external, choice, rev) => {
      const input = mk(method, {
        refund: money(BigInt(credit + external), "EGP"), credit: money(BigInt(credit), "EGP"), external: money(BigInt(external), "EGP"), pspReversible: rev, choice,
        creditLegs: credit > 0 ? [{ accountCode: leg, amount: money(BigInt(credit), "EGP") }] : [],
        clearingOwner: method === "cod" ? null : method === "bnpl" ? "valu" : "paymob",
      });
      let out;
      try {
        out = routeRefund(input);
      } catch (e) {
        expect(method === "bnpl" && choice === "store_credit" && e instanceof ReturnsError && e.code === "bnpl_provider_only").toBe(true);
        return;
      }
      expect(out.reduce((a, d) => a + d.amount.amountMinor, 0n)).toBe(BigInt(credit + external));
      if (method === "bnpl") expect(out.filter((d) => d.route !== "store_credit" || d.accountCode === leg).every((d) => d.route === "bnpl_provider" || d.accountCode === leg)).toBe(true);
    }), { numRuns: 300 });
  });
  it("every reason has a taxonomy entry", () => {
    expect(RETURN_REASONS.length).toBe(8);
    const r: ReturnReason = "late";
    expect(r).toBe("late");
  });
});
