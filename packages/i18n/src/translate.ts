import { IntlMessageFormat } from "intl-messageformat";
import { CATALOGS, type MessageKey } from "./catalog.js";
import { intlTag, type Locale, type Numerals } from "./locale.js";

export type MessageValues = Readonly<Record<string, string | number | bigint | boolean | Date>>;
export type Translator = (key: MessageKey, values?: MessageValues) => string;

const cache = new Map<string, IntlMessageFormat>();

/** `t` for a locale. Formatters are cached per locale, numeral system and key. */
export function createTranslator(locale: Locale, opts: { numerals?: Numerals } = {}): Translator {
  const tag = intlTag(locale, opts.numerals);
  return (key, values) => {
    const cacheKey = `${tag}|${key}`;
    let fmt = cache.get(cacheKey);
    if (!fmt) {
      fmt = new IntlMessageFormat(CATALOGS[locale][key], tag);
      cache.set(cacheKey, fmt);
    }
    const out = fmt.format(values);
    return Array.isArray(out) ? out.join("") : String(out);
  };
}

/** One-shot form: t("ar-EG", "nav.explore"). */
export function t(locale: Locale, key: MessageKey, values?: MessageValues, opts: { numerals?: Numerals } = {}): string {
  return createTranslator(locale, opts)(key, values);
}
