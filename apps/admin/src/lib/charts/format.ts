/**
 * Number, percent, money and delta formatting for the chart kit. Money is EGP in integer minor
 * units (piastres): never floats on the wire, never another currency. Digits follow the locale's
 * Intl tag from @outlet/i18n (Arabic-Indic in ar-EG).
 */
import { formatMoney, intlTag, type Locale } from "@outlet/i18n";
import { money } from "@outlet/money";

export interface FormatSpec {
  readonly kind: "number" | "compact" | "percent" | "money" | "moneyCompact";
  readonly locale: Locale;
}

/** The unit label for money axes and captions: "ج.م" in Arabic, "EGP" in English. */
export const EGP_UNIT: Readonly<Record<Locale, string>> = { "ar-EG": "ج.م", "en-EG": "EGP" };

export function formatWith(spec: FormatSpec, value: number): string {
  const tag = intlTag(spec.locale, undefined);
  switch (spec.kind) {
    case "compact":
      return new Intl.NumberFormat(tag, { notation: "compact", maximumFractionDigits: 1 }).format(value);
    case "percent":
      return new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 1 }).format(value);
    case "money":
      // value is piastres; round to an integer before BigInt so a float never reaches the money type.
      return formatMoney(money(BigInt(Math.round(value)), "EGP"), spec.locale);
    case "moneyCompact":
      return `${new Intl.NumberFormat(tag, { notation: "compact", maximumFractionDigits: 1 }).format(value / 100)} ${EGP_UNIT[spec.locale]}`;
    default:
      return new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(value);
  }
}

export type DeltaTone = "up" | "down" | "flat" | "none";
export interface DeltaValue {
  /** (current - previous) / |previous|; null when there is no usable comparison. */
  readonly ratio: number | null;
  readonly tone: DeltaTone;
}

/** A previous value of 0 or missing has no meaningful percentage: tone "none", never "+inf%". */
export function deltaOf(current: number | null, previous: number | null): DeltaValue {
  if (current === null || previous === null || previous === 0) return { ratio: null, tone: "none" };
  const ratio = (current - previous) / Math.abs(previous);
  if (Math.abs(ratio) < 0.0005) return { ratio: 0, tone: "flat" };
  return { ratio, tone: ratio > 0 ? "up" : "down" };
}

export function deltaText(delta: DeltaValue, locale: Locale): string | null {
  if (delta.ratio === null) return null;
  return new Intl.NumberFormat(intlTag(locale, undefined), { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(delta.ratio);
}
