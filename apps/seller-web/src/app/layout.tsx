import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { OfflineBanner } from "../components/OfflineBanner";
import { Shell } from "../components/Shell";
import { TopBar } from "../components/TopBar";
import { createTranslator, isRtl } from "../i18n";
import { isBarePath } from "../lib/paths";
import { getContext } from "../server-context";
import { tokensCss } from "../styles/tokens-css";
import "./globals.css";
import "./onboarding.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getContext();
  return { title: t("app.name"), robots: { index: false, follow: false } };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale } = await getContext();
  const h = await headers();
  const nonce = h.get("x-nonce") ?? undefined;
  const bare = isBarePath(h.get("x-pathname") ?? "");
  const t = createTranslator(locale);
  return (
    <html lang={locale} dir={isRtl(locale) ? "rtl" : "ltr"}>
      <head>
        <style nonce={nonce}>{tokensCss()}</style>
      </head>
      <body>
        <a className="skip" href="#main">{t("common.skipToContent")}</a>
        <OfflineBanner locale={locale} />
        {bare ? (
          <div className="zm-page">
            <TopBar locale={locale} />
            <main id="main" className="zm-main" tabIndex={-1}>{children}</main>
          </div>
        ) : (
          <Shell locale={locale}>{children}</Shell>
        )}
      </body>
    </html>
  );
}
