import type { Locale } from "../i18n";

const intl = (locale: Locale): string => (locale === "ar" ? "ar-EG" : "en-EG-u-nu-latn");

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

/** Basis points to a percent string with at most one decimal, integer math only. */
export function formatBps(bps: number, locale: Locale): string {
  const tenths = Math.round(bps / 10);
  const whole = Math.trunc(tenths / 10);
  const dec = Math.abs(tenths % 10);
  const nf = new Intl.NumberFormat(intl(locale), { maximumFractionDigits: 0 });
  const sep = locale === "ar" ? "٫" : ".";
  const pct = locale === "ar" ? "٪" : "%";
  return `${nf.format(whole)}${dec === 0 ? "" : sep + nf.format(dec)}${pct}`;
}

export function formatDateTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(intl(locale), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  }).format(d);
}

export function formatDate(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(intl(locale), { dateStyle: "medium", timeZone: "Africa/Cairo" }).format(d);
}
