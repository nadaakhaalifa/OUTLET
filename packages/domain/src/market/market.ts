import { DomainError } from "../errors";
import type { Money } from "../money";

/**
 * `Market` is a pure value: the set of per-country facts the rest of the system reads instead of
 * hard-coding Egypt (ADR-0040, option 1). It carries REFERENCES (keys) to tax, age-policy, legal-text
 * and residency configuration, never the rules themselves. No country other than EG has been
 * researched; defining a second `Market` value is a configuration act that stays blocked until the
 * market's verify-register rows are closed (docs/specs/phase-3/gcc-market-abstraction.md).
 */
export class MarketError extends DomainError {}
export class MarketMismatchError extends MarketError {}
export class MarketNotEnabledError extends MarketError {}

export interface MarketCurrency {
  /** ISO 4217 alphabetic code, e.g. "EGP". */
  readonly code: string;
  /** Number of minor-unit digits. 0..3; exponent 3 currencies must not be assumed away. */
  readonly minorUnitExponent: 0 | 1 | 2 | 3;
}

export interface Market {
  /** ISO 3166-1 alpha-2, upper case. */
  readonly code: string;
  readonly currency: MarketCurrency;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  /** IANA zone used for calendar-day decisions (caps, windows, reminders). */
  readonly timezone: string;
  /** Key of the VAT/tax table, resolved by the tax module (never inlined here). */
  readonly vatConfigRef: string;
  /** Key of the age-policy row set (spec B6), resolved by the policy layer. */
  readonly agePolicyRef: string;
  readonly paymentMethods: readonly string[];
  readonly couriers: readonly string[];
  /** Key of the legal-text bundle (terms, privacy, returns policy), resolved by the content layer. */
  readonly legalTextSetKey: string;
  /** Key of the data-residency region (ADR-0002); the key is a label, not a hosting decision. */
  readonly dataResidencyRegionKey: string;
}

const MARKET_CODE = /^[A-Z]{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const REF = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

export function isMarketCode(value: string): boolean {
  return MARKET_CODE.test(value);
}

function assertRef(name: string, value: string): void {
  if (!REF.test(value)) throw new MarketError(`${name} must be a lower-case reference key`);
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates and freezes a market definition. Throws `MarketError` on any malformed field. */
export function defineMarket(input: Market): Market {
  if (!MARKET_CODE.test(input.code)) throw new MarketError("market code must be two upper-case letters");
  if (!CURRENCY_CODE.test(input.currency.code)) throw new MarketError("currency code must be ISO 4217 alphabetic");
  if (![0, 1, 2, 3].includes(input.currency.minorUnitExponent)) {
    throw new MarketError("minor unit exponent must be 0, 1, 2 or 3");
  }
  if (!LOCALE.test(input.defaultLocale)) throw new MarketError("default locale is malformed");
  if (input.supportedLocales.length === 0 || !input.supportedLocales.every((l) => LOCALE.test(l))) {
    throw new MarketError("supported locales must be non-empty and well formed");
  }
  if (!input.supportedLocales.includes(input.defaultLocale)) {
    throw new MarketError("default locale must be among the supported locales");
  }
  if (!validTimeZone(input.timezone)) throw new MarketError("unknown IANA time zone");
  assertRef("vatConfigRef", input.vatConfigRef);
  assertRef("agePolicyRef", input.agePolicyRef);
  assertRef("legalTextSetKey", input.legalTextSetKey);
  assertRef("dataResidencyRegionKey", input.dataResidencyRegionKey);
  return Object.freeze({
    ...input,
    currency: Object.freeze({ ...input.currency }),
    supportedLocales: Object.freeze([...input.supportedLocales]),
    paymentMethods: Object.freeze([...input.paymentMethods]),
    couriers: Object.freeze([...input.couriers]),
  });
}

/** Number of minor units in one major unit, exact (10^exponent). */
export function minorUnitsPerMajor(market: Market): bigint {
  return 10n ** BigInt(market.currency.minorUnitExponent);
}

/** Throws unless the amount is in the market's currency. Money never mixes across markets. */
export function assertMoneyInMarket(market: Market, amount: Money): void {
  if (amount.currency !== market.currency.code) {
    throw new MarketMismatchError(
      `amount is in ${amount.currency}, market ${market.code} uses ${market.currency.code}`,
    );
  }
}

/** A record scoped to a market (price events, promotions, budgets, orders). */
export interface MarketScoped {
  readonly market: string;
}

/** Only the records belonging to `code`. Never returns another market's rows. */
export function scopeToMarket<T extends MarketScoped>(records: readonly T[], code: string): T[] {
  return records.filter((r) => r.market === code);
}

/** Throws unless every record is in the same market (guards combination of prices, vouchers, budgets). */
export function assertSameMarket(records: readonly MarketScoped[]): string | undefined {
  const first = records[0];
  if (first === undefined) return undefined;
  for (const r of records) {
    if (r.market !== first.market) {
      throw new MarketMismatchError(`records span markets ${first.market} and ${r.market}`);
    }
  }
  return first.market;
}

export interface MarketRegistry {
  readonly defaultMarket: Market;
  get(code: string): Market | undefined;
  /** Static configuration says the market is switched on (EG only today). */
  isEnabled(code: string): boolean;
  /**
   * Availability: the default market needs only static enablement. Any other market additionally
   * needs the `expansionFlag` (release flag, default false, fails closed) to be true.
   */
  isAvailable(code: string, expansionFlag: boolean): boolean;
  require(code: string, expansionFlag: boolean): Market;
  all(): readonly Market[];
}

export interface RegistryOptions {
  readonly defaultCode: string;
  readonly enabledCodes: readonly string[];
}

export function createMarketRegistry(markets: readonly Market[], options: RegistryOptions): MarketRegistry {
  const byCode = new Map<string, Market>();
  for (const m of markets) {
    if (byCode.has(m.code)) throw new MarketError(`duplicate market ${m.code}`);
    byCode.set(m.code, m);
  }
  const defaultMarket = byCode.get(options.defaultCode);
  if (defaultMarket === undefined) throw new MarketError("default market is not defined");
  for (const code of options.enabledCodes) {
    if (!byCode.has(code)) throw new MarketError(`enabled market ${code} is not defined`);
  }
  if (!options.enabledCodes.includes(options.defaultCode)) {
    throw new MarketError("the default market must be enabled");
  }
  const enabled = new Set(options.enabledCodes);
  const isAvailable = (code: string, expansionFlag: boolean): boolean =>
    byCode.has(code) && enabled.has(code) && (code === options.defaultCode || expansionFlag === true);
  return {
    defaultMarket,
    get: (code) => byCode.get(code),
    isEnabled: (code) => enabled.has(code),
    isAvailable,
    require(code, expansionFlag) {
      const market = byCode.get(code);
      if (market === undefined || !isAvailable(code, expansionFlag)) {
        throw new MarketNotEnabledError(`market ${code} is not enabled`);
      }
      return market;
    },
    all: () => [...byCode.values()],
  };
}
