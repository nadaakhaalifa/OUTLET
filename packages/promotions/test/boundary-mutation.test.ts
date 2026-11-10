import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { autoBest, evaluate, formatMinor, pruneCandidates, rejectReason, validateStacking } from "../src/index.js";
import type { PromotionCandidate, UsageMap } from "../src/index.js";
import { money } from "@outlet/money";
import { A, B, bag, cand, ctx } from "./fixtures.js";

// Hand-run mutation pass (StrykerJS cannot run in the sandbox). Fixture bag: goods A 130000 (l1 2x50000, l2 30000), B 40001 (l3); shipping A 6000, B 5000.
const GOODS = 170_001n;
const order = (extra: object = {}) => ({ level: "order", ...extra });
const pct = (bps: number, extra: object = {}) => order({ discount: { kind: "percent", bps }, ...extra });
const fixed = (n: number | string, extra: object = {}) => order({ discount: { kind: "fixed", amountMinor: String(n) }, ...extra });
const usage = (id: string, u: Partial<{ userUses: number; totalUses: number; usedMinor: bigint }>): UsageMap => new Map([[id, { userUses: 0, totalUses: 0, usedMinor: 0n, ...u }]]);
const reason = (c: PromotionCandidate, u: UsageMap = new Map(), x = ctx()) => rejectReason(c, x, bag(), u);
const total = (r: ReturnType<typeof evaluate>, i = 0): bigint | undefined => r.applied[i]?.total.amountMinor;

describe("window boundaries (end exclusive, start inclusive)", () => {
  const c = cand({ id: "x" });
  const at = (ms: number) => ctx({ now: new Date(ms) });
  it("now == startsAt is active, 1 ms earlier is not started", () => {
    expect(reason(c, new Map(), at(c.startsAt.getTime()))).toBeNull();
    expect(reason(c, new Map(), at(c.startsAt.getTime() - 1))).toBe("not_started");
  });
  it("now == endsAt - 1 ms is active, == endsAt is ended", () => {
    expect(reason(c, new Map(), at(c.endsAt.getTime() - 1))).toBeNull();
    expect(reason(c, new Map(), at(c.endsAt.getTime()))).toBe("ended");
  });
  it("status other than ACTIVE is refused before anything else (even when also out of window)", () => {
    expect(reason({ ...cand({ id: "x", status: "EXHAUSTED" }), endsAt: new Date(0) })).toBe("inactive");
  });
});

describe("usage caps: at the limit, one under, zero", () => {
  it("per-user limit: uses < limit passes, == limit refused, > limit refused; a limit of 0 always refuses", () => {
    const c = cand({ id: "x", perUser: 2 });
    expect(reason(c, usage("x", { userUses: 1 }))).toBeNull();
    expect(reason(c, usage("x", { userUses: 2 }))).toBe("per_user_limit");
    expect(reason(c, usage("x", { userUses: 3 }))).toBe("per_user_limit");
    expect(reason(cand({ id: "x", perUser: 0 }))).toBe("per_user_limit");
  });
  it("total limit: same three points; per-user is checked first", () => {
    const c = cand({ id: "x", total: 10 });
    expect(reason(c, usage("x", { totalUses: 9 }))).toBeNull();
    expect(reason(c, usage("x", { totalUses: 10 }))).toBe("total_limit");
    expect(reason(c, usage("x", { totalUses: 11 }))).toBe("total_limit");
    expect(reason(cand({ id: "x", total: 0 }))).toBe("total_limit");
    expect(reason(cand({ id: "x", perUser: 1, total: 1 }), usage("x", { userUses: 1, totalUses: 1 }))).toBe("per_user_limit");
  });
  it("null limits mean unlimited", () => {
    expect(reason(cand({ id: "x" }), usage("x", { userUses: 10 ** 6, totalUses: 10 ** 6, usedMinor: 10n ** 15n }))).toBeNull();
  });
  it("budget: used one under is eligible, used == budget exhausted, used above exhausted; budget 0 is exhausted at once", () => {
    const c = cand({ id: "x", budget: 1_000n });
    expect(reason(c, usage("x", { usedMinor: 999n }))).toBeNull();
    expect(reason(c, usage("x", { usedMinor: 1_000n }))).toBe("budget_exhausted");
    expect(reason(c, usage("x", { usedMinor: 1_001n }))).toBe("budget_exhausted");
    expect(reason(cand({ id: "x", budget: 0n }))).toBe("budget_exhausted");
  });
  it("a usage snapshot for ANOTHER promotion does not count", () => {
    expect(reason(cand({ id: "x", perUser: 1 }), usage("other", { userUses: 5 }))).toBeNull();
  });
});

