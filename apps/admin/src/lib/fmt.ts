import { formatMoney, intlTag, type Locale } from "@outlet/i18n";
import { CURRENCIES, money, type Currency } from "@outlet/money";

const isCurrency = (c: string): c is Currency => (CURRENCIES as readonly string[]).includes(c);

/** Date and time in Africa/Cairo. Falls back to the raw text for an unparseable value (never throws in render). */
export function fmtDateTime(iso: string | null | undefined, locale: Locale): string {
  if (iso === null || iso === undefined) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(intlTag(locale, undefined), { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(d);
}

export function fmtDate(iso: string | null | undefined, locale: Locale): string {
  if (iso === null || iso === undefined) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(intlTag(locale, undefined), { dateStyle: "medium", timeZone: "Africa/Cairo" }).format(d);
}

export function fmtNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(intlTag(locale, undefined)).format(n);
}

export function fmtMoney(m: { amount_minor: string; currency: string } | null | undefined, locale: Locale): string {
  if (m === null || m === undefined) return "";
  try {
    if (!isCurrency(m.currency)) return `${m.amount_minor} ${m.currency}`;
    return formatMoney(money(BigInt(m.amount_minor), m.currency), locale);
  } catch {
    return `${m.amount_minor} ${m.currency}`;
  }
}

/** Whole hours from `now` until `due` (negative once past). Truncates toward zero. */
export function hoursUntil(due: string, now: Date): number {
  return Math.trunc((Date.parse(due) - now.getTime()) / 3_600_000);
}
