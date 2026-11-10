import { CURRENCIES, CURRENCY_MINOR_UNITS } from "@outlet/money";
import { z } from "zod";

const TIMEZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("timeZone"));

export const marketSchema = z
  .strictObject({
  id: z.string().regex(/^[a-z]{2}$/),
  name: z.string().min(1),
  currency: z.enum(CURRENCIES),
  minorUnits: z.number().int().min(0).max(3),
  defaultLocale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  locales: z.array(z.string().regex(/^[a-z]{2}-[A-Z]{2}$/)).min(1),
  timezone: z.string().refine((tz) => TIMEZONES.has(tz), "unknown IANA timezone"),
  /** VAT in basis points (1400 = 14%). Integer only. */
  vatBps: z.number().int().min(0).max(10_000),
  })
  .refine((m) => m.locales.includes(m.defaultLocale), {
    message: "defaultLocale must be one of locales",
    path: ["defaultLocale"],
  })
  .refine((m) => m.minorUnits === CURRENCY_MINOR_UNITS[m.currency], {
    message: "minorUnits must match the currency",
    path: ["minorUnits"],
  });
export type Market = z.infer<typeof marketSchema>;
export type MarketId = string;

export class UnknownMarketError extends Error {
  readonly marketId: string;
  constructor(marketId: string) {
    super(`unknown market: ${marketId}`);
    this.name = "UnknownMarketError";
    this.marketId = marketId;
  }
}

// EG first. Other markets are added only with a legal/tax review (ADR-0006).
const RAW_MARKETS: readonly unknown[] = [
  {
    id: "eg",
    name: "Egypt",
    currency: "EGP",
    minorUnits: 2,
    defaultLocale: "ar-EG",
    locales: ["ar-EG", "en-GB"],
    timezone: "Africa/Cairo",
    vatBps: 1400,
  },
];

export const MARKETS: readonly Market[] = Object.freeze(RAW_MARKETS.map((m) => Object.freeze(marketSchema.parse(m))));

export function listMarkets(): readonly Market[] {
  return MARKETS;
}

export function getMarket(id: string): Market {
  const found = MARKETS.find((m) => m.id === id);
  if (!found) throw new UnknownMarketError(id);
  return found;
}
