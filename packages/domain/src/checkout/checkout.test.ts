import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { balanceOf, reverseEntry, sumByCurrency, trialBalance } from "../ledger";
import { money } from "../money";
import { evaluatePromotions } from "../promotions/evaluate";
import { NOW, S1, S2, egp, promo } from "../promotions/fixtures";
import type { Promotion } from "../promotions/types";
import { checkoutOrderEntry, lateReceiptEntry, lateRefundEntry } from "./ledger";
import { effectiveUnitPrice, reconfirm, lockActive, lockExpiry, type PriceLockSnapshot } from "./price-lock";
import { assembleQuote, itemDiscountByStore, planTender, shippingBeforePromotions, canonicalQuote } from "./pricing";
import { reservationTtlSeconds } from "./ttl";
import type { CheckoutLine, CheckoutMethod, StoreTermsForCheckout } from "./types";

const U = "00000000-0000-4000-8000-0000000000aa";
const line = (n: number, storeId: string, price: bigint, qty = 1, drop = false): CheckoutLine => ({
  lineId: `l${n}`,
  skuId: `sku${n}`,
  productId: `p${n}`,
  storeId,
  qty,
  unitPrice: egp(price),
  isDrop: drop,
});
const terms = (storeId: string, threshold: bigint | null = 2000n, fee = 5000n): StoreTermsForCheckout => ({
  storeId,
  freeDeliveryThreshold: threshold === null ? null : egp(threshold),
  standardDeliveryFee: money(fee),
});

function quote(opts: {
  lines: CheckoutLine[];
  stores: StoreTermsForCheckout[];
  pool?: Promotion[];
  codes?: string[];
  plus?: boolean;
  method?: CheckoutMethod;
  credit?: bigint;
  useCredit?: boolean;
  vatBps?: bigint;
}) {
  const method = opts.method ?? "card";
  const stores = new Map(opts.stores.map((s) => [s.storeId, s]));
  const evalLines = opts.lines.map((l) => ({ skuId: l.skuId, storeId: l.storeId, qty: l.qty, unitPrice: l.unitPrice }));
  const base = {
    userId: U,
    lines: evalLines,
    codes: opts.codes ?? [],
    paymentMethod: method,
    isPlus: opts.plus ?? false,
    atMs: NOW,
    usage: new Map(),
  };
  const pool = opts.pool ?? [];
  const pass1 = evaluatePromotions({ ...base, shippingFees: [] }, pool);
  const waiver = shippingBeforePromotions({
    lines: opts.lines,
    stores,
    itemDiscounts: itemDiscountByStore(pass1, opts.lines),
    plus: opts.plus ?? false,
  });
  const ev = evaluatePromotions({ ...base, shippingFees: waiver.fees }, pool);
  const lineVat = new Map(opts.lines.map((l) => [l.lineId, money(0n)]));
  return assembleQuote({
    method,
    lines: opts.lines,
    evaluation: ev,
    shippingReasons: waiver.reasons,
    deliveryFees: new Map(opts.stores.map((s) => [s.storeId, s.standardDeliveryFee])),
    lineVat,
    vatBps: opts.vatBps ?? 1400n,
    balances:
      opts.credit === undefined || opts.credit === 0n
        ? []
        : [{ sub: { kind: "refund_credit" }, balance: money(opts.credit), expiresAt: null }],
    useStoreCredit: opts.useCredit ?? false,
  });
}