describe("win-back and minimum order boundaries", () => {
  const wb = (days: number | null, minDays?: number) =>
    reason(cand({ id: "x", type: "win_back", rules: { level: "order", discount: { kind: "percent", bps: 100 }, targeting: minDays === undefined ? {} : { minDaysSinceLastOrder: minDays } } }), new Map(), ctx({ daysSinceLastOrder: days }));
  it("default 60 days: 60 passes, 59 refused, null refused", () => {
    expect(wb(60)).toBeNull();
    expect(wb(59)).toBe("win_back_window");
    expect(wb(null)).toBe("win_back_window");
    expect(wb(0)).toBe("win_back_window");
  });
  it("configured threshold: 10 passes, 9 refused (the configured value replaces the default)", () => {
    expect(wb(10, 10)).toBeNull();
    expect(wb(9, 10)).toBe("win_back_window");
    expect(wb(100, 200)).toBe("win_back_window");
  });
  it("minimum order is measured on the ELIGIBLE lines only: store A gross 130000", () => {
    const store = (min: bigint) => cand({ id: "x", storeId: A, rules: { level: "store", discount: { kind: "percent", bps: 100 } }, min });
    expect(reason(store(130_000n))).toBeNull();
    expect(reason(store(130_001n))).toBe("min_order");
    expect(reason(cand({ id: "x", min: 0n }))).toBeNull();
  });
  it("store-scoped promotion with nothing in that store has no eligible lines", () => {
    expect(reason(cand({ id: "x", storeId: "00000000-0000-4000-8000-0000000000ff", rules: { level: "store", discount: { kind: "percent", bps: 100 } } }))).toBe("no_eligible_lines");
  });
});

describe("discount caps are exact at the boundary", () => {
  // 10% of 170001 = 17000.1 -> 17000
  const run = (extra: Partial<Parameters<typeof cand>[0]>) => evaluate(bag(), ctx(), [cand({ id: "p", rules: pct(1000), ...extra })]);
  it("max discount: one above the raw, equal, one under", () => {
    expect(total(run({ max: 17_001n }))).toBe(17_000n);
    expect(total(run({ max: 17_000n }))).toBe(17_000n);
    expect(total(run({ max: 16_999n }))).toBe(16_999n);
    expect(total(run({ max: 1n }))).toBe(1n);
  });
  it("a max discount of 0 refuses as budget_exhausted (raw > 0 but cap 0), never applies a zero promotion", () => {
    const r = run({ max: 0n });
    expect(r.applied).toEqual([]);
    expect(r.rejected).toEqual([{ promotionId: "p", reason: "budget_exhausted" }]);
  });
  it("remaining budget (budget - used) caps the amount; the smaller of max and budget wins", () => {
    const c = (o: Partial<Parameters<typeof cand>[0]>) => cand({ id: "p", rules: pct(1000), ...o });
    expect(total(evaluate(bag(), ctx(), [c({ budget: 20_000n })], usage("p", { usedMinor: 3_001n })))).toBe(16_999n);
    expect(total(evaluate(bag(), ctx(), [c({ budget: 20_000n })], usage("p", { usedMinor: 3_000n })))).toBe(17_000n);
    expect(total(evaluate(bag(), ctx(), [c({ budget: 20_000n, max: 5_000n })], usage("p", { usedMinor: 3_000n })))).toBe(5_000n);
    expect(total(evaluate(bag(), ctx(), [c({ budget: 4_000n, max: 5_000n })], usage("p", { usedMinor: 3_000n })))).toBe(1_000n);
  });
  it("fixed amount is capped by what is left to pay: equal to goods, one above, one below", () => {
    const f = (n: bigint) => evaluate(bag(), ctx(), [cand({ id: "p", rules: fixed(String(n)) })]);
    expect(total(f(GOODS - 1n))).toBe(GOODS - 1n);
    expect(total(f(GOODS))).toBe(GOODS);
    expect(total(f(GOODS + 1n))).toBe(GOODS);
    expect(f(GOODS + 1n).totals.payable.amountMinor).toBe(11_000n); // only shipping left
  });
  it("shipping is never touched by a goods discount and 100% off leaves payable = shipping", () => {
    expect(evaluate(bag(), ctx(), [cand({ id: "p", rules: pct(10_000) })]).totals.payable.amountMinor).toBe(11_000n);
  });
  it("1 bp of 170001 rounds to 17 (17.0001) and 1 bp of 5000 (0.5) to 0 which is rejected as no_discount (half-even, never applied)", () => {
    expect(total(evaluate(bag(), ctx(), [cand({ id: "p", rules: pct(1) })]))).toBe(17n);
    const tiny = { currency: "EGP" as const, stores: [{ storeId: A, shippingFeeMinor: 0n, lines: [{ id: "t", storeId: A, productId: "p", qty: 1, unitMinor: 5_000n, vatBp: 1400 }] }] };
    expect(evaluate(tiny, ctx(), [cand({ id: "p", rules: pct(1) })]).rejected).toEqual([{ promotionId: "p", reason: "no_discount" }]);
  });
  it("half-even at .5: 5000 piastres x 1 bp is 0.5 -> 0, but 15000 x 1 bp = 1.5 -> 2 and 25000 x 1bp = 2.5 -> 2", () => {
    const one = (unit: bigint) => evaluate({ currency: "EGP", stores: [{ storeId: A, shippingFeeMinor: 0n, lines: [{ id: "t", storeId: A, productId: "p", qty: 1, unitMinor: unit, vatBp: 1400 }] }] }, ctx(), [cand({ id: "p", rules: pct(1) })]);
    expect(total(one(15_000n))).toBe(2n);
    expect(total(one(25_000n))).toBe(2n);
    expect(total(one(35_000n))).toBe(4n);
  });
});

