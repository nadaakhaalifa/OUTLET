import { describe, expect, it } from "vitest";
import { allocateVatWithLineDiscounts } from "@outlet/tax";
import {
  PromotionError, assertTransition, autoBest, cairoDateWindow, cairoMidnight, displayLabels, evaluate, formatMinor, generateCode, hashCode, isEditable, last4, ledgerFunding,
  normaliseCode, parseRules, pruneCandidates, rejectReason, toTaxableLines, validateDraft, validateStacking,
} from "../src/index.js";
import type { PromotionDraft, PromotionStatus } from "../src/index.js";
import { A, B, NOW, bag, cand, ctx } from "./fixtures.js";

const pay = (r: ReturnType<typeof evaluate>): bigint => r.totals.payable.amountMinor;
const GROSS = 2n * 50_000n + 30_000n + 40_001n + 6000n + 5000n;

describe("evaluate: discount kinds", () => {
  it("no promotions: pays gross plus shipping", () => {
    const r = evaluate(bag(), ctx(), []);
    expect(pay(r)).toBe(GROSS);
    expect(r.applied).toEqual([]);
  });
  it("percent at order level, platform funded, split exactly over lines", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "p" })]);
    expect(r.totals.goodsDiscount.amountMinor).toBe(17_000n); // 10% of 170,001 half-even = 17,000
    expect(r.totals.platformFunded.amountMinor).toBe(17_000n);
    expect(r.totals.sellerFunded.amountMinor).toBe(0n);
    expect(r.lines.reduce((a, l) => a + l.discount.amountMinor, 0n)).toBe(17_000n);
  });
  it("fixed amount is capped by what is left to pay", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "f", type: "fixed", rules: { level: "order", discount: { kind: "fixed", amountMinor: "999999999" } } })]);
    expect(r.totals.goodsDiscount.amountMinor).toBe(170_001n);
    expect(r.lines.every((l) => l.payable.amountMinor === 0n)).toBe(true);
  });
  it("max discount and budget cap the amount; exhausted budget is rejected", () => {
    const capped = evaluate(bag(), ctx(), [cand({ id: "p", max: 500n })]);
    expect(capped.totals.goodsDiscount.amountMinor).toBe(500n);
    const usage = new Map([["p", { userUses: 0, totalUses: 0, usedMinor: 9_800n }]]);
    expect(evaluate(bag(), ctx(), [cand({ id: "p", budget: 10_000n })], usage).totals.goodsDiscount.amountMinor).toBe(200n);
    const gone = new Map([["p", { userUses: 0, totalUses: 0, usedMinor: 10_000n }]]);
    expect(evaluate(bag(), ctx(), [cand({ id: "p", budget: 10_000n })], gone).rejected).toEqual([{ promotionId: "p", reason: "budget_exhausted" }]);
  });
  it("store scoped promotion touches only that store's lines; seller funded", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "s", storeId: A, cls: "store_voucher", rules: { level: "store", discount: { kind: "percent", bps: 2000 } } })]);
    expect(r.stores.find((s) => s.storeId === B)?.goodsDiscount.amountMinor).toBe(0n);
    expect(r.stores.find((s) => s.storeId === A)?.goodsDiscount.amountMinor).toBe(26_000n);
    expect(r.totals.sellerFunded.amountMinor).toBe(26_000n);
    expect(r.totals.platformFunded.amountMinor).toBe(0n);
  });
  it("co-funded split sums exactly per line", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "c", storeId: A, owner: "co_funded", fp: 3333, fs: 6667, cls: "store_voucher", rules: { level: "store", discount: { kind: "percent", bps: 1234 } } })]);
    const a = r.applied[0];
    expect(a).toBeDefined();
    for (const l of r.lines) expect(l.platformDiscount.amountMinor + l.sellerDiscount.amountMinor).toBe(l.discount.amountMinor);
    expect(r.totals.platformFunded.amountMinor + r.totals.sellerFunded.amountMinor).toBe(a?.total.amountMinor);
  });
  it("free shipping waives the fees of eligible stores, funded per split", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "fs", type: "free_shipping", rules: { level: "shipping", discount: { kind: "free_shipping" } } })]);
    expect(r.totals.shippingDiscount.amountMinor).toBe(11_000n);
    expect(pay(r)).toBe(GROSS - 11_000n);
    const one = evaluate(bag(), ctx(), [cand({ id: "fs", storeId: B, cls: "store_voucher", type: "free_shipping", rules: { level: "shipping", discount: { kind: "free_shipping" } } })]);
    expect(one.stores.find((s) => s.storeId === A)?.shippingDiscount.amountMinor).toBe(0n);
    expect(one.applied[0]?.shipping).toHaveLength(1);
    const capped = evaluate(bag(), ctx(), [cand({ id: "fs", max: 4000n, type: "free_shipping", rules: { level: "shipping", discount: { kind: "free_shipping" } } })]);
    expect(capped.totals.shippingDiscount.amountMinor).toBe(4000n);
  });
  it("free shipping with nothing to waive is rejected as no_discount", () => {
    const b = { ...bag(), stores: bag().stores.map((s) => ({ ...s, shippingFeeMinor: 0n })) };
    expect(evaluate(b, ctx(), [cand({ id: "fs", type: "free_shipping", rules: { level: "shipping", discount: { kind: "free_shipping" } } })]).rejected[0]?.reason).toBe("no_discount");
  });
  it("bogo: cheapest unit of every (buy+get) group", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "b", type: "bogo", rules: { level: "item", discount: { kind: "bogo", buyQty: 1, getQty: 1 }, targeting: { categoryIds: ["dress"] } } })]);
    // dress units: 50,000 x2 (A) and 40,001 (B) -> 3 units, 1 group of 2, cheapest free = 40,001
    expect(r.totals.goodsDiscount.amountMinor).toBe(40_001n);
    expect(r.lines.find((l) => l.lineId === "l3")?.payable.amountMinor).toBe(0n);
    const half = evaluate(bag(), ctx(), [cand({ id: "b", type: "bogo", rules: { level: "item", discount: { kind: "bogo", buyQty: 1, getQty: 1, getBps: 5000 }, targeting: { categoryIds: ["dress"] } } })]);
    expect(half.totals.goodsDiscount.amountMinor).toBe(20_000n); // 50% of 40,001 half-even
  });
  it("bogo with too few units gives nothing", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "b", type: "bogo", rules: { level: "item", discount: { kind: "bogo", buyQty: 4, getQty: 1 } } })]);
    expect(r.rejected[0]?.reason).toBe("no_discount"); 
  });
  it("tiered picks the highest reached tier on the original subtotal", () => {
    const rules = { level: "order", discount: { kind: "tiered", tiers: [{ minSubtotalMinor: "100000", bps: 500 }, { minSubtotalMinor: "150000", bps: 1500 }] } };
    expect(evaluate(bag(), ctx(), [cand({ id: "t", type: "tiered", rules })]).totals.goodsDiscount.amountMinor).toBe(25_500n);
    const low = { ...bag(), stores: [bag().stores[0]!] };
    expect(evaluate(low, ctx(), [cand({ id: "t", type: "tiered", rules: { level: "order", discount: { kind: "tiered", tiers: [{ minSubtotalMinor: "500000", bps: 500 }] } } })]).rejected[0]?.reason).toBe("no_discount");
  });
  it("bundle needs every product; discount applies to the matched sets only", () => {
    const rules = { level: "item", discount: { kind: "bundle", productIds: ["p1", "p2"], bps: 1000 } };
    const r = evaluate(bag(), ctx(), [cand({ id: "bd", type: "bundle", rules })]);
    expect(r.totals.goodsDiscount.amountMinor).toBe(5000n + 3000n); // 1 set: p1 x1 + p2 x1
    const miss = evaluate(bag(), ctx(), [cand({ id: "bd", type: "bundle", rules: { level: "item", discount: { kind: "bundle", productIds: ["p1", "zzz"], bps: 1000 } } })]);
    expect(miss.rejected[0]?.reason).toBe("no_discount");
    const multi = { currency: "EGP" as const, stores: [{ storeId: A, shippingFeeMinor: 0n, lines: [
      { id: "x1", storeId: A, productId: "p1", qty: 1, unitMinor: 1000n, vatBp: 1400 }, { id: "x2", storeId: A, productId: "p1", qty: 2, unitMinor: 1000n, vatBp: 1400 },
      { id: "x3", storeId: A, productId: "p2", qty: 2, unitMinor: 2000n, vatBp: 1400 }] }] };
    expect(evaluate(multi, ctx(), [cand({ id: "bd", type: "bundle", rules })]).totals.goodsDiscount.amountMinor).toBe(200n + 400n); // 2 sets
  });
  it("payment partner applies last, only for the listed method", () => {
    const pp = cand({ id: "pp", type: "payment_partner", cls: "payment_partner", rules: { level: "payment_partner", discount: { kind: "percent", bps: 500 }, targeting: { paymentMethods: ["card"] } } });
    const base = cand({ id: "a1", rules: { level: "order", discount: { kind: "fixed", amountMinor: "70001" } } });
    const r = evaluate(bag(), ctx(), [pp, base]);
    expect(r.applied.map((a) => a.promotionId)).toEqual(["a1", "pp"]);
    expect(r.applied[1]?.total.amountMinor).toBe(5000n); // 5% of the remaining 100,000
    expect(evaluate(bag(), ctx({ paymentMethod: "cod" }), [pp]).rejected[0]?.reason).toBe("payment_method");
  });
  it("evaluation order is item, store, order, shipping, payment-partner regardless of input order", () => {
    const item = cand({ id: "z-item", rules: { level: "item", discount: { kind: "percent", bps: 1000 } } });
    const order = cand({ id: "a-order", rules: { level: "order", discount: { kind: "percent", bps: 1000 } } });
    const ship = cand({ id: "m-ship", type: "free_shipping", rules: { level: "shipping", discount: { kind: "free_shipping" } } });
    const r1 = evaluate(bag(), ctx(), [ship, order, item]);
    expect(r1.applied.map((a) => a.promotionId)).toEqual(["z-item", "a-order", "m-ship"]);
    expect(r1.applied[1]?.total.amountMinor).toBe(15_300n); // 10% of the already discounted 153,001
  });
});

