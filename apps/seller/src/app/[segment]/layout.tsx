import "@outlet/ui-tokens/tokens.css";
import "../globals.css";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { createTranslator, language, localeSegment } from "@outlet/i18n";
import { plexArabic, plexLatin } from "../fonts";
import { SaveIndicator, SaveStatusProvider } from "../../components/SaveStatus";
import { StoreSwitcher } from "../../components/StoreSwitcher";
import { requireLocale, type SegmentParams } from "../../lib/segment-page";
import { STORES_COOKIE, STORE_COOKIE } from "../../server/env";

export default async function SegmentLayout({ children, params }: { children: ReactNode; params: SegmentParams }) {
  const resolved = await requireLocale(params);
  // Reading request headers opts the tree into dynamic rendering, which the per-request CSP nonce requires.
  await headers();
  const jar = await cookies();
  const t = createTranslator(resolved.locale);
  const stores = (jar.get(STORES_COOKIE)?.value ?? "").split(",").filter((s) => /^[0-9a-f-]{36}$/.test(s));
  const active = jar.get(STORE_COOKIE)?.value ?? stores[0] ?? "";
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  return (
    <html lang={language(resolved.locale)} dir={resolved.dir} className={`${plexArabic.variable} ${plexLatin.variable}`}>
      <body>
        <a className="skip" href="#content">
          {t("seller.skip")}
        </a>
        <SaveStatusProvider>
          <div className="shell">
            <header className="topbar">
              <a className="brand" href={base}>
                {t("seller.title")}
              </a>
              <StoreSwitcher locale={resolved.locale} stores={stores} active={active} />
              <SaveIndicator locale={resolved.locale} />
              <a className="helpLink" href={`${base}/help`}>
                {t("seller.topbar.help")}
              </a>
            </header>
            <div className="shellBody">{children}</div>
          </div>
        </SaveStatusProvider>
      </body>
    </html>
  );
}
