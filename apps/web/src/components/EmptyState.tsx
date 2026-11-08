import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";

export function EmptyState({ locale, titleKey = "state.empty", hintKey }: { locale: Locale; titleKey?: MessageKey; hintKey?: MessageKey }) {
  const t = createTranslator(locale);
  return (
    <div className="empty" role="status">
      <p>{t(titleKey)}</p>
      {hintKey ? <p className="hint">{t(hintKey)}</p> : null}
    </div>
  );
}