describe("eligibility", () => {
  const b = bag();
  const check = (c: Parameters<typeof cand>[0], x = ctx(), u = new Map()) => rejectReason(cand(c), x, b, u);
  it("status and Cairo-instant dates", () => {
    expect(check({ id: "x", status: "PAUSED" })).toBe("inactive");
    expect(rejectReason({ ...cand({ id: "x" }), startsAt: new Date("2031-01-01T00:00:00Z"), endsAt: new Date("2032-01-01T00:00:00Z") }, ctx(), b, new Map())).toBe("not_started");
    expect(rejectReason({ ...cand({ id: "x" }), endsAt: NOW }, ctx(), b, new Map())).toBe("ended");
    expect(rejectReason({ ...cand({ id: "x" }), currency: "USD" }, ctx(), b, new Map())).toBe("currency_mismatch");
  });
  it("first order, birthday, win-back, follower", () => {
    expect(check({ id: "x", type: "first_order" })).toBe("not_first_order");
    expect(check({ id: "x", type: "first_order" }, ctx({ isFirstOrder: true }))).toBeNull();
    expect(check({ id: "x", type: "birthday" })).toBe("not_birthday");
    expect(check({ id: "x", type: "birthday" }, ctx({ birthdayToday: true }))).toBeNull();
    expect(check({ id: "x", type: "win_back" })).toBe("win_back_window");
    expect(check({ id: "x", type: "win_back" }, ctx({ daysSinceLastOrder: 30 }))).toBe("win_back_window");
    expect(check({ id: "x", type: "win_back" }, ctx({ daysSinceLastOrder: 61 }))).toBeNull();
    expect(check({ id: "x", type: "win_back", rules: { level: "order", discount: { kind: "percent", bps: 100 }, targeting: { minDaysSinceLastOrder: 10 } } }, ctx({ daysSinceLastOrder: 11 }))).toBeNull();
    expect(check({ id: "x", type: "store_follower" })).toBe("not_follower");
    expect(check({ id: "x", type: "store_follower" }, ctx({ followedStoreIds: [B] }))).toBeNull();
  });
  it("targeting: plus, segment, tier, city, payment method, categories, products, stores", () => {
    const t = (targeting: object) => ({ id: "x", rules: { level: "order", discount: { kind: "percent", bps: 100 }, targeting } });
    expect(check(t({ plusOnly: true }))).toBe("plus_only");
    expect(check(t({ plusOnly: true }), ctx({ isPlus: true }))).toBeNull();
    expect(check(t({ segments: ["vip"] }))).toBe("segment");
    expect(check(t({ segments: ["vip"] }), ctx({ segments: ["vip"] }))).toBeNull();
    expect(check(t({ tiers: ["gold"] }))).toBe("tier");
    expect(check(t({ tiers: ["gold"] }), ctx({ tier: "gold" }))).toBeNull();
    expect(check(t({ cities: ["cairo"] }))).toBe("city");
    expect(check(t({ cities: ["cairo"] }), ctx({ city: "cairo" }))).toBeNull();
    expect(check(t({ paymentMethods: ["instapay"] }))).toBe("payment_method");
    expect(check(t({ paymentMethods: ["card"] }), ctx({ paymentMethod: null }))).toBe("payment_method");
    expect(check(t({ categoryIds: ["hats"] }))).toBe("no_eligible_lines");
    expect(check(t({ productIds: ["p3"] }))).toBeNull();
    expect(check(t({ storeIds: [A], categoryIds: ["shoes"] }))).toBeNull();
    expect(check(t({ tiers: ["gold"] }), ctx({ tier: null }))).toBe("tier");
  });
  it("limits and minimum order", () => {
    expect(check({ id: "x", perUser: 1 }, ctx(), new Map([["x", { userUses: 1, totalUses: 1, usedMinor: 0n }]]))).toBe("per_user_limit");
    expect(check({ id: "x", total: 5 }, ctx(), new Map([["x", { userUses: 0, totalUses: 5, usedMinor: 0n }]]))).toBe("total_limit");
    expect(check({ id: "x", min: 170_002n })).toBe("min_order");
    expect(check({ id: "x", min: 170_001n })).toBeNull();
  });
  it("minimum order uses the original gross, not stacking order", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "a", rules: { level: "item", discount: { kind: "percent", bps: 5000 } } }), cand({ id: "b", min: 150_000n })]);
    expect(r.rejected).toEqual([]);
  });
});

