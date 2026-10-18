import Link from "next/link";
import { createTranslator, type Locale } from "../i18n";
import { Wordmark } from "./Identity";
import { LocaleSwitch } from "./LocaleSwitch";

export function SiteHeader({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  return (
    <header className="site-header">
      <div className="wrap">
        <Link className="brand" href={`/${locale}`} aria-label={t("app.name")}><Wordmark height={20} /></Link>
        <nav className="nav" aria-label={t("common.mainNav")}>
          <Link href={`/${locale}/drops`}>{t("nav.drops")}</Link>
          <Link href={`/${locale}/search`}>{t("nav.search")}</Link>
          <LocaleSwitch locale={locale} />
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  return (
    <footer className="site-footer">
      <div className="wrap">
        <nav aria-label={t("common.footerNav")}>
          <ul>
            <li><Link href={`/${locale}/drops`}>{t("nav.drops")}</Link></li>
            <li><Link href={`/${locale}/search`}>{t("nav.search")}</Link></li>
          </ul>
        </nav>
        <p>{t("footer.copy")}</p>
        <p>{t("footer.consent")}</p>
      </div>
    </footer>
  );
}
