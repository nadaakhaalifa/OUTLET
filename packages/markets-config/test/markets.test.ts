import { describe, expect, it } from "vitest";
import { MARKETS, UnknownMarketError, getMarket, listMarkets, marketSchema } from "../src/index.js";

describe("markets-config", () => {
  it("lists Egypt first with its fiscal defaults", () => {
    const eg = listMarkets()[0];
    expect(eg).toMatchObject({ id: "eg", currency: "EGP", minorUnits: 2, defaultLocale: "ar-EG", timezone: "Africa/Cairo", vatBps: 1400 });
  });
  it("getMarket returns the market and throws a typed error otherwise", () => {
    expect(getMarket("eg").currency).toBe("EGP");
    expect(() => getMarket("zz")).toThrow(UnknownMarketError);
  });
  it("every configured market passes the schema", () => {
    for (const m of MARKETS) expect(marketSchema.safeParse(m).success).toBe(true);
  });
  it("rejects fractional VAT and unknown keys", () => {
    const eg = getMarket("eg");
    expect(marketSchema.safeParse({ ...eg, vatBps: 14.5 }).success).toBe(false);
    expect(marketSchema.safeParse({ ...eg, extra: 1 }).success).toBe(false);
  });
  it("rejects an unknown timezone, a default locale outside locales, and wrong minorUnits", () => {
    const eg = getMarket("eg");
    expect(marketSchema.safeParse({ ...eg, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(marketSchema.safeParse({ ...eg, defaultLocale: "en-US" }).success).toBe(false);
    expect(marketSchema.safeParse({ ...eg, minorUnits: 3 }).success).toBe(false);
  });
});
