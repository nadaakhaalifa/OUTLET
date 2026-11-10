import type { Metadata } from "next";
import { createTranslator, localeSegment } from "@outlet/i18n";
import { EmptyState } from "../../../components/EmptyState";
import { DiscountBandShelf } from "../../../components/ui";
import { pageMetadata } from "../../../lib/metadata";
import { toCubby } from "../../../lib/present";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";
import { loadDealShelves } from "../../../server/loaders";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return pageMetadata(await requireLocale(params), "/deals", "nav.deals");
}

/**
 * Bands and items come only from the API (verified Price Watch evidence, stores in `public` mode). A band with no items
 * is not rendered at all; when every band is empty the page says so. No % is ever computed here.
 */
export default async function DealsPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const shelves = await loadDealShelves(resolved.marketId);
  return (
    <section aria-labelledby="deals-title">
      <h1 id="deals-title" className="hero">
        {t("deals.heroTitle")}
      </h1>
      {shelves.length === 0 ? (
        <EmptyState locale={resolved.locale} titleKey="deals.noVerified" hintKey="deals.noVerifiedHint" />
      ) : (
        shelves.map(({ band, items }) => (
          <DiscountBandShelf
            key={band.code}
            band={{ highPercent: band.highPercent, lowPercent: band.lowPercent, verified: true }}
            items={items.flatMap((p) => {
              // The deals route only serves stores in `public` mode, so evidence may render.
              const c = toCubby(p, resolved.locale, { discountDisplayMode: "public" }, `${base}/stores/${p.storeSlug}`);
              return c === null ? [] : [{ ...c, href: `${base}/p/${p.id}` }];
            })}
            locale={resolved.locale}
          />
        ))
      )}
    </section>
  );
}
