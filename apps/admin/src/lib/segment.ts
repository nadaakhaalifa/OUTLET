import { LOCALES, hreflang, language, localeSegment, resolveLocale, type ResolvedLocale } from "@outlet/i18n";

export const DEFAULT_SEGMENT = "eg-ar";

/** Validates the `[market]-[locale]` path segment. null means 404. */
export function parseSegment(segment: string): ResolvedLocale | null {
  return resolveLocale(segment);
}

export interface AlternateLinks {
  readonly canonical: string;
  readonly languages: Readonly<Record<string, string>>;
}

/** Canonical and hreflang alternates for a path inside a market (`path` starts with "/" or is ""). */
export function alternateLinks(resolved: ResolvedLocale, path: string): AlternateLinks {
  const languages: Record<string, string> = {};
  for (const locale of LOCALES) {
    if (resolveLocale(`${resolved.marketId}-${language(locale)}`) === null) continue;
    languages[hreflang(locale)] = `/${localeSegment(resolved.marketId, locale)}${path}`;
  }
  const arSegment = `${resolved.marketId}-ar`;
  languages["x-default"] = `/${resolveLocale(arSegment) ? arSegment : resolved.marketId + "-" + language(resolved.locale)}${path}`;
  return { canonical: `/${localeSegment(resolved.marketId, resolved.locale)}${path}`, languages };
}
