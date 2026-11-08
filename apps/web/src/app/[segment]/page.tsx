import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { EmptyState } from "../../components/EmptyState";
import { SkeletonGrid } from "../../components/SkeletonGrid";
import { pageMetadata } from "../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../lib/segment-page";
import { loadStores } from "../../server/loaders";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return pageMetadata(await requireLocale(params), "", "nav.explore");
}

export default async function ExplorePage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const stores = await loadStores(resolved.marketId);
  return (
    <section aria-labelledby="explore-title">
      <h1 id="explore-title" className="hero">
        {t("nav.explore")}
      </h1>
      {stores.length === 0 ? (
        <>
          <EmptyState locale={resolved.locale} titleKey="village.heroTitle" hintKey="village.heroSubtitle" />
          <p className="hint">{t("village.swipeHint")}</p>
          <SkeletonGrid locale={resolved.locale} count={6} />
        </>
      ) : (
        <ul className="grid">
          {stores.map((s) => (
            <li key={s.slug}>
              <a href={`./${resolved.marketId}-${resolved.locale.startsWith("ar") ? "ar" : "en"}/stores/${s.slug}`}>{t("storefront.open", { store: s.name, category: s.category })}</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
