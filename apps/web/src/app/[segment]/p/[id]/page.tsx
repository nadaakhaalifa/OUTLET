import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createTranslator, localeSegment } from "@outlet/i18n";
import { money } from "@outlet/money";
import { EmptyState } from "../../../../components/EmptyState";
import { JsonLd } from "../../../../components/JsonLd";
import { Breadcrumb, DefectCard, Picture, PriceBlock } from "../../../../components/ui";
import { productIdSchema } from "../../../../lib/params";
import { pageMetadata } from "../../../../lib/metadata";
import { decimalString, pick, toPricing } from "../../../../lib/present";
import { requireLocale } from "../../../../lib/segment-page";
import type { SkuView } from "../../../../server/api-client";
import { readEnv } from "../../../../server/env";
import { loadProduct } from "../../../../server/loaders";

type Params = Promise<{ segment: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const resolved = await requireLocale(params);
  const parsed = productIdSchema.safeParse(id);
  return pageMetadata(resolved, parsed.success ? `/p/${parsed.data}` : "", "product.quickView");
}

/** The offer shown on the page: the cheapest SKU that can be bought, else the cheapest overall (same currency as the first). */
function headlineSku(skus: readonly SkuView[]): SkuView | undefined {
  const first = skus[0];
  if (first === undefined) return undefined;
  const same = skus.filter((k) => k.price.currency === first.price.currency);
  const buyable = same.filter((k) => k.availability !== "out_of_stock");
  const pool = buyable.length > 0 ? buyable : same;
  return pool.reduce((a, b) => (b.price.amountMinor < a.price.amountMinor ? b : a));
}

const GRADES = ["A", "B", "C"] as const;
const asGrade = (code: string): (typeof GRADES)[number] | null => GRADES.find((g) => g === code.toUpperCase()) ?? null;

export default async function ProductPage({ params }: { params: Params }) {
  const resolved = await requireLocale(params);
  const id = productIdSchema.safeParse((await params).id);
  if (!id.success) notFound();
  // Price and stock are read live on every request (never from a cached fetch).
  const product = await loadProduct(resolved.marketId, id.data);
  const t = createTranslator(resolved.locale);
  if (product === null) {
    return (
      <section aria-labelledby="product-title">
        <h1 id="product-title" className="hero">
          {t("product.unavailable")}
        </h1>
        <EmptyState locale={resolved.locale} />
      </section>
    );
  }
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const { locale } = resolved;
  const title = pick(locale, product.titleAr, product.titleEn);
  const storeName = pick(locale, product.store.nameAr, product.store.nameEn);
  const sku = headlineSku(product.skus);
  const pricing = sku ? toPricing({ price: sku.price }, product.store) : null;
  const legal = product.legal;
  const dc = product.defectCard;
  const grade = dc ? asGrade(dc.gradeCode) : null;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const origin = readEnv().SITE_URL;
  const dcSummary = dc ? pick(locale, dc.summaryAr ?? "", dc.summaryEn) : "";

  return (
    <article aria-labelledby="product-title">
      <Breadcrumb
        label={t("product.breadcrumb")}
        items={[{ label: t("store.breadcrumbStores"), href: `${base}/stores` }, { label: storeName, href: `${base}/stores/${product.store.slug}` }, { label: title }]}
      />
      <h1 id="product-title" className="hero">
        {title}
      </h1>
      <p className="hint">{t("product.soldByStore", { store: storeName })}</p>
      <p>
        <span className="filterLink" aria-label={t("product.condition")}>
          {pick(locale, product.conditionLabelAr, product.conditionLabelEn)}
        </span>
      </p>
      {pricing ? <PriceBlock {...pricing} locale={locale} /> : <p className="hint">{t("product.noPriceYet")}</p>}
      {product.skus.length > 0 ? (
        <section aria-labelledby="sizes-title">
          <h2 id="sizes-title" className="sectionTitle">
            {t("product.sizes")}
          </h2>
          <ul className="sizes">
            {product.skus.map((k) => (
              <li key={k.id} className="sizeTag">
                {k.sizeLabel ?? title}
                {k.availability === "out_of_stock" ? ` · ${t("product.sizeUnavailable")}` : k.availability === "low_stock" ? ` · ${t("product.lowStock")}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="desc-title">
        <h2 id="desc-title" className="sectionTitle">
          {t("product.description")}
        </h2>
        {product.brandName ? (
          <p className="hint">
            {t("product.brand")}: {product.brandName}
          </p>
        ) : null}
        <p>{pick(locale, product.descriptionAr, product.descriptionEn)}</p>
      </section>
      {dc && grade ? (
        <DefectCard
          grade={grade}
          locale={locale}
          photos={dc.items.map((i) => ({ src: i.photo.url, alt: pick(locale, i.photo.altAr ?? i.labelAr, i.photo.altEn ?? i.labelEn) }))}
          {...(dcSummary ? { description: dcSummary } : {})}
          doesNotAffectOperation={!dc.affectsFunction}
        />
      ) : dc ? (
        <section aria-labelledby="defects-title">
          <h2 id="defects-title" className="sectionTitle">
            {t("product.defectSummary")}
          </h2>
          {dcSummary ? <p>{dcSummary}</p> : null}
          <ul aria-label={t("product.defectItems")}>
            {dc.items.map((i) => (
              <li key={i.photo.url}>
                <Picture image={{ src: i.photo.url, alt: pick(locale, i.photo.altAr ?? i.labelAr, i.photo.altEn ?? i.labelEn), ...(i.photo.width !== null ? { width: i.photo.width } : {}), ...(i.photo.height !== null ? { height: i.photo.height } : {}) }} />
                <p>{pick(locale, i.labelAr, i.labelEn)} · {pick(locale, i.locationAr, i.locationEn)}</p>
                {i.affectsFunction ? <p className="hint">{t("product.defectAffects")}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="legal-title">
        <h2 id="legal-title" className="sectionTitle">
          {t("product.legalTitle")}
        </h2>
        <dl className="legal">
          <dt>{t("product.legalName")}</dt>
          <dd>{pick(locale, legal.legalNameAr, legal.legalNameEn)}</dd>
          <dt>{t("product.legalRegister")}</dt>
          <dd dir="ltr">{legal.commercialRegisterNo}</dd>
          <dt>{t("product.legalTax")}</dt>
          <dd dir="ltr">{legal.taxCardNo}</dd>
          <dt>{t("product.legalGovernorate")}</dt>
          <dd>{legal.governorateNameAr}</dd>
        </dl>
      </section>
      {sku && pricing ? (
        <JsonLd
          nonce={nonce}
          data={{
            "@context": "https://schema.org",
            "@type": "Product",
            name: title,
            description: pick(locale, product.descriptionAr, product.descriptionEn),
            url: `${origin}${base}/p/${product.id}`,
            itemCondition: product.schemaOrgCondition,
            ...(product.brandName ? { brand: { "@type": "Brand", name: product.brandName } } : {}),
            offers: {
              "@type": "Offer",
              price: decimalString(money(sku.price.amountMinor, pricing.price.currency)),
              priceCurrency: pricing.price.currency,
              availability: sku.availability === "out_of_stock" ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
              seller: { "@type": "Organization", name: legal.legalNameAr },
            },
          }}
        />
      ) : null}
    </article>
  );
}
