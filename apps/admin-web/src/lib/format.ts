import type { Locale } from "../i18n";

const intl = (locale: Locale): string => (locale === "ar" ? "ar-EG" : "en-EG-u-nu-latn");

/** Parses a wire decimal-string amount of piastres. Returns null for anything that is not an integer string. */
export function parseMinor(value: string): bigint | null {
  return /^-?\d{1,18}$/.test(value) ? BigInt(value) : null;
}

/** Integer piastres to display text. No floats: whole pounds and the 2-digit remainder are formatted separately. */
export function formatMoney(minor: bigint, locale: Locale): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const nf = new Intl.NumberFormat(intl(locale), { useGrouping: true, maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat(intl(locale), { minimumIntegerDigits: 2, useGrouping: false });
  const sep = locale === "ar" ? "٫" : ".";
  const num = nf.format(whole) + (frac === 0n ? "" : sep + nf2.format(Number(frac)));
  const unit = locale === "ar" ? "ج.م" : "EGP";
  const signed = negative ? `‎-${num}` : num;
  return locale === "ar" ? `${signed} ${unit}` : `${unit} ${signed}`;
}

export function formatInt(n: number, locale: Locale): string {
  return new Intl.NumberFormat(intl(locale), { maximumFractionDigits: 0 }).format(n);
}

export function formatDateTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(intl(locale), { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(d);
}

export interface Countdown {
  readonly overdue: boolean;
  /** Absolute whole units, largest first: days when >= 24h, else hours, else minutes. */
  readonly unit: "days" | "hours" | "minutes";
  readonly amount: number;
}

/** Remaining time to a deadline using the SERVER clock passed in (never the device clock). */
export function countdown(dueAtMs: number, serverNowMs: number): Countdown {
  const diff = dueAtMs - serverNowMs;
  const abs = Math.abs(diff);
  const overdue = diff < 0;
  if (abs >= 86_400_000) return { overdue, unit: "days", amount: Math.floor(abs / 86_400_000) };
  if (abs >= 3_600_000) return { overdue, unit: "hours", amount: Math.floor(abs / 3_600_000) };
  return { overdue, unit: "minutes", amount: Math.floor(abs / 60_000) };
}

/** Long date for the dashboard header, Cairo time, from the device clock (display only, never a deadline). */
export function formatLongDate(ms: number, locale: Locale): string {
  const text = new Intl.DateTimeFormat(intl(locale), { dateStyle: "full", timeZone: "Africa/Cairo" }).format(new Date(ms));
  // Arabic: the comma is the Arabic comma and must be followed by a space so it never touches the day digits.
  return locale === "ar" ? text.replace(/،(?=\S)/g, "، ") : text;
}
