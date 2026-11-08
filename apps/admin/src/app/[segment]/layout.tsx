import "@outlet/ui-tokens/tokens.css";
import "../globals.css";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { createTranslator, language } from "@outlet/i18n";
import { plexArabic, plexLatin } from "../fonts";
import { requireLocale, type SegmentParams } from "../../lib/segment-page";

export const metadata = { robots: { index: false, follow: false } };

export default async function SegmentLayout({ children, params }: { children: ReactNode; params: SegmentParams }) {
  const resolved = await requireLocale(params);
  // Reading request headers opts the tree into dynamic rendering, which the per-request CSP nonce requires.
  await headers();
  const t = createTranslator(resolved.locale);
  return (
    <html lang={language(resolved.locale)} dir={resolved.dir} className={`${plexArabic.variable} ${plexLatin.variable}`}>
      <body>
        <a className="skip" href="#content">{t("admin.skip")}</a>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
