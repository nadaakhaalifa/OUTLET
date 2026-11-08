import type { MetadataRoute } from "next";
import { listMarkets } from "@outlet/markets-config";
import { language, resolveLocale } from "@outlet/i18n";
import { alternateLinks } from "../lib/segment";
import { readEnv } from "../server/env";

/** Index of the market-locale roots only. Sharded sitemaps for stores and products arrive with the catalogue. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = readEnv().SITE_URL;
  const entries: MetadataRoute.Sitemap = [];
  for (const market of listMarkets()) {
    for (const loc of market.locales) {
      const resolved = resolveLocale(`${market.id}-${language(loc.startsWith("ar") ? "ar-EG" : "en-EG")}`);
      if (resolved === null) continue;
      const { canonical, languages } = alternateLinks(resolved, "");
      entries.push({
        url: `${origin}${canonical}`,
        alternates: { languages: Object.fromEntries(Object.entries(languages).map(([k, v]) => [k, `${origin}${v}`])) },
      });
    }
  }
  return entries;
}
