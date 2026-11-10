import type { Metadata } from "next";
import { createTranslator, type MessageKey, type ResolvedLocale } from "@outlet/i18n";
import { readEnv } from "../server/env";
import { alternateLinks } from "./segment";

export function pageMetadata(resolved: ResolvedLocale, path: string, titleKey: MessageKey): Metadata {
  const t = createTranslator(resolved.locale);
  const { canonical, languages } = alternateLinks(resolved, path);
  return {
    metadataBase: new URL(readEnv().SITE_URL),
    title: `${t(titleKey)} | ${t("brand.name")}`,
    alternates: { canonical, languages: { ...languages } },
    openGraph: { locale: resolved.locale.replace("-", "_"), siteName: t("brand.name") },
  };
}