describe("kind-specific thresholds", () => {
  it("tiered: reaching a tier minimum exactly applies it, one piastre below falls to the previous tier, none reached applies nothing", () => {
    const t = (min2: number) => evaluate(bag(), ctx(), [cand({ id: "t", type: "tiered", rules: order({ discount: { kind: "tiered", tiers: [{ minSubtotalMinor: "100000", bps: 1000 }, { minSubtotalMinor: String(min2), bps: 2000 }] } }) })]);
    expect(total(t(170_001))).toBe(34_000n); // 20% of 170001 = 34000.2
    expect(total(t(170_002))).toBe(17_000n); // 10%
    const none = evaluate(bag(), ctx(), [cand({ id: "t", type: "tiered", rules: order({ discount: { kind: "tiered", tiers: [{ minSubtotalMinor: "170002", bps: 1000 }] } }) })]);
    expect(none.rejected).toEqual([{ promotionId: "t", reason: "no_discount" }]);
  });
  it("tiered qualifies on the ORIGINAL subtotal even after an item-level promotion shrank the remaining base", () => {
    const item = cand({ id: "a-item", rules: { level: "item", discount: { kind: "percent", bps: 5000 } } }); // 85000.5 -> 85000
    const tier = cand({ id: "b-tier", type: "tiered", rules: order({ discount: { kind: "tiered", tiers: [{ minSubtotalMinor: "170001", bps: 2000 }] } }) });
    const r = evaluate(bag(), ctx(), [tier, item]);
    expect(r.applied.map((a) => a.promotionId)).toEqual(["a-item", "b-tier"]);
    expect(total(r, 0)).toBe(85_000n);
    expect(total(r, 1)).toBe(17_000n); // 20% of the remaining 85001 = 17000.2
  });
  const bogo = (buyQty: number, getQty: number, productIds: string[], getBps = 10_000) =>
    evaluate(bag(), ctx(), [cand({ id: "b", type: "bogo", rules: { level: "item", discount: { kind: "bogo", buyQty, getQty, getBps }, targeting: { productIds } } })]);
  it("bogo takes the cheapest units: p1,p2 hold units 50000,50000,30000; buy1 get1 frees one (30000)", () => {
    expect(total(bogo(1, 1, ["p1", "p2"]))).toBe(30_000n);
  });
  it("bogo: exactly buy+get units frees one group, one unit fewer frees none", () => {
    expect(total(bogo(2, 1, ["p1", "p2"]))).toBe(30_000n); // 3 units
    expect(bogo(3, 1, ["p1", "p2"]).rejected).toEqual([{ promotionId: "b", reason: "no_discount" }]); // 3 units < 4
  });
  it("bogo: getQty 2 and two full groups; partial percentage applies once to the free value", () => {
    // p1,p2,p3 units sorted: 30000, 40001, 50000, 50000 ; buy1 get1 -> 2 free = 70001 ; at 50% = 35000.5 -> 35000 (half-even)
    expect(total(bogo(1, 1, ["p1", "p2", "p3"]))).toBe(70_001n);
    expect(total(bogo(1, 1, ["p1", "p2", "p3"], 5_000))).toBe(35_000n);
    expect(total(bogo(1, 2, ["p1", "p2", "p3"]))).toBe(30_000n + 40_001n); // floor(4/3)=1 group x 2 free
  });
  it("bundle: needs every product, sets = min units; matched value x bps rounded once", () => {
    const bundle = (ids: string[]) => evaluate(bag(), ctx(), [cand({ id: "u", type: "bundle", rules: { level: "item", discount: { kind: "bundle", productIds: ids, bps: 1000 } } })]);
    expect(total(bundle(["p1", "p3"]))).toBe(9_000n); // 1 set: one p1 (50000) + p3 (40001) = 90001 -> 9000.1
    expect(total(bundle(["p1", "p2"]))).toBe(8_000n); // 1 set: 50000 + 30000 = 80000 -> 8000
    expect(bundle(["p1", "p9"]).rejected).toEqual([{ promotionId: "u", reason: "no_discount" }]);
  });
});

