import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ORDER_GROUP, ORDER_GROUP_EVENTS, ORDER_GROUP_STATES, OrderStateError, transition } from "@outlet/orders";
import type { OrderGroupState } from "@outlet/orders";
import { validateDraft } from "@outlet/ledger";
import { money, percentOf } from "@outlet/money";
import type { Money } from "@outlet/money";
import { compareLock, orderPaidDraft, quote, sellerAmounts, splitInstructions, SellerNetError } from "../src/index.js";
import type { PaymentMethod, QuoteInput, QuoteLineInput } from "../src/index.js";
import { sha256Hex } from "../src/application/hash.js";

const e = (n: bigint): Money => money(n, "EGP");
const line = (skuId: string, storeId: string, price: bigint, qty = 1, over: Partial<QuoteLineInput> = {}): QuoteLineInput => ({
  cartLineId: `c-${skuId}`, skuId, productId: `p-${skuId}`, storeId, qty, unitPrice: e(price), titleAr: "فستان", titleEn: null, conditionGrade: "new_with_tags", defectCardId: null, vrp: null,
  claimType: "plain", evidenceIds: [], taxCategory: "standard", vatBp: 1400, ...over,
});
const input = (lines: QuoteLineInput[], over: Partial<QuoteInput> = {}): QuoteInput => {
  const stores = [...new Set(lines.map((l) => l.storeId))];
  return {
    marketId: "EG", currency: "EGP", lines, shipping: new Map(stores.map((s) => [s, { fee: e(6000n), quoteRef: `r-${s}`, etaDaysMin: 1, etaDaysMax: 2 }])),
    methods: new Map<PaymentMethod, { fee: Money }>([["card", { fee: e(0n) }], ["cod", { fee: e(0n) }]]), creditAvailable: e(0n), creditRequested: e(0n), shippingTaxBp: 1400, discount: e(0n), ...over,
  };
};
const Q = (i: QuoteInput) => quote(i, sha256Hex);

describe("quote (pure)", () => {
  it("totals, VAT once per line, per-method payable and a stable hash", () => {
    const i = input([line("s1", "A", 10_000n, 2), line("s2", "B", 5_000n)]);
    const q = Q(i);
    expect(q.itemsSubtotal.amountMinor).toBe(25_000n);
    expect(q.shipping.amountMinor).toBe(12_000n);
    expect(q.total.amountMinor).toBe(37_000n);
    expect(q.stores[0]?.lines[0]?.vat.amountMinor).toBe(2_456n); // 20,000 x 14 / 114 half-even
    expect(q.payableByMethod.get("card")?.amountMinor).toBe(37_000n);
    expect(Q(i).hash).toBe(q.hash);
    expect(Q(input([line("s2", "B", 5_000n), line("s1", "A", 10_000n, 2)])).hash).toBe(q.hash); // input order does not matter
    expect(Q(input([line("s1", "A", 10_001n, 2), line("s2", "B", 5_000n)])).hash).not.toBe(q.hash);
  });
  it("store credit is min(requested, available, total) and lowers every payable", () => {
    const q = Q(input([line("s1", "A", 10_000n)], { creditAvailable: e(4_000n), creditRequested: e(9_000n) }));
    expect(q.storeCredit.amountMinor).toBe(4_000n);
    expect(q.payableByMethod.get("cod")?.amountMinor).toBe(16_000n - 4_000n);
    expect(Q(input([line("s1", "A", 1_000n)], { creditAvailable: e(99_999n), creditRequested: e(99_999n) })).storeCredit.amountMinor).toBe(7_000n);
  });
  it("'you saved' only from verified discounts whose reference is higher than the price", () => {
    const q = Q(input([
      line("v", "A", 8_000n, 2, { vrp: e(10_000n), claimType: "verified_discount" }),
      line("p", "A", 5_000n, 1, { vrp: e(9_000n), claimType: "plain" }),
      line("l", "A", 5_000n, 1, { vrp: e(9_000n), claimType: "lowest_30d" }),
      line("x", "A", 5_000n, 1, { vrp: e(4_000n), claimType: "verified_discount" }),
    ]));
    expect(q.verifiedSavings.amountMinor).toBe(4_000n);
  });
  it("a store with no shipping quote is an error, never a free delivery", () => {
    expect(() => Q({ ...input([line("s", "A", 1_000n)]), shipping: new Map() })).toThrow();
  });
});