describe("stacking matrix and auto-best", () => {
  const code = (id: string, extra: object = {}) => cand({ id, cls: "platform_code", ...extra });
  it("rejects two platform codes, two vouchers of one store, two partners, duplicates", () => {
    expect(() => { validateStacking([code("a"), code("b")]); }).toThrow(PromotionError);
    const sv = (id: string, s: string) => cand({ id, storeId: s, cls: "store_voucher", rules: { level: "store", discount: { kind: "percent", bps: 100 } } });
    expect(() => { validateStacking([sv("a", A), sv("b", A)]); }).toThrow(/store_voucher/);
    expect(() => { validateStacking([sv("a", A), sv("b", B), code("c"), cand({ id: "d" }), cand({ id: "e" })]); }).not.toThrow();
    const pp = (id: string) => cand({ id, type: "payment_partner", cls: "payment_partner", rules: { level: "payment_partner", discount: { kind: "percent", bps: 100 }, targeting: { paymentMethods: ["card"] } } });
    expect(() => { validateStacking([pp("a"), pp("b")]); }).toThrow();
    expect(() => { validateStacking([cand({ id: "a" }), cand({ id: "a" })]); }).toThrow(/twice/);
    expect(() => evaluate(bag(), ctx(), [code("a"), code("b")])).toThrow(PromotionError);
  });
  it("auto-best picks the cheapest valid combination, independent of input order", () => {
    const small = code("c-small", { rules: { level: "order", discount: { kind: "percent", bps: 500 } } });
    const big = code("c-big", { rules: { level: "order", discount: { kind: "percent", bps: 2000 } } });
    const auto = cand({ id: "auto", rules: { level: "item", discount: { kind: "percent", bps: 1000 } } });
    const one = autoBest(bag(), ctx(), [small, big, auto]);
    const two = autoBest(bag(), ctx(), [auto, big, small]);
    expect(one.selectedIds).toEqual(["auto", "c-big"]);
    expect(two.result).toEqual(one.result);
    expect(one.considered).toBe(6); // subsets of {small,big,auto} without {small,big}
  });
  it("ties resolve to fewer promotions then ids; no candidates gives the plain total", () => {
    const x = cand({ id: "x", rules: { level: "order", discount: { kind: "fixed", amountMinor: "1000" } } });
    const y = cand({ id: "y", rules: { level: "order", discount: { kind: "fixed", amountMinor: "1000" } } });
    expect(autoBest(bag(), ctx(), [y, x]).selectedIds).toEqual(["x", "y"]); // both together beat either alone
    const cx = code("cx", { rules: { level: "order", discount: { kind: "fixed", amountMinor: "1000" } } });
    const cy = code("cy", { rules: { level: "order", discount: { kind: "fixed", amountMinor: "1000" } } });
    expect(autoBest(bag(), ctx(), [cy, cx]).selectedIds).toEqual(["cx"]);
    expect(autoBest(bag(), ctx(), []).result.applied).toEqual([]);
    expect(autoBest(bag(), ctx(), [cand({ id: "n", status: "ENDED" })]).selectedIds).toEqual([]);
  });
  it("more than 5 eligible candidates throws; pruning keeps the 5 best", () => {
    const many = Array.from({ length: 7 }, (_, i) => cand({ id: `m${String(i)}`, rules: { level: "order", discount: { kind: "fixed", amountMinor: String(1000 * (i + 1)) } } }));
    expect(() => autoBest(bag(), ctx(), many)).toThrow(/at most 5/);
    const { kept, prunedIds } = pruneCandidates(bag(), ctx(), many);
    expect(kept.map((k) => k.id)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
    expect(prunedIds).toEqual(["m0", "m1"]);
    expect(pruneCandidates(bag(), ctx(), many.slice(0, 2)).prunedIds).toEqual([]);
    const tie = Array.from({ length: 6 }, (_, i) => cand({ id: `t${String(i)}`, rules: { level: "order", discount: { kind: "fixed", amountMinor: "1000" } } }));
    expect(pruneCandidates(bag(), ctx(), tie).prunedIds).toEqual(["t5"]);
  });
});

describe("labels never claim a percentage or a reference price", () => {
  it("renders only 'Voucher -X' / 'Discount -X' with integer formatting", () => {
    const r = evaluate(bag(), ctx(), [
      cand({ id: "v", cls: "platform_code", rules: { level: "order", discount: { kind: "percent", bps: 5000 } } }),
      cand({ id: "a", rules: { level: "item", discount: { kind: "percent", bps: 2500 } } }),
    ]);
    const labels = displayLabels(r);
    expect(labels.map((l) => l.kind)).toEqual(["discount", "voucher"]);
    for (const l of labels) {
      expect(l.textEn).not.toMatch(/%|was|off/i);
      expect(l.textAr).not.toMatch(/%/);
      expect(l.textEn).toMatch(/^(Voucher|Discount) −\d+\.\d{2} EGP$/);
    }
    expect(labels[0]?.textAr).toContain("خصم");
    expect(labels[1]?.textAr).toContain("قسيمة");
    expect(labels[1]?.textAr).toContain("ج.م");
  });
  it("a voucher-bound auto promotion is still a voucher; zero-amount promos are omitted; formatting edge cases", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "v", voucherId: "vv" })]);
    expect(displayLabels(r)[0]?.kind).toBe("voucher");
    expect(displayLabels(evaluate(bag(), ctx(), []))).toEqual([]);
    expect(formatMinor({ amountMinor: 5n, currency: "EGP" })).toBe("0.05");
    expect(formatMinor({ amountMinor: -12_345n, currency: "USD" })).toBe("-123.45");
  });
  it("uses the currency code when there is no Arabic abbreviation", () => {
    const b = { currency: "USD" as const, stores: [{ storeId: A, shippingFeeMinor: 0n, lines: [{ id: "u", storeId: A, productId: "p", qty: 1, unitMinor: 10_000n, vatBp: 0 }] }] };
    const r = evaluate(b, ctx(), [{ ...cand({ id: "d" }), currency: "USD" }]);
    expect(displayLabels(r)[0]?.textAr).toContain("USD");
  });
});

