import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { accountCode, validateDraft } from "@outlet/ledger";
import { money } from "@outlet/money";
import type { Money } from "@outlet/money";
import { autoBest, parseRules } from "@outlet/promotions";
import type { EvalBag, EvalContext, PromotionCandidate } from "@outlet/promotions";
import { SellerNetError, compareLock, orderPaidDraft, quote, sellerAmounts, toQuoteDiscounts } from "../src/index.js";
import type { PaymentMethod, QuoteDiscounts, QuoteInput, QuoteLineInput } from "../src/index.js";
import { sha256Hex } from "../src/application/hash.js";

const e = (n: bigint): Money => money(n, "EGP");
const line = (id: string, storeId: string, price: bigint, qty = 1): QuoteLineInput => ({
  cartLineId: `c-${id}`, skuId: id, productId: `p-${id}`, storeId, qty, unitPrice: e(price), titleAr: "فستان", titleEn: null, conditionGrade: "new_with_tags", defectCardId: null, vrp: null,
  claimType: "plain", evidenceIds: [], taxCategory: "standard", vatBp: 1400,
});
const input = (lines: QuoteLineInput[], fee: bigint, discounts?: QuoteDiscounts): QuoteInput => ({
  marketId: "EG", currency: "EGP", lines, shipping: new Map([...new Set(lines.map((l) => l.storeId))].map((s) => [s, { fee: e(fee), quoteRef: `r-${s}`, etaDaysMin: 1, etaDaysMax: 2 }])),
  methods: new Map<PaymentMethod, { fee: Money }>([["card", { fee: e(0n) }]]), creditAvailable: e(0n), creditRequested: e(0n), shippingTaxBp: 1400, ...(discounts === undefined ? {} : { discounts }),
});
const disc = (o: Partial<QuoteDiscounts> = {}): QuoteDiscounts => ({ lines: new Map(), shipping: new Map(), promotions: [], labels: [], ...o });

describe("quote with promotion discounts (pure)", () => {
  it("per-line funder amounts reduce the payable; seller discounts reduce the VAT base, platform ones do not (V62 conservative)", () => {
    const lines = [line("a", "A", 100_000n)];
    const base = quote(input(lines, 0n), sha256Hex);
    const plat = quote(input(lines, 0n, disc({ lines: new Map([["c-a", { platform: e(10_000n), seller: e(0n) }]]) })), sha256Hex);
    const sell = quote(input(lines, 0n, disc({ lines: new Map([["c-a", { platform: e(0n), seller: e(10_000n) }]]) })), sha256Hex);
    expect(plat.total.amountMinor).toBe(90_000n);
    expect(plat.stores[0]?.lines[0]?.vat.amountMinor).toBe(base.stores[0]?.lines[0]?.vat.amountMinor);
    expect(sell.stores[0]?.lines[0]?.vat.amountMinor).toBeLessThan(base.stores[0]?.lines[0]?.vat.amountMinor ?? 0n);
    expect(sell.stores[0]?.sellerDiscount.amountMinor).toBe(10_000n);
    expect(plat.hash).not.toBe(base.hash);
  });

  it("delivery waivers by funder: totals, store discount, seller residual (waiver comes off the seller, not the platform's delivery revenue)", () => {
    const lines = [line("a", "A", 100_000n), line("b", "B", 50_000n)];
    const q = quote(input(lines, 6000n, disc({ shipping: new Map([["A", { platform: e(6000n), seller: e(0n) }], ["B", { platform: e(0n), seller: e(6000n) }]]) })), sha256Hex);
    expect(q.discount.amountMinor).toBe(12_000n);
    expect(q.total.amountMinor).toBe(150_000n);
    const [a, b] = q.stores.map((s) => sellerAmounts(s, 1500, 1400));
    expect(a?.platformDiscount.amountMinor).toBe(6000n);
    expect(a?.net.amountMinor).toBe(100_000n - 15_000n - 2_100n);
    expect(b?.sellerDiscount.amountMinor).toBe(6000n);
    expect(b?.net.amountMinor).toBe(50_000n - 7_500n - 1_050n - 6000n);
  });

  it("refuses a discount larger than the store total and a missing shipping quote", () => {
    expect(() => quote(input([line("a", "A", 1000n)], 0n, disc({ lines: new Map([["c-a", { platform: e(1001n), seller: e(0n) }]]) })), sha256Hex)).toThrow();
    expect(() => quote(input([line("a", "A", 1000n)], 0n, disc({ lines: new Map([["c-a", { platform: e(900n), seller: e(200n) }]]) })), sha256Hex)).toThrow();
  });

  it("compareLock reports a changed promotion version even when the amounts are equal", () => {
    const mk = (version: number) => quote(input([line("a", "A", 100_000n)], 0n, disc({
      lines: new Map([["c-a", { platform: e(10_000n), seller: e(0n) }]]),
      promotions: [{ promotionId: "p1", version, voucherId: null, total: e(10_000n), platform: e(10_000n), seller: e(0n) }],
      labels: [{ promotionId: "p1", kind: "discount", textAr: "خصم", textEn: "Discount", amount: e(10_000n) }],
    })), sha256Hex);
    expect(mk(1).hash).not.toBe(mk(2).hash);
    expect(compareLock(mk(1), mk(1), "card")).toEqual([]);
    expect(compareLock(mk(1), mk(2), "card")).toEqual([{ kind: "promotions", before: ["p1@1:10000"], after: ["p1@2:10000"] }]);
    expect(compareLock(mk(1), quote(input([line("a", "A", 100_000n)], 0n), sha256Hex), "card").map((d) => d.kind)).toContain("promotions");
  });
});

