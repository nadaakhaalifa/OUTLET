import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CurrencyMismatchError } from "../errors";
import { createJournalEntry, trialBalance } from "../ledger";
import { add, money, type Currency, type Money } from "../money";
import {
  EG_MARKET,
  MARKETS,
  MarketError,
  MarketMismatchError,
  MarketNotEnabledError,
  assertMoneyInMarket,
  assertSameMarket,
  createMarketRegistry,
  defineMarket,
  minorUnitsPerMajor,
  scopeToMarket,
  type Market,
} from "./index";

/** Test-only second currency: the production `Currency` type has one member on purpose. */
function foreign(amount: bigint, code: string): Money {
  return { amount, currency: code as unknown as Currency };
}

const OTHER: Market = defineMarket({
  ...EG_MARKET,
  code: "ZZ",
  currency: { code: "XTS", minorUnitExponent: 3 },
  timezone: "UTC",
  vatConfigRef: "vat:zz:test",
  legalTextSetKey: "legal:zz:test",
});

describe("market definition", () => {
  it("EG restates the existing assumptions", () => {
    expect(EG_MARKET.currency).toEqual({ code: "EGP", minorUnitExponent: 2 });
    expect(EG_MARKET.timezone).toBe("Africa/Cairo");
    expect(minorUnitsPerMajor(EG_MARKET)).toBe(100n);
    expect(Object.isFrozen(EG_MARKET)).toBe(true);
    expect(Object.isFrozen(EG_MARKET.couriers)).toBe(true);
  });

  it("exponent 3 is supported exactly", () => {
    expect(minorUnitsPerMajor(OTHER)).toBe(1000n);
  });

  it.each([
    ["code", { code: "egypt" }],
    ["currency", { currency: { code: "egp", minorUnitExponent: 2 as const } }],
    ["exponent", { currency: { code: "EGP", minorUnitExponent: 4 as unknown as 2 } }],
    ["locale", { defaultLocale: "xx_YY" }],
    ["default locale not supported", { defaultLocale: "fr" }],
    ["timezone", { timezone: "Mars/Olympus" }],
    ["ref", { vatConfigRef: "Has Spaces" }],
    ["empty locales", { supportedLocales: [] }],
  ])("rejects a malformed %s", (_name, patch) => {
    expect(() => defineMarket({ ...EG_MARKET, ...patch })).toThrow(MarketError);
  });
});

describe("registry and gating", () => {
  it("production registry has exactly one market, enabled", () => {
    expect(MARKETS.all().map((m) => m.code)).toEqual(["EG"]);
    expect(MARKETS.isAvailable("EG", false)).toBe(true);
    expect(MARKETS.isAvailable("ZZ", true)).toBe(false);
    expect(() => MARKETS.require("ZZ", true)).toThrow(MarketNotEnabledError);
  });

  it("a second defined market needs both static enablement and the flag", () => {
    const reg = createMarketRegistry([EG_MARKET, OTHER], { defaultCode: "EG", enabledCodes: ["EG"] });
    expect(reg.isAvailable("ZZ", true)).toBe(false);
    const enabled = createMarketRegistry([EG_MARKET, OTHER], { defaultCode: "EG", enabledCodes: ["EG", "ZZ"] });
    expect(enabled.isAvailable("ZZ", false)).toBe(false);
    expect(enabled.isAvailable("ZZ", true)).toBe(true);
    expect(enabled.isAvailable("EG", false)).toBe(true);
  });

  it("rejects an inconsistent registry", () => {
    expect(() => createMarketRegistry([EG_MARKET, EG_MARKET], { defaultCode: "EG", enabledCodes: ["EG"] })).toThrow(MarketError);
    expect(() => createMarketRegistry([EG_MARKET], { defaultCode: "EG", enabledCodes: ["EG", "ZZ"] })).toThrow(MarketError);
    expect(() => createMarketRegistry([EG_MARKET, OTHER], { defaultCode: "EG", enabledCodes: ["ZZ"] })).toThrow(MarketError);
    expect(() => createMarketRegistry([OTHER], { defaultCode: "EG", enabledCodes: ["EG"] })).toThrow(MarketError);
  });
});

describe("a second market cannot leak (properties)", () => {
  const amt = fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n });

  it("money in different currencies never mixes", () => {
    fc.assert(
      fc.property(amt, amt, (a, b) => {
        expect(() => add(money(a), foreign(b, "XTS"))).toThrow(CurrencyMismatchError);
        expect(() => assertMoneyInMarket(OTHER, money(a))).toThrow(MarketMismatchError);
        expect(() => assertMoneyInMarket(EG_MARKET, foreign(b, "XTS"))).toThrow(MarketMismatchError);
        expect(() => assertMoneyInMarket(EG_MARKET, money(a))).not.toThrow();
      }),
    );
  });

  it("a ledger entry cannot balance across currencies", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000n }), (n) => {
        const meta = { id: "e", kind: "k", idempotencyKey: "i", occurredAt: new Date(0), ref: { type: "t", id: "1" } };
        expect(() =>
          createJournalEntry({ ...meta, postings: [{ account: "a", amount: money(n) }, { account: "b", amount: foreign(-n, "XTS") }] }),
        ).toThrow();
      }),
    );
  });

  it("entries balance per currency and the trial balance nets to zero per currency", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.bigInt({ min: 1n, max: 1_000_000n }), fc.boolean()), { minLength: 1, maxLength: 20 }), (rows) => {
        const entries = rows.map(([n, egp], i) => {
          const cur = (v: bigint): Money => (egp ? money(v) : foreign(v, "XTS"));
          return createJournalEntry({
            id: `e${i}`,
            kind: "k",
            idempotencyKey: `i${i}`,
            occurredAt: new Date(0),
            ref: { type: "t", id: String(i) },
            postings: [
              { account: "a", amount: cur(n) },
              { account: "b", amount: cur(-n) },
            ],
          });
        });
        for (const total of trialBalance(entries).values()) expect(total).toBe(0n);
      }),
    );
  });

  it("market-scoped records (prices, promotions, budgets) never cross", () => {
    const rec = fc.record({ market: fc.constantFrom("EG", "ZZ"), id: fc.nat() });
    fc.assert(
      fc.property(fc.array(rec, { maxLength: 30 }), (records) => {
        const eg = scopeToMarket(records, "EG");
        const zz = scopeToMarket(records, "ZZ");
        expect(eg.length + zz.length).toBe(records.length);
        expect(eg.every((r) => r.market === "EG")).toBe(true);
        const mixed = records.some((r) => r.market === "EG") && records.some((r) => r.market === "ZZ");
        if (mixed) expect(() => assertSameMarket(records)).toThrow(MarketMismatchError);
        else expect(() => assertSameMarket(records)).not.toThrow();
      }),
    );
  });
});
