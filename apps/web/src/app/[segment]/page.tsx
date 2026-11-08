import type { Metadata } from "next";
import { createTranslator, localeSegment } from "@outlet/i18n";
import { EmptyState } from "../../components/EmptyState";
import { StoreCarousel, StorefrontCard3D, StorefrontGrid } from "../../components/ui";
import { pageMetadata } from "../../lib/metadata";
import { pick } from "../../lib/present";
import { requireLocale, type SegmentParams } from "../../lib/segment-page";
import { loadStoreDirectory } from "../../server/loaders";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return pageMetadata(await requireLocale(params), "", "nav.explore");
}

export default async function ExplorePage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const { stores } = await loadStoreDirectory(resolved.marketId);
  const cards = stores.map((s) => ({
    key: s.slug,
    storeName: pick(resolved.locale, s.nameAr, s.nameEn),
    category: t(s.kind === "local" ? "store.kindLocal" : "store.kindGlobal"),
    href: `${base}/stores/${s.slug}`,
    ...(s.art ? { image: { src: s.art.src, alt: "", ...(s.art.width !== undefined ? { width: s.art.width } : {}), ...(s.art.height !== undefined ? { height: s.art.height } : {}) } } : {}),
  }));
  return (
    <section aria-labelledby="explore-title">
      <h1 id="explore-title" className="hero">
        {t("village.heroTitle")}
      </h1>
      <p className="hint">{t("village.heroSubtitle")}</p>
      {cards.length === 0 ? (
        <EmptyState locale={resolved.locale} titleKey="village.empty" />
      ) : (
        <>
          <StoreCarousel label={t("village.carouselLabel")} variant="wide" hint={`${t("village.swipeHint")} ↔`} locale={resolved.locale}>
            {cards.map(({ key, ...card }, i) => (
              <StorefrontCard3D key={key} {...card} priority={i === 0} locale={resolved.locale} />
            ))}
          </StoreCarousel>
          <h2 className="sectionTitle">{t("village.gridTitle")}</h2>
          <StorefrontGrid stores={cards} locale={resolved.locale} />
        </>
      )}
    </section>
  );
}