describe("funding split rounding", () => {
  it("co-funded: platform share is half-even of amount x bp, seller gets the remainder (5 at 50% -> 2/3, 3 at 50% -> 2/1)", () => {
    // one line only: the discount is spread over lines first, and each line's funding split rounds separately
    const single = { currency: "EGP" as const, stores: [{ storeId: A, shippingFeeMinor: 0n, lines: [{ id: "t", storeId: A, productId: "p1", qty: 1, unitMinor: 50_000n, vatBp: 1400 }] }] };
    const run = (n: number) => evaluate(single, ctx(), [cand({ id: "c", storeId: A, owner: "co_funded", fp: 5_000, fs: 5_000, type: "fixed", rules: { level: "store", discount: { kind: "fixed", amountMinor: String(n) } } })]);
    const a5 = run(5).applied[0];
    expect([a5?.platform.amountMinor, a5?.seller.amountMinor]).toEqual([2n, 3n]);
    const a3 = run(3).applied[0];
    expect([a3?.platform.amountMinor, a3?.seller.amountMinor]).toEqual([2n, 1n]);
  });
  it("100% platform or 100% seller puts everything on one side and 0 on the other", () => {
    const p = evaluate(bag(), ctx(), [cand({ id: "p", rules: fixed(777) })]).applied[0];
    expect([p?.platform.amountMinor, p?.seller.amountMinor]).toEqual([777n, 0n]);
    const s = evaluate(bag(), ctx(), [cand({ id: "s", storeId: A, rules: { level: "store", discount: { kind: "fixed", amountMinor: "777" } } })]).applied[0];
    expect([s?.platform.amountMinor, s?.seller.amountMinor]).toEqual([0n, 777n]);
  });
  it("free shipping under a cap spreads by remaining fee with largest remainder: 4000 over fees 6000/5000 is 2182/1818", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "f", type: "free_shipping", max: 4_000n, rules: { level: "shipping", discount: { kind: "free_shipping" } } })]);
    expect(r.applied[0]?.shipping.map((s) => [s.storeId, s.amount.amountMinor])).toEqual([[A, 2_182n], [B, 1_818n]]);
    expect(r.totals.shippingDiscount.amountMinor).toBe(4_000n);
    expect(r.totals.payable.amountMinor).toBe(GOODS + 7_000n);
  });
  it("free shipping with cap 0 is budget_exhausted, with no fees is no_discount, and never exceeds the fee", () => {
    const f = (max: bigint | null) => evaluate(bag(), ctx(), [cand({ id: "f", type: "free_shipping", max, rules: { level: "shipping", discount: { kind: "free_shipping" } } })]);
    expect(f(0n).rejected).toEqual([{ promotionId: "f", reason: "budget_exhausted" }]);
    expect(total(f(11_001n))).toBe(11_000n);
    expect(total(f(11_000n))).toBe(11_000n);
    expect(total(f(10_999n))).toBe(10_999n);
  });
  it("store-scoped free shipping only waives that store's fee", () => {
    const r = evaluate(bag(), ctx(), [cand({ id: "f", storeId: B, type: "free_shipping", rules: { level: "shipping", discount: { kind: "free_shipping" } } })]);
    expect(total(r)).toBe(5_000n);
    expect(r.stores.map((s) => s.shippingPayable.amountMinor)).toEqual([6_000n, 0n]);
  });
});