// ---------------------------------------------------------------- property: random bags x promotions
const NOW = new Date("2030-06-01T12:00:00.000Z");
const ctx: EvalContext = { now: NOW, userId: "u", isPlus: false, isFirstOrder: true, birthdayToday: false, daysSinceLastOrder: null, followedStoreIds: [], paymentMethod: "card", city: null, segments: [], tier: null };
const cand = (id: string, o: { storeId: string | null; level: "order" | "store" | "shipping"; discount: unknown; type: PromotionCandidate["type"]; fp: number }): PromotionCandidate => ({
  id, version: 1, ownerType: o.storeId === null ? "platform" : "co_funded", storeId: o.storeId, type: o.type, stackingClass: "auto", rules: parseRules({ level: o.level, discount: o.discount }),
  fundingPlatformBp: o.fp, fundingSellerBp: 10_000 - o.fp, perUserLimit: null, minOrderMinor: null, maxDiscountMinor: null, budgetMinor: null, totalLimit: null, currency: "EGP",
  startsAt: new Date("2030-01-01T00:00:00Z"), endsAt: new Date("2031-01-01T00:00:00Z"), status: "ACTIVE", voucherId: null,
});
const STORES = ["A", "B", "C"] as const;
const bagArb = fc.record({
  stores: fc.uniqueArray(fc.constantFrom(...STORES), { minLength: 1, maxLength: 3 }),
  prices: fc.array(fc.tuple(fc.integer({ min: 100, max: 500_000 }), fc.integer({ min: 1, max: 4 })), { minLength: 1, maxLength: 6 }),
  fee: fc.integer({ min: 0, max: 10_000 }),
  promos: fc.array(
    fc.oneof(
      fc.record({ kind: fc.constant("pct"), bps: fc.integer({ min: 1, max: 9000 }), fp: fc.integer({ min: 0, max: 10_000 }), store: fc.constantFrom<string | null>(null, "A", "B") }),
      fc.record({ kind: fc.constant("fixed"), amount: fc.integer({ min: 1, max: 300_000 }), fp: fc.integer({ min: 0, max: 10_000 }), store: fc.constantFrom<string | null>(null, "A", "C") }),
      fc.record({ kind: fc.constant("ship"), fp: fc.integer({ min: 0, max: 10_000 }), store: fc.constantFrom<string | null>(null, "B", "C") }),
    ),
    { maxLength: 4 },
  ),
});

