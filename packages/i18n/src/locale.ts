import { UnknownMarketError, getMarket } from "@outlet/markets-config";

/** Catalog locales. ar-EG is the default (Arabic-first). */
export const LOCALES = ["ar-EG", "en-EG"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ar-EG";

export type Direction = "rtl" | "ltr";
export type Numerals = "arab" | "latn";

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function dir(locale: Locale): Direction {
  return locale.startsWith("ar") ? "rtl" : "ltr";
}

export function language(locale: Locale): "ar" | "en" {
  return locale.startsWith("ar") ? "ar" : "en";
}

export interface ResolvedLocale {
  readonly marketId: string;
  readonly locale: Locale;
  readonly dir: Direction;
}

const SEGMENT = /^([a-z]{2})-([a-z]{2})$/;

/**
 * Resolves a `[market]-[locale]` path segment such as `eg-ar` or `eg-en` (BUILD-PROMPT section 5).
 * Returns null for anything unknown: unknown market, a language the market does not offer, wrong case.
 */
export function resolveLocale(pathSegment: string): ResolvedLocale | null {
  const m = SEGMENT.exec(pathSegment);
  if (!m) return null;
  const [, marketId, lang] = m as unknown as [string, string, string];
  let market;
  try {
    market = getMarket(marketId);
  } catch (e) {
    if (e instanceof UnknownMarketError) return null;
    throw e;
  }
  const offered = market.locales.some((l) => l.startsWith(`${lang}-`));
  const locale = `${lang}-${marketId.toUpperCase()}`;
  if (!offered || !isLocale(locale)) return null;
  return { marketId, locale, dir: dir(locale) };
}

/** The path segment for a market and locale, the inverse of resolveLocale. */
export function localeSegment(marketId: string, locale: Locale): string {
  return `${marketId}-${language(locale)}`;
}

/** hreflang value (BCP 47) for a locale, used in alternate links. */
export function hreflang(locale: Locale): string {
  return locale;
}

/** Intl locale tag with an explicit numbering system extension. */
export function intlTag(locale: Locale, numerals: Numerals | undefined): string {
  const nu = numerals ?? (language(locale) === "ar" ? "arab" : "latn");
  return `${locale}-u-nu-${nu}`;
}
