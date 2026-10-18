import { ar } from "./ar";
import { en, type Messages } from "./en";

export { PRODUCT_NAME, DEFAULT_INTERPOLATION } from "./product";
export { localizedName, isEnglishNameMissing, type LocalizedName } from "./localized-name";

export type Locale = "ar" | "en";
export type { Messages };

export const defaultLocale: Locale = "ar";
export const resources: Readonly<Record<Locale, Messages>> = { ar, en };

export function isRtl(locale: Locale): boolean {
  return locale === "ar";
}

/** Maps a device language code to a supported locale. Arabic is the default (spec §1). */
export function resolveLocale(languageCode: string | null | undefined): Locale {
  return languageCode === "en" ? "en" : defaultLocale;
}