describe("funding shape for tax and ledger", () => {
  it("feeds allocateVatWithLineDiscounts and the chart (platform expense vs seller-funded)", () => {
    const b = bag();
    const r = evaluate(b, ctx(), [
      cand({ id: "plat", cls: "platform_code", rules: { level: "order", discount: { kind: "percent", bps: 1000 } } }),
      cand({ id: "co", storeId: A, owner: "co_funded", fp: 5000, fs: 5000, cls: "store_voucher", rules: { level: "store", discount: { kind: "percent", bps: 1000 } } }),
      cand({ id: "ship", storeId: B, cls: "store_voucher", type: "free_shipping", rules: { level: "shipping", discount: { kind: "free_shipping" } } }),
    ]);
    const tax = allocateVatWithLineDiscounts(toTaxableLines(b, r));
    expect(tax.payableTotal.amountMinor).toBe(r.totals.goodsGross.amountMinor - r.totals.goodsDiscount.amountMinor);
    const f = ledgerFunding(b, r);
    expect(f.promoExpensePlatform.amountMinor + f.sellerFunded.amountMinor).toBe(r.totals.goodsDiscount.amountMinor + r.totals.shippingDiscount.amountMinor);
    expect(f.perStore).toHaveLength(2);
    const fa = f.perStore.find((s) => s.storeId === A);
    const fb = f.perStore.find((s) => s.storeId === B);
    expect(fa?.platformGoods.amountMinor).toBeGreaterThan(0n);
    expect(fa?.sellerGoods.amountMinor).toBeGreaterThan(0n);
    expect(fb?.sellerShipping.amountMinor).toBe(5000n);
    expect(fb?.platformShipping.amountMinor).toBe(0n);
  });
  it("toTaxableLines tolerates a result without the line", () => {
    const b = bag();
    const r = evaluate(b, ctx(), []);
    expect(toTaxableLines(b, { ...r, lines: [] })[0]?.platformDiscount?.amountMinor).toBe(0n);
    expect(ledgerFunding(b, r).promoExpensePlatform.amountMinor).toBe(0n);
  });
});

