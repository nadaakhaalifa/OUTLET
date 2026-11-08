import { CURRENCY_MINOR_UNITS, type Currency, type Money } from "@outlet/money";
import { intlTag, language, type Locale, type Numerals } from "./locale.js";

const SYMBOL: Readonly<Record<"ar" | "en", Readonly<Record<Currency, string>>>> = {
  ar: { EGP: "ج.م", SAR: "ر.س", AED: "د.إ", USD: "$" },
  en: { EGP: "EGP", SAR: "SAR", AED: "AED", USD: "USD" },
};

/** Exact decimal string for a minor-unit bigint. No Number conversion anywhere. */
export function minorToDecimalString(amountMinor: bigint, minorUnits: number): string {
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(minorUnits + 1, "0");
  const whole = digits.slice(0, digits.length - minorUnits);
  const frac = minorUnits === 0 ? "" : `.${digits.slice(digits.length - minorUnits)}`;
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/**
 * Formats Money for display: `١٬٢٠٠ ج.م` (ar, arab numerals) or `EGP 1,200` (en).
 * Whole amounts drop the decimals. Safe above 2^53: Intl formats the exact decimal string.
 */
export function formatMoney(value: Money, locale: Locale, opts: { numerals?: Numerals } = {}): string {
  const units = CURRENCY_MINOR_UNITS[value.currency];
  const decimal = minorToDecimalString(value.amountMinor, units);
  const whole = value.amountMinor % 10n ** BigInt(units) === 0n;
  const nf = new Intl.NumberFormat(intlTag(locale, opts.numerals), {
    minimumFractionDigits: whole ? 0 : units,
    maximumFractionDigits: units,
    useGrouping: true,
  });
  const num = nf.format(decimal as `${number}`);
  const lang = language(locale);
  const symbol = SYMBOL[lang][value.currency];
  return lang === "ar" ? `${num} ${symbol}` : `${symbol} ${num}`;
}

export type DateStyle = "short" | "medium" | "long";

export interface FormatDateOptions {
  readonly style?: DateStyle;
  /** Use the Umm al-Qura Hijri calendar (campaign dates such as Ramadan and Eid). */
  readonly hijri?: boolean;
  readonly numerals?: Numerals;
  readonly timeZone?: string;
}

/** Date in Africa/Cairo by default; optional Hijri calendar. */
export function formatDate(date: Date, locale: Locale, opts: FormatDateOptions = {}): string {
  const tag = `${intlTag(locale, opts.numerals)}${opts.hijri ? "-ca-islamic-umalqura" : ""}`;
  return new Intl.DateTimeFormat(tag, {
    dateStyle: opts.style ?? "medium",
    timeZone: opts.timeZone ?? "Africa/Cairo",
  }).format(date);
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

/** "منذ ٣ ساعات" / "3 hours ago" relative to `now`. */
export function formatRelative(date: Date, now: Date, locale: Locale, opts: { numerals?: Numerals } = {}): string {
  const seconds = (date.getTime() - now.getTime()) / 1000;
  const abs = Math.abs(seconds);
  const [unit, size] = UNITS.find(([, s]) => abs >= s) ?? UNITS[UNITS.length - 1] ?? ["second", 1];
  const rtf = new Intl.RelativeTimeFormat(intlTag(locale, opts.numerals), { numeric: "auto" });
  return rtf.format(Math.trunc(seconds / size), unit);
}
