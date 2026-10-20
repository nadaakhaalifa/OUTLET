import { setLocaleAction, setThemeAction, signOutAction } from "../server/actions";
import type { Translator } from "../i18n";
import type { Locale } from "../i18n";
import { THEME_CHOICES, type ThemeChoice } from "../lib/theme";

/** Language, theme (Light/Dark/System) and sign-out. Plain server-action forms: they work with JS off. */
export function ShellControls({ t, locale, theme, back }: { t: Translator; locale: Locale; theme: ThemeChoice; back: string }) {
  const other = locale === "ar" ? "en" : "ar";
  return (
    <>
      <form action={setThemeAction} className="theme-toggle">
        <span className="theme-group" role="group" aria-label={t("shell.theme")}>
        <input type="hidden" name="back" value={back} />
        {THEME_CHOICES.map((c) => (
          <button key={c} className="btn ghost" type="submit" name="theme" value={c} aria-pressed={c === theme}>{t(`shell.theme.${c}`)}</button>
        ))}
        </span>
      </form>
      <form action={setLocaleAction}>
        <input type="hidden" name="locale" value={other} />
        <input type="hidden" name="back" value={back} />
        <button className="btn ghost" type="submit">{t("common.language")}</button>
      </form>
      <form action={signOutAction}><button className="btn ghost" type="submit">{t("common.signOut")}</button></form>
    </>
  );
}
