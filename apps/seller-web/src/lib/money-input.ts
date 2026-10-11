import type { Locale } from "../i18n";

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";

/** Normalises Arabic-Indic digits and the Arabic decimal separator to ASCII. */
export function normaliseDigits(input: string): string {
  return input
    .trim()
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[٫,]/g, ".");
}

/** "125.5" (EGP) to integer piastres as a string. Null when empty, malformed, zero or negative. No floats. */
export function parseEgpToMinor(input: string): string | null {
  const s = normaliseDigits(input);
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (m === null) return null;
  const whole = BigInt(m[1] ?? "0");
  const frac = BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  const minor = whole * 100n + frac;
  return minor > 0n ? minor.toString() : null;
}

/** ROAS arrives in basis points of 1.0x (10000 = 1.00x). Integer math, two decimals. */
export function formatRatioBps(bps: bigint, locale: Locale): string {
  const hundredths = bps / 100n;
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, "0");
  const sep = locale === "ar" ? "٫" : ".";
  const text = `${whole.toString()}${sep}${frac}×`;
  return locale === "ar" ? text.replace(/\d/g, (d) => ARABIC_INDIC.charAt(Number(d))) : text;
}