describe("price lock (compareLock)", () => {
  const base = input([line("s1", "A", 10_000n), line("s2", "B", 5_000n)], { creditAvailable: e(1_000n), creditRequested: e(1_000n) });
  const q0 = Q(base);
  it("is empty for an unchanged quote", () => {
    expect(compareLock(q0, Q(base), "card")).toEqual([]);
  });
  it("reports a line price change and the resulting total", () => {
    const d = compareLock(q0, Q(input([line("s1", "A", 11_000n), line("s2", "B", 5_000n)], { creditAvailable: e(1_000n), creditRequested: e(1_000n) })), "card");
    expect(d.map((x) => x.kind)).toEqual(["line_price", "total"]);
  });
  it("reports unavailable and added lines", () => {
    const d = compareLock(q0, Q(input([line("s1", "A", 10_000n), line("s3", "A", 1_000n)], { creditAvailable: e(1_000n), creditRequested: e(1_000n) })), "card");
    expect(d.map((x) => x.kind)).toEqual(expect.arrayContaining(["line_unavailable", "line_added"]));
  });
  it("reports shipping, method fee and store credit changes", () => {
    const f = input([line("s1", "A", 10_000n), line("s2", "B", 5_000n)], {
      creditAvailable: e(500n), creditRequested: e(1_000n),
      shipping: new Map([["A", { fee: e(0n), quoteRef: "x", etaDaysMin: 1, etaDaysMax: 2 }], ["B", { fee: e(6000n), quoteRef: "y", etaDaysMin: 1, etaDaysMax: 2 }]]),
      methods: new Map<PaymentMethod, { fee: Money }>([["card", { fee: e(100n) }]]),
    });
    const kinds = compareLock(q0, Q(f), "card").map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["shipping", "method_fee", "store_credit", "total"]));
  });
  it("ignores ETA and quote reference changes (not money)", () => {
    const f = input([line("s1", "A", 10_000n), line("s2", "B", 5_000n)], { creditAvailable: e(1_000n), creditRequested: e(1_000n), shipping: new Map([["A", { fee: e(6000n), quoteRef: "z", etaDaysMin: 3, etaDaysMax: 9 }], ["B", { fee: e(6000n), quoteRef: "z", etaDaysMin: 3, etaDaysMax: 9 }]]) });
    expect(compareLock(q0, Q(f), "card")).toEqual([]);
  });
});

