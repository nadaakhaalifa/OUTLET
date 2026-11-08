import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { EmptyState } from "../../../components/EmptyState";
import { DiscountBandShelf } from "../../../components/ui";
import { pageMetadata } from "../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";
import { loadDealBands } from "../../../server/loaders";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return pageMetadata(await requireLocale(params), "/deals", "nav.deals");
}

/**
 * Bands come only from the API (verified Price Watch evidence). apps/api serves no deals route yet, so the list is
 * empty and the page says so; there are no hard-coded bands and no plain-price shelf without a products source.
 */
export default async function DealsPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const bands = await loadDealBands(resolved.marketId);
  return (
    <section aria-labelledby="deals-title">
      <h1 id="deals-title" className="hero">
        {t("deals.heroTitle")}
      </h1>
      {bands.length === 0 ? (
        <EmptyState locale={resolved.locale} titleKey="deals.noVerified" hintKey="deals.noVerifiedHint" />
      ) : (
        bands.map((b) => <DiscountBandShelf key={b.highPercent} band={{ highPercent: b.highPercent, lowPercent: b.lowPercent, verified: true }} items={[]} locale={resolved.locale} />)
      )}
    </section>
  );
}