describe("rules, drafts and state", () => {
  const draft = (o: Partial<PromotionDraft> = {}): PromotionDraft => ({
    ownerType: "platform", storeId: null, type: "percent", stackingClass: "auto", rules: parseRules({ level: "order", discount: { kind: "percent", bps: 100 } }), fundingPlatformBp: 10_000, fundingSellerBp: 0, ...o,
  });
  it("accepts a valid draft and rejects invalid combinations", () => {
    expect(() => { validateDraft(draft()); }).not.toThrow();
    const r = (x: unknown) => parseRules(x);
    const bad: [Partial<PromotionDraft>, RegExp][] = [
      [{ type: "fixed" }, /cannot use discount/],
      [{ fundingSellerBp: 5 }, /sum to 10000/],
      [{ storeId: A }, /no store/],
      [{ ownerType: "store", storeId: A, fundingPlatformBp: 10_000, fundingSellerBp: 0 }, /seller-funded/],
      [{ ownerType: "store", storeId: null, fundingPlatformBp: 0, fundingSellerBp: 10_000 }, /need a store/],
      [{ ownerType: "co_funded", storeId: A, fundingPlatformBp: 10_000, fundingSellerBp: 0 }, /both funders/],
      [{ rules: r({ level: "shipping", discount: { kind: "percent", bps: 100 } }) }, /only discount at level shipping/],
      [{ type: "payment_partner", stackingClass: "payment_partner" }, /level go together/],
      [{ type: "payment_partner", rules: r({ level: "payment_partner", discount: { kind: "percent", bps: 100 } }) }, /stacking class go together/],
      [{ type: "payment_partner", stackingClass: "payment_partner", rules: r({ level: "payment_partner", discount: { kind: "percent", bps: 100 } }) }, /paymentMethods/],
      [{ rules: r({ level: "store", discount: { kind: "percent", bps: 100 } }) }, /store level needs a store/],
      [{ stackingClass: "store_voucher" }, /belong to a store/],
      [{ ownerType: "store", storeId: A, fundingPlatformBp: 0, fundingSellerBp: 10_000, stackingClass: "platform_code" }, /platform promotions/],
      [{ stackingClass: "platform_code", rules: r({ level: "store", discount: { kind: "percent", bps: 100 } }) }, /store level needs|cannot be store level/],
    ];
    for (const [o, re] of bad) expect(() => { validateDraft(draft(o)); }, JSON.stringify(o)).toThrow(re);
    expect(() => { validateDraft(draft({ ownerType: "co_funded", storeId: A, fundingPlatformBp: 5000, fundingSellerBp: 5000 })); }).not.toThrow();
  });
  it("platform codes cannot be store level (with a store present)", () => {
    expect(() => { validateDraft(draft({ ownerType: "platform", stackingClass: "platform_code", rules: parseRules({ level: "store", discount: { kind: "percent", bps: 100 } }) })); }).toThrow(/store level/);
  });
  it("Zod rejects unknown fields (no budget targeting), bad tiers, bad money", () => {
    expect(() => parseRules({ level: "order", discount: { kind: "percent", bps: 100 }, targeting: { budgetRemaining: 5 } })).toThrow(/INVALID|budgetRemaining|Unrecognized/i);
    expect(() => parseRules({ level: "order", discount: { kind: "tiered", tiers: [{ minSubtotalMinor: "5", bps: 1 }, { minSubtotalMinor: "5", bps: 2 }] } })).toThrow(PromotionError);
    expect(() => parseRules({ level: "order", discount: { kind: "fixed", amountMinor: "0" } })).toThrow(PromotionError);
    expect(() => parseRules({ level: "order", discount: { kind: "percent", bps: 10_001 } })).toThrow(PromotionError);
    expect(parseRules({ level: "order", discount: { kind: "bogo", buyQty: 1, getQty: 1 } }).discount).toMatchObject({ getBps: 10_000 });
  });
  it("promotion state machine", () => {
    expect(() => { assertTransition("DRAFT", "SCHEDULED"); }).not.toThrow();
    expect(() => { assertTransition("ACTIVE", "PAUSED"); }).not.toThrow();
    expect(() => { assertTransition("PAUSED", "ACTIVE"); }).not.toThrow();
    for (const [a, b] of [["ENDED", "ACTIVE"], ["EXHAUSTED", "ACTIVE"], ["DRAFT", "PAUSED"], ["ACTIVE", "DRAFT"]] as [PromotionStatus, PromotionStatus][]) expect(() => { assertTransition(a, b); }).toThrow(PromotionError);
    expect(isEditable("DRAFT") && isEditable("PAUSED") && isEditable("SCHEDULED")).toBe(true);
    expect(isEditable("ACTIVE") || isEditable("ENDED")).toBe(false);
  });
});

