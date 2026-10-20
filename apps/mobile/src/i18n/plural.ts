/** CLDR plural rules for the app's hand-picked plural keys (`base` + One | Two | Few | Many | Other). */

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralForm = "One" | "Two" | "Few" | "Many" | "Other";

/** CLDR Arabic: 0 zero, 1 one, 2 two, n%100 in 3..10 few, n%100 in 11..99 many, otherwise other (100, 101, 102, 200...). */
export function arabicPluralCategory(n: number): PluralCategory {
  if (!Number.isFinite(n)) return "other";
  const i = Math.abs(Math.trunc(n));
  if (i === 0) return "zero";
  if (i === 1) return "one";
  if (i === 2) return "two";
  const m = i % 100;
  if (m >= 3 && m <= 10) return "few";
  if (m >= 11) return "many";
  return "other";
}

/**
 * Key suffix for a count. Zero is never shown as a count (callers use a dedicated "none" string), but must not crash:
 * it maps to Other. English catalogs carry the same five keys (One for 1, the same text for the rest).
 */
export function pluralForm(n: number): PluralForm {
  switch (arabicPluralCategory(n)) {
    case "one": return "One";
    case "two": return "Two";
    case "few": return "Few";
    case "many": return "Many";
    default: return "Other";
  }
}

/** `base` + plural suffix, e.g. pluralKey("shopAll.productCount", 3) = "shopAll.productCountFew". */
export function pluralKey(base: string, n: number): string {
  return `${base}${pluralForm(n)}`;
}
