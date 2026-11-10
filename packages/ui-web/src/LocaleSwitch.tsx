import { LOCALES, type Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import s from "./LocaleSwitch.module.css";

export interface LocaleSwitchProps {
  readonly locale?: Locale;
  readonly onChange: (next: Locale) => void;
}

const LABEL_KEY = { "ar-EG": "locale.ar", "en-EG": "locale.en" } as const;
const LANG = { "ar-EG": "ar", "en-EG": "en" } as const;

export function LocaleSwitch({ locale, onChange }: LocaleSwitchProps) {
  const { t, locale: current } = useI18n(locale);
  return (
    <div role="group" aria-label={t("locale.label")} className={s.group}>
      {LOCALES.map((l) => (
        <button key={l} type="button" lang={LANG[l]} aria-pressed={l === current} className={s.option} onClick={() => { onChange(l); }}>
          {t(LABEL_KEY[l])}
        </button>
      ))}
    </div>
  );
}