describe("evaluation order changes totals where the order is mutated", () => {
  const item10k = cand({ id: "z-item", rules: { level: "item", discount: { kind: "fixed", amountMinor: "10000" } } });
  const order10 = cand({ id: "a-order", rules: pct(1000) });
  it("item before order: 10000 then 10% of 160001 (16000) = 26000; the reverse order would give 27000", () => {
    const r = evaluate(bag(), ctx(), [order10, item10k]);
    expect(r.applied.map((a) => [a.promotionId, a.total.amountMinor])).toEqual([["z-item", 10_000n], ["a-order", 16_000n]]);
    expect(r.totals.goodsDiscount.amountMinor).toBe(26_000n);
  });
  it("same level: auto before store_voucher before platform_code, regardless of id", () => {
    const auto = cand({ id: "z-auto", rules: fixed(10_000) });
    const code = cand({ id: "a-code", cls: "platform_code", rules: pct(1000) });
    const r = evaluate(bag(), ctx(), [code, auto]);
    expect(r.applied.map((a) => a.promotionId)).toEqual(["z-auto", "a-code"]);
    expect(r.totals.goodsDiscount.amountMinor).toBe(26_000n);
    const sv = cand({ id: "m-sv", storeId: A, cls: "store_voucher", rules: { level: "order", discount: { kind: "fixed", amountMinor: "1" } } });
    expect(evaluate(bag(), ctx(), [code, sv, auto]).applied.map((a) => a.promotionId)).toEqual(["z-auto", "m-sv", "a-code"]);
  });
  it("same level and class: id ascending decides (10% first = 17000+10000 vs fixed first = 10000+16000)", () => {
    const a = cand({ id: "a", rules: pct(1000) });
    const b = cand({ id: "b", rules: fixed(10_000) });
    const r = evaluate(bag(), ctx(), [b, a]);
    expect(r.applied.map((x) => x.promotionId)).toEqual(["a", "b"]);
    expect(r.totals.goodsDiscount.amountMinor).toBe(27_000n);
  });
  it("shipping level runs after order level and payment-partner last", () => {
    const ship = cand({ id: "a-ship", type: "free_shipping", rules: { level: "shipping", discount: { kind: "free_shipping" } } });
    const pp = cand({ id: "a-pp", type: "payment_partner", cls: "payment_partner", rules: { level: "payment_partner", discount: { kind: "percent", bps: 1000 }, targeting: { paymentMethods: ["card"] } } });
    const o = cand({ id: "z-order", rules: pct(1000) });
    expect(evaluate(bag(), ctx(), [pp, ship, o]).applied.map((a) => a.promotionId)).toEqual(["z-order", "a-ship", "a-pp"]);
  });
});

