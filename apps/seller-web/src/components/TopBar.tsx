import { headers } from "next/headers";
import { switchLocaleAction } from "../app/actions-onboarding";
import { createTranslator, type Locale } from "../i18n";
import { Wordmark } from "./Identity";

/** Glass top bar for pre-store pages: wordmark, language switch. Content scrolls beneath it. */
export async function TopBar({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  const other = locale === "ar" ? "en" : "ar";
  const path = (await headers()).get("x-pathname") ?? "/start";
  return (
    <header className="zm-bar">
      <span className="zm-wordmark"><Wordmark height={18} /><span className="vh">{t("app.name")}</span></span>
      <form action={switchLocaleAction}>
        <input type="hidden" name="locale" value={other} />
        <input type="hidden" name="path" value={path} />
        <button type="submit" className="zm-btn quiet" lang={other}>{t("common.language")}</button>
      </form>
    </header>
  );
}
