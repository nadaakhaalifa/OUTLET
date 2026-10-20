import type { Locale } from "../i18n";

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Letters (Latin and Arabic), digits and single hyphens. Arabic slugs are percent-encoded by the URL layer. */
export function slugify(text: string): string {
  const s = text
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s;
}

/** `{slug}-{uuid}`: the id suffix is the stable key, the slug is cosmetic and canonicalised by redirect. */
export function entitySegment(id: string, ...names: readonly (string | undefined)[]): string {
  const name = names.find((n) => n !== undefined && slugify(n) !== "");
  const slug = name === undefined ? "" : slugify(name);
  return slug === "" ? id.toLowerCase() : `${slug}-${id.toLowerCase()}`;
}

/** Products are keyed by id alone: /v1/public/sitemap/products carries no title, so the canonical must not need one. */
export const productSegment = (id: string): string => id.toLowerCase();

export function idFromSegment(segment: string): string | null {
  const decoded = safeDecode(segment);
  const m = UUID_TAIL.exec(decoded);
  return m?.[1] === undefined ? null : m[1].toLowerCase();
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const HREFLANG: Readonly<Record<Locale, string>> = { ar: "ar-EG", en: "en" };

/** Absolute URL of a locale-prefixed path. `path` starts with "/" or is "" for the locale root. */
export function absoluteUrl(site: string, locale: Locale, path: string): string {
  const encoded = path
    .split("/")
    .map((seg) => (seg === "" ? seg : encodeURIComponent(safeDecode(seg))))
    .join("/");
  return `${site}/${locale}${encoded}`;
}

export interface Alternates {
  readonly canonical: string;
  readonly languages: Readonly<Record<string, string>>;
}

/** Canonical + hreflang alternates (ar-EG, en, x-default = Arabic). Self-consistent by construction. */
export function alternatesFor(site: string, locale: Locale, path: string): Alternates {
  return {
    canonical: absoluteUrl(site, locale, path),
    languages: {
      "ar-EG": absoluteUrl(site, "ar", path),
      en: absoluteUrl(site, "en", path),
      "x-default": absoluteUrl(site, "ar", path),
    },
  };
}

export const otherLocale = (l: Locale): Locale => (l === "ar" ? "en" : "ar");