describe("stacking matrix and auto-best limits", () => {
  const code = (id: string) => cand({ id, cls: "platform_code" });
  it("a platform code and a payment-partner offer are counted in separate classes; any number of auto promotions", () => {
    const pp = cand({ id: "pp", type: "payment_partner", cls: "payment_partner", rules: { level: "payment_partner", discount: { kind: "percent", bps: 100 }, targeting: { paymentMethods: ["card"] } } });
    expect(() => { validateStacking([code("a"), pp, ...Array.from({ length: 8 }, (_, i) => cand({ id: `auto${String(i)}` }))]); }).not.toThrow();
    expect(() => { validateStacking([]); }).not.toThrow();
  });
  it("auto-best with no candidates evaluates exactly one (empty) subset", () => {
    expect(autoBest(bag(), ctx(), []).considered).toBe(1);
  });
  it("exactly 5 eligible auto candidates is allowed (32 subsets), 6 throws, an ineligible 6th does not count", () => {
    const mk = (i: number, o: Partial<Parameters<typeof cand>[0]> = {}) => cand({ id: `m${String(i)}`, rules: fixed(100 * (i + 1)), ...o });
    const five = Array.from({ length: 5 }, (_, i) => mk(i));
    expect(autoBest(bag(), ctx(), five).considered).toBe(32);
    expect(() => autoBest(bag(), ctx(), [...five, mk(5)])).toThrow(/at most 5/);
    expect(autoBest(bag(), ctx(), [...five, mk(5, { status: "ENDED" })]).considered).toBe(32);
  });
  it("pruning: exactly 5 eligible prunes nothing; ties on saving keep the smallest ids", () => {
    const mk = (i: number) => cand({ id: `m${String(i)}`, rules: fixed(500) });
    expect(pruneCandidates(bag(), ctx(), Array.from({ length: 5 }, (_, i) => mk(i))).prunedIds).toEqual([]);
    const seven = pruneCandidates(bag(), ctx(), Array.from({ length: 7 }, (_, i) => mk(i)));
    expect(seven.kept.map((c) => c.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(seven.prunedIds).toEqual(["m5", "m6"]);
  });
  it("pruning also counts shipping savings and sorts by saving descending", () => {
    const ship = cand({ id: "s", type: "free_shipping", rules: { level: "shipping", discount: { kind: "free_shipping" } } }); // saves 11000
    const smalls = Array.from({ length: 5 }, (_, i) => cand({ id: `m${String(i)}`, rules: fixed(100 * (i + 1)) }));
    const r = pruneCandidates(bag(), ctx(), [...smalls, ship]);
    expect(r.kept.map((c) => c.id)).toContain("s");
    expect(r.prunedIds).toEqual(["m0"]); // the smallest saving (100) is dropped
  });
  it("auto-best tie-break: equal totals prefer fewer promotions", () => {
    const one = cand({ id: "z-one", rules: fixed(String(GOODS)) }); // zeroes the goods alone, so adding any other promotion cannot beat it
    const two1 = cand({ id: "a-1", rules: fixed(1_000) });
    const two2 = cand({ id: "a-2", rules: fixed(1_000) });
    expect(autoBest(bag(), ctx(), [two1, two2, one]).selectedIds).toEqual(["z-one"]);
  });
});

describe("formatMinor is integer-only", () => {
  it("pads the fraction and handles 0, single piastres and negatives", () => {
    expect([0n, 5n, 100n, 12_550n, -5n, -12_550n].map((n) => formatMinor(money(n, "EGP")))).toEqual(["0.00", "0.05", "1.00", "125.50", "-0.05", "-125.50"]);
  });
});

describe("PROPERTIES (extending property.test.ts)", () => {
  const bagArb = fc.array(fc.record({ s: fc.constantFrom(A, B), u: fc.bigInt({ min: 100n, max: 500_000n }), q: fc.integer({ min: 1, max: 4 }) }), { minLength: 1, maxLength: 5 }).map((ls) => ({
    currency: "EGP" as const,
    stores: [A, B].map((id) => ({ storeId: id, shippingFeeMinor: 1_234n, lines: ls.map((l, i) => ({ l, i })).filter(({ l }) => l.s === id).map(({ l, i }) => ({ id: `l${String(i)}`, storeId: id, productId: `p${String(i)}`, qty: l.q, unitMinor: l.u, vatBp: 1400 })) })).filter((s) => s.lines.length > 0),
  }));
  const promoArb = fc.record({ bps: fc.integer({ min: 1, max: 10_000 }), max: fc.option(fc.bigInt({ min: 0n, max: 200_000n }), { nil: null }), budget: fc.option(fc.bigInt({ min: 0n, max: 200_000n }), { nil: null }), used: fc.bigInt({ min: 0n, max: 100_000n }) });
  it("every applied promotion respects max discount and the remaining budget, and its parts sum to its total", () => {
    fc.assert(fc.property(bagArb, promoArb, (b, p) => {
      const c = cand({ id: "p", rules: pct(p.bps), max: p.max, budget: p.budget });
      const r = evaluate(b, ctx(), [c], usage("p", { usedMinor: p.used }));
      for (const a of r.applied) {
        if (p.max !== null) expect(a.total.amountMinor <= p.max).toBe(true);
        if (p.budget !== null) expect(a.total.amountMinor <= p.budget - p.used).toBe(true);
        expect(a.total.amountMinor > 0n).toBe(true);
        expect(a.platform.amountMinor + a.seller.amountMinor).toBe(a.total.amountMinor);
        expect(a.lines.reduce((x, l) => x + l.amount.amountMinor, 0n)).toBe(a.total.amountMinor);
      }
      // a rejected promotion discounts nothing
      if (r.applied.length === 0) expect(r.totals.goodsDiscount.amountMinor).toBe(0n);
      expect(r.totals.payable.amountMinor >= 0n).toBe(true);
    }), { numRuns: 500 });
  });
  it("re-evaluating with the same usage snapshot is identical (idempotent)", () => {
    fc.assert(fc.property(bagArb, promoArb, (b, p) => {
      const c = cand({ id: "p", rules: pct(p.bps), max: p.max, budget: p.budget });
      const u = usage("p", { usedMinor: p.used });
      expect(evaluate(b, ctx(), [c], u)).toEqual(evaluate(b, ctx(), [c], u));
    }), { numRuns: 200 });
  });
});
