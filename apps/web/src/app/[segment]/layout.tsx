import "@outlet/ui-tokens/tokens.css";
import "../globals.css";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { language, localeSegment, type MessageKey } from "@outlet/i18n";
import { createTranslator } from "@outlet/i18n";
import { plexArabic, plexLatin } from "../fonts";
import { JsonLd } from "../../components/JsonLd";
import { SiteHeader } from "../../components/SiteHeader";
import { themeSchema } from "../../lib/params";
import { requireLocale, type SegmentParams } from "../../lib/segment-page";
import { readEnv } from "../../server/env";

export default async function SegmentLayout({ children, params }: { children: ReactNode; params: SegmentParams }) {
  const resolved = await requireLocale(params);
  // Reading request headers opts the tree into dynamic rendering, which the per-request CSP nonce requires.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const themeParse = themeSchema.safeParse((await cookies()).get("theme")?.value);
  const t = createTranslator(resolved.locale);
  const origin = readEnv().SITE_URL;
  const base = `${origin}/${localeSegment(resolved.marketId, resolved.locale)}`;
  const searchLabel: MessageKey = "search.label";

  return (
    <html
      lang={language(resolved.locale)}
      dir={resolved.dir}
      className={`${plexArabic.variable} ${plexLatin.variable}`}
      {...(themeParse.success ? { "data-theme": themeParse.data } : {})}
    >
      <body>
        <SiteHeader resolved={resolved} />
        <main className="page">{children}</main>
        <JsonLd nonce={nonce} data={{ "@context": "https://schema.org", "@type": "Organization", name: t("brand.name"), url: origin }} />
        <JsonLd
          nonce={nonce}
          data={{
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: t("brand.name"),
            url: base,
            inLanguage: resolved.locale,
            potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${base}?q={search_term_string}` }, "query-input": `required name=search_term_string`, name: t(searchLabel) },
          }}
        />
      </body>
    </html>
  );
}
