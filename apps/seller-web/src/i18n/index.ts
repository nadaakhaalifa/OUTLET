import { defaultLocale, isRtl, type Locale } from "@outlet/i18n";
import { ar } from "./ar";
import { en, type MessageKey } from "./en";

export type { MessageKey, Locale };
export { isRtl, defaultLocale };

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

/** Accept-Language / cookie value to locale. Arabic unless English is explicitly chosen. */
export function pickLocale(value: string | null | undefined): Locale {
  return value !== null && value !== undefined && value.toLowerCase().startsWith("en") ? "en" : defaultLocale;
}