describe("Cairo dates and codes", () => {
  it("Cairo midnight follows the DST offset", () => {
    expect(cairoMidnight("2030-01-15").toISOString()).toBe("2030-01-14T22:00:00.000Z"); // UTC+2
    expect(cairoMidnight("2030-07-15").toISOString()).toBe("2030-07-14T21:00:00.000Z"); // UTC+3
    const w = cairoDateWindow("2030-01-15", "2030-01-15");
    expect(w.endsAt.getTime() - w.startsAt.getTime()).toBe(86_400_000);
    expect(() => cairoDateWindow("2030-01-16", "2030-01-15")).toThrow(PromotionError);
    expect(() => cairoMidnight("2030-02-30")).toThrow(PromotionError);
    expect(() => cairoMidnight("nope")).toThrow(PromotionError);
  });
  it("codes are 20 chars of Crockford base32 and hash after normalisation", () => {
    const c = generateCode();
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(generateCode()).not.toBe(c);
    expect(normaliseCode(" ab-il o ")).toBe("AB110");
    const key = new Uint8Array(32).fill(7);
    expect(hashCode(key, "abc-def").equals(hashCode(key, "ABCDEF"))).toBe(true);
    expect(hashCode(key, "ABCDEF").equals(hashCode(new Uint8Array(32).fill(8), "ABCDEF"))).toBe(false);
    expect(last4("abcdefgh")).toBe("EFGH");
  });
});
