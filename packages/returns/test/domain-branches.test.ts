import { describe, expect, it } from "vitest";
import { money } from "@outlet/money";
import { ReturnsError, computeRefund, routeRefund, summaryRoute, tenderSplit } from "../src/index.js";
import type { CalcInput, RouteInput, TenderMethod } from "../src/index.js";

const e = (n: bigint) => money(n, "EGP");
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (err) { return err instanceof ReturnsError ? err.code : "other"; }
  return undefined;
};
const calcIn = (over: Partial<CalcInput> = {}): CalcInput => ({
  currency: "EGP", base: 20_000n, goodsRefundedBefore: 0n, commissionBp: 1000, commissionVatBp: 1400, delivery: null,
  lines: [{ orderLineId: "l1", unitPrice: 10_000n, qty: 2, qtyAlreadyReturned: 0, returnQty: 1, discount: 0n }], ...over,
});

describe("computeRefund guards", () => {
  it("rejects a zero return quantity and an over-return of the purchased quantity", () => {
    expect(codeOf(() => computeRefund(calcIn({ lines: [{ orderLineId: "l1", unitPrice: 1000n, qty: 2, qtyAlreadyReturned: 0, returnQty: 0, discount: 0n }] })))).toBe("nothing_to_return");
    expect(codeOf(() => computeRefund(calcIn({ lines: [{ orderLineId: "l1", unitPrice: 1000n, qty: 2, qtyAlreadyReturned: 1, returnQty: 2, discount: 0n }] })))).toBe("qty_exceeds_purchased");
  });
  it("refuses a refund larger than the remaining base", () => {
    expect(codeOf(() => computeRefund(calcIn({ base: 5_000n })))).toBe("refund_exceeds_paid");
    expect(codeOf(() => computeRefund(calcIn({ goodsRefundedBefore: 15_000n })))).toBe("refund_exceeds_paid");
  });
  it("refuses a refund whose commission would exceed the goods (negative seller share)", () => {
    expect(codeOf(() => computeRefund(calcIn({ commissionBp: 10_000 })))).toBe("seller_net_negative");
  });
  it("zero commission skips the allocation and keeps commission lines at 0", () => {
    const r = computeRefund(calcIn({ commissionBp: 0 }));
    expect(r.commission.amountMinor).toBe(0n);
    expect(r.lines[0]).toMatchObject({ commission: 0n, commissionVat: 0n });
    expect(r.seller.amountMinor).toBe(10_000n);
  });
  it("includes the delivery fee in the total and the voucher share is proportional and floors cumulatively", () => {
    const r = computeRefund(calcIn({ base: 19_001n, delivery: { gross: 6_000n, vat: 737n }, lines: [{ orderLineId: "l1", unitPrice: 10_000n, qty: 2, qtyAlreadyReturned: 0, returnQty: 1, discount: 999n }] }));
    expect(r.deliveryFee.amountMinor).toBe(6_000n);
    expect(r.deliveryVat.amountMinor).toBe(737n);
    expect(r.lines[0]?.discountShare).toBe(499n);
    expect(r.goods.amountMinor).toBe(10_000n - 499n);
    expect(r.total.amountMinor).toBe(r.goods.amountMinor + 6_000n);
  });
  it("sequential partial refunds sum exactly to the original commission (I10)", () => {
    const first = computeRefund(calcIn({ base: 20_001n }));
    const second = computeRefund(calcIn({ base: 20_001n, goodsRefundedBefore: first.goods.amountMinor, lines: [{ orderLineId: "l1", unitPrice: 10_000n, qty: 2, qtyAlreadyReturned: 1, returnQty: 1, discount: 0n }] }));
    expect(first.commission.amountMinor + second.commission.amountMinor).toBe(2_000n);
    expect(first.commissionVat.amountMinor + second.commissionVat.amountMinor).toBe(280n);
    expect(first.goods.amountMinor + second.goods.amountMinor).toBe(20_000n);
  });
});

describe("tenderSplit", () => {
  it("splits by tender ratio and never over-refunds", () => {
    const s = tenderSplit(e(3_000n), 0n, 2_000n, 8_000n);
    expect(s.credit.amountMinor + s.external.amountMinor).toBe(3_000n);
    expect(s.credit.amountMinor).toBe(600n);
  });
  it("rejects a zero-paid group and a cumulative over-refund", () => {
    expect(codeOf(() => tenderSplit(e(1n), 0n, 0n, 0n))).toBe("refund_exceeds_paid");
    expect(codeOf(() => tenderSplit(e(1_001n), 9_000n, 1_000n, 9_000n))).toBe("refund_exceeds_paid");
  });
});

