import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createTranslator, localeSegment } from "@outlet/i18n";
import { money } from "@outlet/money";
import { EmptyState } from "../../../../components/EmptyState";
import { JsonLd } from "../../../../components/JsonLd";
import { Breadcrumb, QuickViewPanel, ShelfWall, StoreHeader } from "../../../../components/ui";
import { pageMetadata } from "../../../../lib/metadata";
import { productIdSchema, storeSlugSchema } from "../../../../lib/params";
import { decimalString, pick, toCondition, toCubby, toImage, toPricing } from "../../../../lib/present";
import { requireLocale } from "../../../../lib/segment-page";
import { readEnv } from "../../../../server/env";
import { loadStore, loadStoreProducts } from "../../../../server/loaders";

type Params = Promise<{ segment: string; slug: string }>;
type Search = Promise<{ p?: string | string[] }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await requireLocale(params);
  const parsed = storeSlugSchema.safeParse(slug);
  return pageMetadata(resolved, parsed.success ? `/stores/${parsed.data}` : "", "nav.explore");
}

export default async function StorePage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const resolved = await requireLocale(params);
  const slug = storeSlugSchema.safeParse((await params).slug);
  if (!slug.success) notFound();
  const store = await loadStore(resolved.marketId, slug.data);
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  if (store === null) {
    return (
      <section aria-labelledby="store-title">
        <h1 id="store-title" className="hero">
          {t("store.notFound")}
        </h1>
        <EmptyState locale={resolved.locale} />
      </section>
    );
  }
  // Products carry price and stock: loaded per request with no-store.
  const { items } = await loadStoreProducts(resolved.marketId, slug.data, { limit: 50 });
  const storeHref = `${base}/stores/${slug.data}`;
  const name = pick(resolved.locale, store.nameAr, store.nameEn);
  const cubbies = items.flatMap((p) => {
    const c = toCubby(p, resolved.locale, store, storeHref);
    return c === null ? [] : [c];
  });

  const pRaw = (await searchParams).p;
  const pId = productIdSchema.safeParse(Array.isArray(pRaw) ? pRaw[0] : pRaw);
  const selected = pId.success ? items.find((p) => p.id === pId.data) : undefined;
  const selectedPricing = selected ? toPricing(selected, store) : null;
  const selectedImage = selected ? toImage(selected, resolved.locale) : undefined;
  const condition = selected ? toCondition(selected.conditionGradeCode) : undefined;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const origin = readEnv().SITE_URL;

  return (
    <section aria-labelledby="store-title">
      <Breadcrumb label={t("store.breadcrumb")} items={[{ label: t("store.breadcrumbStores"), href: base }, { label: name }]} />
      <StoreHeader
        name={name}
        followHref={`${base}/account`}
        verified={store.verifiedBadge}
        followers={store.followersCount}
        locale={resolved.locale}
        {...(pick(resolved.locale, store.taglineAr ?? "", store.taglineEn) ? { tagline: pick(resolved.locale, store.taglineAr ?? "", store.taglineEn) } : {})}
      />
      {cubbies.length === 0 ? <EmptyState locale={resolved.locale} titleKey="store.noProducts" /> : <ShelfWall items={cubbies} locale={resolved.locale} />}
      {selected && selectedPricing ? (
        <QuickViewPanel
          name={pick(resolved.locale, selected.titleAr, selected.titleEn)}
          storeName={name}
          pricing={selectedPricing}
          defectCount={selected.defectCount}
          availability={selected.availability}
          fullPageHref={`${base}/p/${selected.id}`}
          closeHref={storeHref}
          locale={resolved.locale}
          {...(selectedImage ? { image: selectedImage } : {})}
          {...(condition ? { condition } : {})}
        />
      ) : null}
      <JsonLd nonce={nonce} data={{ "@context": "https://schema.org", "@type": "Store", name, url: `${origin}${storeHref}` }} />
      {selected && selectedPricing ? (
        <JsonLd
          nonce={nonce}
          data={{
            "@context": "https://schema.org",
            "@type": "Product",
            name: pick(resolved.locale, selected.titleAr, selected.titleEn),
            url: `${origin}${base}/p/${selected.id}`,
            ...(selectedImage ? { image: selectedImage.src } : {}),
            offers: {
              "@type": "Offer",
              price: decimalString(money(selected.price.amountMinor, selectedPricing.price.currency)),
              priceCurrency: selectedPricing.price.currency,
              availability: selected.availability === "out_of_stock" ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
            },
          }}
        />
      ) : null}
    </section>
  );
}
