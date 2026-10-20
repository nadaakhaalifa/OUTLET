"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { createTranslator, type Locale } from "../i18n";

function Inner({ locale }: { locale: Locale }) {
  const path = usePathname() ?? `/${locale}`;
  const qs = useSearchParams()?.toString() ?? "";
  const other: Locale = locale === "ar" ? "en" : "ar";
  const rest = path.replace(/^\/(ar|en)(?=\/|$)/, "");
  const t = createTranslator(locale);
  return (
    <Link href={`/${other}${rest}${qs === "" ? "" : `?${qs}`}`} hrefLang={other === "ar" ? "ar-EG" : "en"} lang={other} aria-label={t("common.switchLanguageLabel")} prefetch={false}>
      {t("common.language")}
    </Link>
  );
}

/** Language switch keeps the current page and query. Wrapped in Suspense so pages stay statically renderable. */
export function LocaleSwitch({ locale }: { locale: Locale }) {
  const other: Locale = locale === "ar" ? "en" : "ar";
  const t = createTranslator(locale);
  return (
    <Suspense fallback={<a href={`/${other}`} hrefLang={other === "ar" ? "ar-EG" : "en"} lang={other} aria-label={t("common.switchLanguageLabel")}>{t("common.language")}</a>}>
      <Inner locale={locale} />
    </Suspense>
  );
}
