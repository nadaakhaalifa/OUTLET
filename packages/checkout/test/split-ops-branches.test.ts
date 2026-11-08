import { describe, expect, it } from "vitest";
import { money } from "@outlet/money";
import { sellerAmounts, splitInstructions } from "../src/index.js";
import type { StoreQuote } from "../src/index.js";
import { clearingFor } from "../src/application/order-ops.js";
import { makeEnv } from "../src/application/env.js";
import { UnconfiguredRisk } from "../src/application/unconfigured.js";

const e = (n: bigint) => money(n, "EGP");
const store = (id: string, items: bigint, ship: bigint, shipVat: bigint): StoreQuote => ({
  storeId: id, lines: [], itemsSubtotal: e(items), shipping: { gross: e(ship), vat: e(shipVat), quoteRef: "r", etaDaysMin: 1, etaDaysMax: 2 },
  vat: e(shipVat + (items * 14n) / 114n), total: e(items + ship),
});

describe("sellerAmounts guards", () => {
  it.each([[-1], [10_001], [1.5], [Number.NaN]])("rejects commission bp %s", (bp) => {
    expect(() => sellerAmounts(store("A", 10_000n, 6_000n, 700n), bp, 1400)).toThrow(RangeError);
  });
  it("accepts the 0 and 10000 boundaries; 100% commission leaves a negative net only through VAT", () => {
    expect(sellerAmounts(store("A", 10_000n, 0n, 0n), 0, 1400).net.amountMinor).toBe(10_000n);
    expect(() => sellerAmounts(store("A", 10_000n, 0n, 0n), 10_000, 1400)).toThrow(/net/i);
  });
});

describe("splitInstructions fallbacks", () => {
  const A = sellerAmounts(store("A", 10_000n, 6_000n, 700n), 1000, 1400);
  const B = sellerAmounts(store("B", 5_000n, 6_000n, 700n), 1000, 1400);
  it("unknown store maps give empty seller order id and null sub-merchant; seller gets min(net, share)", () => {
    const out = splitInstructions([A, B], e(A.total.amountMinor + B.total.amountMinor), new Map(), new Map());
    expect(out.map((o) => [o.sellerOrderId, o.subMerchantRef])).toEqual([["", null], ["", null]]);
    expect(out[0]?.sellerAmount.amountMinor).toBe(A.net.amountMinor);
    expect(out.reduce((s, o) => s + o.sellerAmount.amountMinor + o.platformAmount.amountMinor, 0n)).toBe(A.total.amountMinor + B.total.amountMinor);
  });
  it("with store credit the external amount is smaller than totals: seller share is capped by the share, sum is exact", () => {
    const external = e(3_000n);
    const out = splitInstructions([A, B], external, new Map([["A", "so-a"]]), new Map([["A", "sub-1"], ["B", null]]));
    expect(out[0]).toMatchObject({ sellerOrderId: "so-a", subMerchantRef: "sub-1" });
    expect(out.reduce((s, o) => s + o.sellerAmount.amountMinor + o.platformAmount.amountMinor, 0n)).toBe(3_000n);
    for (const o of out) expect(o.platformAmount.amountMinor >= 0n).toBe(true);
  });
  it("no sellers is refused by allocate (never silently zero instructions)", () => {
    expect(() => splitInstructions([], e(0n), new Map(), new Map())).toThrow(/non-empty/);
  });
});

describe("clearingFor", () => {
  it("routes paymob and fake to paymob psp clearing", () => {
    expect(clearingFor("paymob", "card", null)).toEqual({ type: "psp_clearing", owner: "paymob" });
    expect(clearingFor("fake", "card", null)).toEqual({ type: "psp_clearing", owner: "paymob" });
  });
  it("routes bnpl to the provider and fails closed without one", () => {
    expect(clearingFor("paymob", "bnpl", "valu")).toEqual({ type: "bnpl_clearing", owner: "valu" });
    expect(() => clearingFor("paymob", "bnpl", null)).toThrow(/bnpl intent without a provider/);
  });
  it("fails closed for an unseeded provider", () => {
    expect(() => clearingFor("fawry", "card", null)).toThrow(/no clearing account is seeded for provider fawry/);
  });
});

describe("makeEnv defaults and UnconfiguredRisk", () => {
  it("fills in fail-closed risk, EGP, clock and id generator, and keeps explicit overrides", async () => {
    const base = {} as never;
    const env = makeEnv({ marketId: "EG", config: base, reservations: base, provider: base, shipping: base, address: base, commission: base, taxCategories: base, taxRates: base, credit: base, tokens: base, prices: base, killSwitches: base, subMerchants: base, billing: base, refunds: base });
    expect(env.currency).toBe("EGP");
    expect(env.risk).toBeInstanceOf(UnconfiguredRisk);
    expect(env.now()).toBeInstanceOf(Date);
    expect(env.newId()).not.toBe(env.newId());
    expect(await env.risk.assessCod({} as never)).toEqual({ decision: "block", reasonCodes: ["risk_unconfigured"] });
    const fixed = new Date("2030-01-01T00:00:00Z");
    const o = makeEnv({ marketId: "SA", currency: "SAR", now: () => fixed, newId: () => "id-1", risk: env.risk, config: base, reservations: base, provider: base, shipping: base, address: base, commission: base, taxCategories: base, taxRates: base, credit: base, tokens: base, prices: base, killSwitches: base, subMerchants: base, billing: base, refunds: base });
    expect([o.currency, o.now(), o.newId()]).toEqual(["SAR", fixed, "id-1"]);
  });
});