describe("order_paid ledger entry", () => {
  const worked = (): ReturnType<typeof orderPaidDraft> => {
    const q = Q({ ...input([line("a", "A", 249_900n), line("b", "B", 89_950n), line("c", "C", 45_000n)]), shipping: new Map([["A", { fee: e(0n), quoteRef: "a", etaDaysMin: 1, etaDaysMax: 2 }], ["B", { fee: e(6000n), quoteRef: "b", etaDaysMin: 1, etaDaysMax: 2 }], ["C", { fee: e(6000n), quoteRef: "c", etaDaysMin: 1, etaDaysMax: 2 }]]) });
    const sellers = q.stores.map((s) => sellerAmounts(s, 1500, 1400));
    return orderPaidDraft({ marketId: "EG", currency: "EGP", orderGroupId: "g", occurredAt: new Date(0), clearing: { type: "psp_clearing", owner: "paymob" }, external: q.total, credit: [], sellers });
  };
  it("reproduces ledger-chart example 4.1 exactly", () => {
    const by = new Map(worked().postings.map((p) => [p.accountCode, p.amount.amountMinor]));
    expect([...by.values()].sort((a, b) => Number(a - b))).toEqual([-207_167n, -74_569n, -57_727n, -37_305n, -10_526n, -9_556n, 396_850n].sort((a, b) => Number(a - b)));
    expect(by.get("commission_revenue:EG:EGP")).toBe(-57_727n);
    expect(by.get("platform_vat_output:EG:EGP")).toBe(-9_556n);
    expect(by.get("shipping_revenue:EG:EGP")).toBe(-10_526n);
    expect(validateDraft(worked()).postings).toHaveLength(7);
  });
  it("property: always balances, net is never negative, split sums to the external amount", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ price: fc.integer({ min: 100, max: 5_000_000 }), qty: fc.integer({ min: 1, max: 10 }), ship: fc.integer({ min: 0, max: 20_000 }), bp: fc.integer({ min: 0, max: 10_000 }) }), { minLength: 1, maxLength: 6 }),
        (rows) => {
          const lines = rows.map((r, i) => line(`s${String(i)}`, `store${String(i)}`, BigInt(r.price), r.qty));
          const q = Q({ ...input(lines), shipping: new Map(rows.map((r, i) => [`store${String(i)}`, { fee: e(BigInt(r.ship)), quoteRef: "r", etaDaysMin: 1, etaDaysMax: 2 }])) });
          const sellers = [];
          for (const s of q.stores) {
            const r = rows[Number(s.storeId.slice(5))];
            try {
              sellers.push(sellerAmounts(s, r?.bp ?? 0, 1400));
            } catch (err) {
              // a rate so high that commission + its VAT exceed the items is refused with the typed I13 error, never a negative net
              expect(err).toBeInstanceOf(SellerNetError);
              return;
            }
          }
          const draft = orderPaidDraft({ marketId: "EG", currency: "EGP", orderGroupId: "g", occurredAt: new Date(0), clearing: { type: "psp_clearing", owner: "paymob" }, external: q.total, credit: [], sellers });
          expect(draft.postings.reduce((a, p) => a + p.amount.amountMinor, 0n)).toBe(0n);
          for (const s of sellers) expect(s.net.amountMinor).toBeGreaterThanOrEqual(0n);
          const subs = new Map(sellers.map((s) => [s.storeId, `sub-${s.storeId}`]));
          const ids = new Map(sellers.map((s) => [s.storeId, `so-${s.storeId}`]));
          const split = splitInstructions(sellers, q.total, ids, subs);
          expect(split.reduce((a, s) => a + s.sellerAmount.amountMinor + s.platformAmount.amountMinor, 0n)).toBe(q.total.amountMinor);
        },
      ),
      { numRuns: 300 },
    );
  });
  it("C5 property: split never pays a seller more than its net, in total or per store, and always sums to the external amount", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ price: fc.integer({ min: 100, max: 5_000_000 }), qty: fc.integer({ min: 1, max: 10 }), ship: fc.integer({ min: 0, max: 20_000 }), bp: fc.integer({ min: 0, max: 10_000 }) }), { minLength: 1, maxLength: 6 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (rows, frac) => {
          const lines = rows.map((r, i) => line(`s${String(i)}`, `store${String(i)}`, BigInt(r.price), r.qty));
          const q = Q({ ...input(lines), shipping: new Map(rows.map((r, i) => [`store${String(i)}`, { fee: e(BigInt(r.ship)), quoteRef: "r", etaDaysMin: 1, etaDaysMax: 2 }])) });
          const sellers = [];
          for (const s of q.stores) {
            try { sellers.push(sellerAmounts(s, rows[Number(s.storeId.slice(5))]?.bp ?? 0, 1400)); } catch (err) { expect(err).toBeInstanceOf(SellerNetError); return; }
          }
          // external amount anywhere from 0 (all credit) to the full total (no credit)
          const external = percentOf(q.total, BigInt(Math.floor(frac * 10_000)));
          const split = splitInstructions(sellers, external, new Map(sellers.map((s) => [s.storeId, `so-${s.storeId}`])), new Map(sellers.map((s) => [s.storeId, `sub-${s.storeId}`])));
          let paid = 0n;
          let net = 0n;
          for (const sp of split) {
            const s = sellers.find((x) => x.storeId === sp.storeId);
            expect(sp.sellerAmount.amountMinor).toBeLessThanOrEqual(s?.net.amountMinor ?? -1n);
            expect(sp.sellerAmount.amountMinor).toBeGreaterThanOrEqual(0n);
            expect(sp.platformAmount.amountMinor).toBeGreaterThanOrEqual(0n);
            paid += sp.sellerAmount.amountMinor;
            net += s?.net.amountMinor ?? 0n;
          }
          expect(paid).toBeLessThanOrEqual(net);
          expect(split.reduce((a, sp) => a + sp.sellerAmount.amountMinor + sp.platformAmount.amountMinor, 0n)).toBe(external.amountMinor);
        },
      ),
      { numRuns: 300 },
    );
  });
  it("a commission that would leave the seller a negative residual is a typed error (I13)", () => {
    const q = Q(input([line("a", "A", 10_000n)]));
    const s = q.stores[0];
    expect(s).toBeDefined();
    if (s !== undefined) expect(() => sellerAmounts(s, 9_000, 9_000)).toThrow(SellerNetError);
  });
});

describe("order group state machine", () => {
  it("property: random event walks stay inside the declared states; terminal states never move", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ORDER_GROUP_EVENTS), { maxLength: 30 }), (events) => {
        let s: OrderGroupState = "PENDING_PAYMENT";
        for (const ev of events) {
          try {
            s = transition(ORDER_GROUP, s, ev);
          } catch (err) {
            expect(err).toBeInstanceOf(OrderStateError);
          }
          expect(ORDER_GROUP_STATES).toContain(s);
          if (ORDER_GROUP.terminal.includes(s)) expect(ORDER_GROUP_EVENTS.every((x) => { try { transition(ORDER_GROUP, s, x); return false; } catch { return true; } })).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
  it("money-bearing late paths: only EXPIRED and PAYMENT_FAILED accept a late payment", () => {
    for (const s of ORDER_GROUP_STATES) {
      const ok = (() => { try { transition(ORDER_GROUP, s, "late_payment_claimed"); return true; } catch { return false; } })();
      expect(ok).toBe(s === "EXPIRED" || s === "PAYMENT_FAILED");
    }
  });
});
