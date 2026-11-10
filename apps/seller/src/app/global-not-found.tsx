import "@outlet/ui-tokens/tokens.css";
import "./globals.css";
import { DEFAULT_LOCALE, createTranslator, dir, language } from "@outlet/i18n";

export default function GlobalNotFound() {
  const t = createTranslator(DEFAULT_LOCALE);
  return (
    <html lang={language(DEFAULT_LOCALE)} dir={dir(DEFAULT_LOCALE)}>
      <body>
        <main className="page">
          <h1 className="hero">{t("error.notFound")}</h1>
        </main>
      </body>
    </html>
  );
}
