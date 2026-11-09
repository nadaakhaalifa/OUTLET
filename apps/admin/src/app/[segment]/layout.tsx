import "@outlet/ui-tokens/tokens.css";
import "../globals.css";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { createTranslator, language } from "@outlet/i18n";
import { plexArabic, plexLatin } from "../fonts";
import { SkipLink } from "../../components/shell/SkipLink";
import { requireLocale, type SegmentParams } from "../../lib/segment-page";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  return { title: { default: t("admin.title"), template: `%s · ${t("admin.meta.suffix")}` }, robots: { index: false, follow: false } };
}

export default async function SegmentLayout({ children, params }: { children: ReactNode; params: SegmentParams }) {
  const resolved = await requireLocale(params);
  // Reading request headers opts the tree into dynamic rendering, which the per-request CSP nonce requires.
  await headers();
  const t = createTranslator(resolved.locale);
  return (
    <html lang={language(resolved.locale)} dir={resolved.dir} className={`${plexArabic.variable} ${plexLatin.variable}`}>
      <body>
        <SkipLink label={t("admin.skip")} />
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
