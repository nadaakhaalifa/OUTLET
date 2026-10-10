import { ar } from "./ar";
import { en, type Messages } from "./en";

export type Locale = "ar" | "en";
export type { Messages };

export const defaultLocale: Locale = "ar";
export const resources: Readonly<Record<Locale, Messages>> = { ar, en };

export function isRtl(locale: Locale): boolean {
  return locale === "ar";
}