const route = (over: Partial<RouteInput> & { method: TenderMethod }): RouteInput => ({
  marketId: "EG", userId: "u1", clearingOwner: "paymob", pspReversible: true, refund: e(1_000n), credit: e(0n), external: e(1_000n), creditLegs: [], choice: null, ...over,
});

describe("routeRefund branches", () => {
  it.each<[TenderMethod, RouteInput["choice"], boolean, string]>([
    ["card", null, true, "psp_original"], ["card", "store_credit", true, "store_credit"], ["apple_pay", "original", true, "psp_original"], ["meeza", null, true, "psp_original"],
    ["wallet", null, true, "psp_original"], ["wallet", null, false, "bank_transfer"], ["wallet", "store_credit", true, "store_credit"],
    ["instapay", null, false, "bank_transfer"], ["instapay", null, true, "psp_original"],
    ["fawry", "original", true, "fawry_voucher"], ["fawry", null, true, "store_credit"], ["fawry", "store_credit", true, "store_credit"],
    ["cod", "original", true, "bank_transfer"], ["cod", null, true, "store_credit"], ["cod", "store_credit", true, "store_credit"],
  ])("%s choice=%s reversible=%s -> %s", (method, choice, pspReversible, expected) => {
    const d = routeRefund(route({ method, choice, pspReversible, clearingOwner: method === "cod" || method === "fawry" ? null : "paymob" }));
    expect(d).toHaveLength(1);
    expect(d[0]?.route).toBe(expected);
    expect(d[0]?.amount.amountMinor).toBe(1_000n);
  });
  it("BNPL goes to the provider and refuses a store-credit choice", () => {
    expect(routeRefund(route({ method: "bnpl", clearingOwner: "valu" }))[0]).toMatchObject({ route: "bnpl_provider", accountCode: "bnpl_clearing:EG:EGP:valu" });
    expect(codeOf(() => routeRefund(route({ method: "bnpl", clearingOwner: "valu", choice: "store_credit" })))).toBe("bnpl_provider_only");
  });
  it("a PSP route with no clearing owner is not_found; a store-credit-only order has no external tender", () => {
    expect(codeOf(() => routeRefund(route({ method: "card", clearingOwner: null })))).toBe("not_found");
    expect(codeOf(() => routeRefund(route({ method: "bnpl", clearingOwner: null })))).toBe("not_found");
    expect(codeOf(() => routeRefund(route({ method: "store_credit" })))).toBe("refund_exceeds_paid");
  });
  it("credit portion goes back to its legs proportionally; no legs is refused; parts must sum", () => {
    const legs = [{ accountCode: "store_credit:EG:EGP:u1:gift_card", amount: e(600n) }, { accountCode: "store_credit:EG:EGP:u1:refund_credit", amount: e(400n) }];
    const d = routeRefund(route({ method: "card", refund: e(1_500n), credit: e(500n), external: e(1_000n), creditLegs: legs }));
    expect(d.filter((x) => x.route === "store_credit").map((x) => x.amount.amountMinor)).toEqual([300n, 200n]);
    expect(d.reduce((a, x) => a + x.amount.amountMinor, 0n)).toBe(1_500n);
    expect(codeOf(() => routeRefund(route({ method: "card", refund: e(500n), credit: e(500n), external: e(0n) })))).toBe("refund_exceeds_paid");
    expect(codeOf(() => routeRefund(route({ method: "card", refund: e(900n) })))).toBe("refund_exceeds_paid");
  });
  it("a zero-amount credit leg is skipped", () => {
    const legs = [{ accountCode: "a", amount: e(1n) }, { accountCode: "b", amount: e(1_000_000n) }];
    const d = routeRefund(route({ method: "card", refund: e(1_001n), credit: e(1n), external: e(1_000n), creditLegs: legs }));
    expect(d.filter((x) => x.route === "store_credit").every((x) => x.amount.amountMinor > 0n)).toBe(true);
  });
  it("summaryRoute reports the single route or mixed", () => {
    expect(summaryRoute([])).toBe("mixed");
    expect(summaryRoute([{ route: "psp_original", amount: e(1n), accountCode: "x" }])).toBe("psp_original");
    expect(summaryRoute([{ route: "psp_original", amount: e(1n), accountCode: "x" }, { route: "store_credit", amount: e(1n), accountCode: "y" }])).toBe("mixed");
  });
});
