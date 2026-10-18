import type { Locale } from "../i18n";

/** Arabic is authoritative. A missing English value falls back to Arabic and is never machine-translated. */
export function pick(text: { readonly ar: string; readonly en?: string | undefined }, locale: Locale): string {
  if (locale === "en" && text.en !== undefined && text.en.trim() !== "") return text.en;
  return text.ar;
}
