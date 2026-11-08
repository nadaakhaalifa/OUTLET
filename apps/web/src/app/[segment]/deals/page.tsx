import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { EmptyState } from "../../../components/EmptyState";
import { SkeletonGrid } from "../../../components/SkeletonGrid";
import { pageMetadata } from "../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";
import { loadDealBands } from "../../../server/loaders";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return pageMetadata(await requireLocale(params), "/deals", "nav.deals");
}

// The discount bands of the reference design; only the labels are fixed, shelf contents come from verified data.
const PLACEHOLDER_BANDS: readonly (readonly [number, number])[] = [
  [70, 60],
  [59, 50],
  [49, 40],
];

export default async function DealsPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const live = await loadDealBands(resolved.marketId);
  const bands = live.length > 0 ? live.map((b) => [b.highPercent, b.lowPercent] as const) : PLACEHOLDER_BANDS;
  return (
    <section aria-labelledby="deals-title">
      <h1 id="deals-title" className="hero">
        {t("nav.deals")}
      </h1>
      {live.length === 0 ? <EmptyState locale={resolved.locale} titleKey="deals.heroTitle" hintKey="shelf.bandHint" /> : null}
      {bands.map(([high, low]) => (
        <section key={high} className="band" aria-label={t("shelf.band", { high, low })}>
          <h2>{t("shelf.band", { high, low })}</h2>
          <p className="hint">{t("shelf.bandHint")}</p>
          <SkeletonGrid locale={resolved.locale} count={4} />
        </section>
      ))}
    </section>
  );
}
