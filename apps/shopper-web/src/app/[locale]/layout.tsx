import type { Metadata } from "next";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "../../components/SiteChrome";
import { createTranslator, isRtl } from "../../i18n";
import { SITE, localeOf } from "../../lib/site";
import { tokensCss } from "../../styles/tokens-css";
import "../globals.css";

// Subresource Integrity for the generated token stylesheet (it is served from /tokens.css, same origin).
const TOKENS_INTEGRITY = `sha384-${createHash("sha384").update(tokensCss()).digest("base64")}`;

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(SITE),
    applicationName: "Z-OUTLET",
    icons: { icon: [] },
    formatDetection: { telephone: false },
  };
}

export const viewport = { width: "device-width", initialScale: 1, colorScheme: "light dark" } as const;

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const locale = localeOf((await params).locale);
  // Reading the nonce header opts the tree into per-request rendering (required for a nonce CSP).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const t = createTranslator(locale);
  return (
    <html lang={locale} dir={isRtl(locale) ? "rtl" : "ltr"}>
      <head>
        <link rel="stylesheet" href="/tokens.css" integrity={TOKENS_INTEGRITY} crossOrigin="anonymous" nonce={nonce} />
      </head>
      <body>
        <a className="skip" href="#main">{t("common.skipToContent")}</a>
        <SiteHeader locale={locale} />
        <main id="main" tabIndex={-1}>
          <div className="wrap">{children}</div>
        </main>
        <SiteFooter locale={locale} />
      </body>
    </html>
  );
}
