import { defaultLocale, isRtl, type Locale } from "@outlet/i18n";
import { ar } from "./ar";
import { en, type MessageKey } from "./en";

export type { MessageKey, Locale };
export { isRtl, defaultLocale };

export const LOCALES: readonly Locale[] = ["ar", "en"];
export const catalogs: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { ar, en };

export type Params = Readonly<Record<string, string | number>>;
export type Translator = (key: MessageKey, params?: Params) => string;

export function interpolate(text: string, params: Params | undefined): string {
  if (params === undefined) return text;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

export function createTranslator(locale: Locale): Translator {
  const cat = catalogs[locale];
  return (key, params) => interpolate(cat[key], params);
}

export function isLocale(v: string | undefined): v is Locale {
  return v === "ar" || v === "en";
}

/** Accept-Language header to locale. Arabic unless English is the first listed language. */
export function pickLocale(acceptLanguage: string | null | undefined): Locale {
  return acceptLanguage !== null && acceptLanguage !== undefined && acceptLanguage.trim().toLowerCase().startsWith("en") ? "en" : defaultLocale;
}