describe("property: discounts + payable == gross, entry balances (chart 4.2, I16)", () => {
  it("random bags and promotions", () => {
    fc.assert(
      fc.property(bagArb, (b) => {
        const lines: QuoteLineInput[] = b.prices.map(([price, qty], i) => line(`s${String(i)}`, b.stores[i % b.stores.length] ?? "A", BigInt(price), qty));
        const bag: EvalBag = {
          currency: "EGP",
          stores: [...new Set(lines.map((l) => l.storeId))].sort().map((storeId) => ({
            storeId, shippingFeeMinor: BigInt(b.fee),
            lines: lines.filter((l) => l.storeId === storeId).map((l) => ({ id: l.cartLineId, storeId, productId: l.productId, qty: l.qty, unitMinor: l.unitPrice.amountMinor, vatBp: l.vatBp })),
          })),
        };
        const cands = b.promos.map((p, i) => {
          const store = p.store !== null && !bag.stores.some((s) => s.storeId === p.store) ? null : p.store;
          if (p.kind === "pct") return cand(`c${String(i)}`, { storeId: store, level: store === null ? "order" : "store", discount: { kind: "percent", bps: p.bps }, type: "percent", fp: store === null ? 10_000 : p.fp });
          if (p.kind === "fixed") return cand(`c${String(i)}`, { storeId: store, level: store === null ? "order" : "store", discount: { kind: "fixed", amountMinor: String(p.amount) }, type: "fixed", fp: store === null ? 10_000 : p.fp });
          return cand(`c${String(i)}`, { storeId: store, level: "shipping", discount: { kind: "free_shipping" }, type: "free_shipping", fp: store === null ? 10_000 : p.fp });
        });
        const best = autoBest(bag, ctx, cands, new Map());
        const d = toQuoteDiscounts({ result: best.result, labels: [], selectedIds: best.selectedIds, invalidCodes: [], prunedIds: [], disabled: false });
        const q = quote(input(lines, BigInt(b.fee), d), sha256Hex);
        const gross = q.itemsSubtotal.amountMinor + q.shipping.amountMinor;
        expect(q.discount.amountMinor + q.total.amountMinor).toBe(gross);
        expect(q.discount.amountMinor).toBe(best.result.totals.platformFunded.amountMinor + best.result.totals.sellerFunded.amountMinor);
        expect(q.total.amountMinor).toBe(best.result.totals.payable.amountMinor);
        const linePayable = q.stores.flatMap((s) => s.lines).reduce((a, l) => a + l.payable.amountMinor, 0n);
        const shipDisc = q.stores.reduce((a, s) => a + s.shippingDiscount.platform.amountMinor + s.shippingDiscount.seller.amountMinor, 0n);
        expect(linePayable + q.shipping.amountMinor - shipDisc).toBe(q.total.amountMinor);
        let sellers;
        try {
          sellers = q.stores.map((s) => sellerAmounts(s, 1500, 1400));
        } catch (err) {
          expect(err).toBeInstanceOf(SellerNetError); // a seller-funded waiver can exceed the residual: refused, never booked negative
          return;
        }
        const draft = orderPaidDraft({ marketId: "EG", currency: "EGP", orderGroupId: "g", occurredAt: NOW, clearing: { type: "psp_clearing", owner: "paymob" }, external: q.total, credit: [], sellers });
        expect(() => validateDraft(draft)).not.toThrow();
        const promo = draft.postings.find((p) => p.accountCode === accountCode({ type: "promo_expense_platform", market: "EG", currency: "EGP" }));
        const platform = q.stores.reduce((a, s) => a + s.platformDiscount.amountMinor, 0n);
        expect(promo?.amount.amountMinor ?? 0n).toBe(platform);
        expect(draft.postings.reduce((a, p) => a + p.amount.amountMinor, 0n)).toBe(0n);
      }),
      { numRuns: 300 },
    );
  });
});