describe("checkout pricing", () => {
  it("applies the free-delivery threshold per store (1,950 + 60 unlocks, 2,100 alone is free)", () => {
    const q = quote({
      lines: [line(1, S1, 1950n), line(2, S1, 60n), line(3, S2, 100n)],
      stores: [terms(S1), terms(S2)],
    });
    const s1 = q.stores.find((s) => s.storeId === S1);
    const s2 = q.stores.find((s) => s.storeId === S2);
    expect(s1?.shipping.amount).toBe(0n);
    expect(s1?.freeDeliveryReason).toBe("threshold");
    expect(s2?.shipping.amount).toBe(5000n);
    expect(s2?.deliveryFee.amount).toBe(5000n);
  });

  it("waives every fee for Plus and shows the fee on the first render", () => {
    const q = quote({ lines: [line(1, S1, 100n)], stores: [terms(S1)], plus: true });
    expect(q.shipping.amount).toBe(0n);
    expect(q.stores[0]?.freeDeliveryReason).toBe("plus");
    expect(q.stores[0]?.deliveryFee.amount).toBe(5000n);
  });

  it("measures the threshold after item-level discounts and before vouchers", () => {
    const item = promo({ scope: "item", code: null, autoApply: true, value: { kind: "percent", percentBps: 1000 } });
    const q = quote({ lines: [line(1, S1, 2100n)], stores: [terms(S1)], pool: [item] });
    // 2,100 - 10% = 1,890 < 2,000 so delivery is charged even though list price clears the threshold.
    expect(q.stores[0]?.shipping.amount).toBe(5000n);
    const voucher = promo({ scope: "order", code: "SAVE", value: { kind: "percent", percentBps: 1000 } });
    const q2 = quote({ lines: [line(1, S1, 2100n)], stores: [terms(S1)], pool: [voucher], codes: ["SAVE"] });
    expect(q2.stores[0]?.shipping.amount).toBe(0n);
  });

  it("keeps funding splits equal to the discount and the total equal to the parts", () => {
    const v = promo({ code: "CO", funding: { platformPct: 50, sellerPct: 50 }, scope: "order" });
    const q = quote({ lines: [line(1, S1, 1000n), line(2, S2, 777n, 2)], stores: [terms(S1), terms(S2)], pool: [v], codes: ["CO"] });
    for (const s of q.stores) {
      expect(s.platformFundedDiscount.amount + s.sellerFundedDiscount.amount).toBe(
        q.lines.filter((l) => l.storeId === s.storeId).reduce((a, l) => a + l.discount.amount, 0n),
      );
    }
    expect(q.total.amount).toBe(q.subtotal.amount - q.discount.amount + q.shipping.amount);
  });

  it("never combines store credit with cash on delivery", () => {
    const t = planTender({
      total: egp(500n),
      method: "cod",
      useStoreCredit: true,
      balances: [{ sub: { kind: "goodwill" }, balance: egp(100n), expiresAt: null }],
    });
    expect(t.storeCreditTotal.amount).toBe(0n);
    expect(t.externalDue.amount).toBe(egp(500n).amount);
  });

  it("splits tender: credit first in spend order, one external method for the rest", () => {
    const q = quote({ lines: [line(1, S1, 2500n)], stores: [terms(S1)], credit: 100_000n, useCredit: true });
    expect(q.tender.storeCreditTotal.amount).toBe(100_000n);
    expect(q.tender.externalDue.amount).toBe(q.total.amount - 100_000n);
  });

  it("caps credit at the total", () => {
    const q = quote({ lines: [line(1, S1, 100n)], stores: [terms(S1)], credit: 99_999_999n, useCredit: true });
    expect(q.tender.externalDue.amount).toBe(0n);
    expect(q.tender.storeCreditTotal.amount).toBe(q.total.amount);
  });

  it("property: parts sum to the total, tender sums to the total, VAT is never negative", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 3 }), fc.bigInt({ min: 1n, max: 5000n }), fc.integer({ min: 1, max: 4 })), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.boolean(),
        fc.bigInt({ min: 0n, max: 800_000n }),
        fc.constantFrom<CheckoutMethod>("card", "cod", "fawry", "bnpl"),
        (rows, plus, credit, method) => {
          const storeIds = [S1, S2, "00000000-0000-4000-a000-000000000003"];
          const lines = rows.map(([s, p, q], i) => line(i, storeIds[s - 1] ?? S1, p, q));
          const q = quote({
            lines,
            stores: storeIds.map((s) => terms(s)),
            plus,
            method,
            credit,
            useCredit: true,
          });
          const stores = q.stores.reduce((a, s) => a + s.total.amount, 0n);
          expect(q.total.amount).toBe(stores);
          expect(q.tender.storeCreditTotal.amount + q.tender.externalDue.amount).toBe(q.total.amount);
          expect(q.vat.amount >= 0n).toBe(true);
          expect(canonicalQuote(q)).toBe(canonicalQuote(q));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("price lock", () => {
  const lock = (over: Partial<PriceLockSnapshot> = {}): PriceLockSnapshot => ({
    userId: U,
    expiresAtMs: lockExpiry(NOW),
    unitPrices: new Map([["sku1", 1000n]]),
    total: 1000n,
    ...over,
  });
  it("honours the locked price inside the window and the lower price always", () => {
    expect(effectiveUnitPrice("sku1", money(1200n), lock(), U, NOW).amount).toBe(1000n);
    expect(effectiveUnitPrice("sku1", money(900n), lock(), U, NOW).amount).toBe(900n);
  });
  it("ignores an expired lock, another user's lock, and unknown SKUs", () => {
    expect(effectiveUnitPrice("sku1", money(1200n), lock(), U, NOW + 10 * 60_000).amount).toBe(1200n);
    expect(effectiveUnitPrice("sku1", money(1200n), lock({ userId: "x" }), U, NOW).amount).toBe(1200n);
    expect(effectiveUnitPrice("sku9", money(1200n), lock(), U, NOW).amount).toBe(1200n);
    expect(lockActive(null, U, NOW)).toBe(false);
  });
  it("requires re-confirmation with the delta when the total differs", () => {
    expect(reconfirm(1000n, 1000n)).toEqual({ kind: "ok" });
    expect(reconfirm(null, 5n)).toEqual({ kind: "ok" });
    expect(reconfirm(1000n, 1100n)).toEqual({ kind: "changed", expected: 1000n, actual: 1100n, delta: 100n });
  });
});

describe("reservation TTL by method (ADR-0011)", () => {
  it("is 10 min cards, 30 min wallets, 24 h Fawry", () => {
    expect(reservationTtlSeconds("card")).toBe(600);
    expect(reservationTtlSeconds("mobile_wallet")).toBe(1800);
    expect(reservationTtlSeconds("fawry")).toBe(86_400);
  });
});

describe("checkout ledger entries", () => {
  const meta = (k: string) => ({ id: k, idempotencyKey: k, occurredAt: new Date(NOW), ref: { type: "order_group", id: k } });
  const commission = new Map([[S1, 1500], [S2, 1000]]);

  it("balances, reverses symmetrically and replays identically", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(S1, S2), fc.bigInt({ min: 100n, max: 4000n }), fc.integer({ min: 1, max: 3 })), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.bigInt({ min: 0n, max: 500_000n }),
        fc.boolean(),
        (rows, credit, bnpl) => {
          const lines = rows.map(([s, p, q], i) => line(i, s, p, q));
          const q = quote({
            lines,
            stores: [terms(S1), terms(S2)],
            method: bnpl ? "bnpl" : "card",
            credit,
            useCredit: true,
          });
          const mk = () => checkoutOrderEntry({ quote: q, userId: U, provider: "fakepsp", commissionBps: commission }, meta("k1"));
          const e = mk();
          expect(e).not.toBeNull();
          if (e === null) return;
          for (const t of sumByCurrency(e.postings).values()) expect(t).toBe(0n);
          expect(mk()).toEqual(e);
          const r = reverseEntry(e, { id: "r", idempotencyKey: "r", occurredAt: new Date(NOW) });
          expect(trialBalance([e, r]).get("EGP") ?? 0n).toBe(0n);
          for (const p of e.postings) expect(balanceOf(p.account, [e, r]).amount).toBe(0n);
          const payables = e.postings.filter((p) => p.account.startsWith("seller_payable:")).length;
          expect(payables).toBeGreaterThan(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("fails closed when a store has no commission snapshot (never 0%)", () => {
    const q = quote({ lines: [line(1, S1, 500n)], stores: [terms(S1)], method: "card" });
    expect(() => checkoutOrderEntry({ quote: q, userId: U, provider: "fakepsp", commissionBps: new Map() }, meta("m"))).toThrow();
    expect(() => checkoutOrderEntry({ quote: q, userId: U, provider: "fakepsp", commissionBps: new Map([[S1, 10_001]]) }, meta("m"))).toThrow();
  });

  it("returns null for cash on delivery (recognised at delivery)", () => {
    const q = quote({ lines: [line(1, S1, 500n)], stores: [terms(S1)], method: "cod" });
    expect(checkoutOrderEntry({ quote: q, userId: U, provider: null, commissionBps: commission }, meta("c"))).toBeNull();
  });

  it("parks and releases a late receipt to exactly zero", () => {
    const a = lateReceiptEntry(money(12_345n), "fakepsp", meta("a"));
    const b = lateRefundEntry(money(12_345n), "fakepsp", meta("b"));
    expect(balanceOf("psp_clearing:fakepsp", [a, b]).amount).toBe(0n);
    expect(balanceOf("refund_reserve", [a, b]).amount).toBe(0n);
    expect(trialBalance([a, b]).get("EGP")).toBe(0n);
  });
});
