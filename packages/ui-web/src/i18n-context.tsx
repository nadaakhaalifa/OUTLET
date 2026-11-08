import { DEFAULT_LOCALE, createTranslator, dir, type Direction, type Locale, type Numerals, type Translator } from "@outlet/i18n";
import { createContext, useContext, useMemo, type ReactNode } from "react";

interface I18nState {
  readonly locale: Locale;
  readonly numerals?: Numerals;
}
const Ctx = createContext<I18nState>({ locale: DEFAULT_LOCALE });

/** Sets locale (and optional numeral system) for every component below; also sets lang/dir on a wrapper. */
export function LocaleProvider(props: { locale: Locale; numerals?: Numerals; children: ReactNode }) {
  const { locale, numerals, children } = props;
  const value = useMemo<I18nState>(() => (numerals ? { locale, numerals } : { locale }), [locale, numerals]);
  return (
    <Ctx.Provider value={value}>
      <div lang={locale} dir={dir(locale)} style={{ display: "contents" }}>
        {children}
      </div>
    </Ctx.Provider>
  );
}

export interface UseI18n {
  readonly locale: Locale;
  readonly numerals: Numerals | undefined;
  readonly dir: Direction;
  readonly t: Translator;
}

/** Component locale: explicit prop wins, else the provider, else ar-EG. */
export function useI18n(localeProp?: Locale): UseI18n {
  const ctx = useContext(Ctx);
  const locale = localeProp ?? ctx.locale;
  const numerals = ctx.numerals;
  const t = useMemo(() => createTranslator(locale, numerals ? { numerals } : {}), [locale, numerals]);
  return { locale, numerals, dir: dir(locale), t };
}
