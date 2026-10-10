import { formatPiastres } from "./format";

export type DisplayLocale = "ar" | "en";

const EASTERN = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"] as const;

/** Digits in the locale's numeral system. Arabic uses Eastern Arabic-Indic digits (spec §25). */
export function localizeDigits(ascii: string, locale: DisplayLocale): string {
  if (locale !== "ar") return ascii;
  return ascii.replace(/[0-9]/g, (d) => EASTERN[Number(d)] ?? d).replace(/,/g, "٬").replace(/\./g, "٫");
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Integer piastres to a display amount such as "1,250" or "1,250.50" (EGP is never a float here).
 * The currency label comes from i18n (`common.currency`) and is appended by the caller's template.
 */
export function formatAmount(minor: bigint, locale: DisplayLocale): string {
  const [whole = "0", frac = "00"] = formatPiastres(minor).split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const body = frac === "00" ? group(digits) : `${group(digits)}.${frac}`;
  return localizeDigits(`${negative ? "-" : ""}${body}`, locale);
}

/** Amount plus currency label, with the label last in both languages. */
export function formatMoney(minor: bigint, locale: DisplayLocale, currencyLabel: string): string {
  return `${formatAmount(minor, locale)} ${currencyLabel}`;
}
