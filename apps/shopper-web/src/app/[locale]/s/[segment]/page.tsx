import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { Breadcrumbs } from "../../../../components/Breadcrumbs";
import { ProductCard } from "../../../../components/Cards";
import { JsonLd } from "../../../../components/JsonLd";
import { loadSearch, loadStore } from "../../../../data";
import { createTranslator } from "../../../../i18n";
import { formatMoney, formatPct } from "../../../../lib/format";
import { pick } from "../../../../lib/localized";
import { alternatesFor, entitySegment, idFromSegment, safeDecode } from "../../../../lib/paths";
import { SITE, localeOf } from "../../../../lib/site";
import { breadcrumbJsonLd, sellerJsonLd } from "../../../../view-models/product";


type P = Promise<{ locale: string; segment: string }>;

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const p = await params;
  const locale = localeOf(p.locale);
  const id = idFromSegment(p.segment);
  const r = id === null ? null : await loadStore(id);
  const t = createTranslator(locale);
  if (r === null || r.kind !== "ok") return { title: t("app.name"), robots: { index: false, follow: false } };
  const s = r.data;
  const alt = alternatesFor(SITE, locale, `/s/${entitySegment(s.id, s.slug, s.name.en)}`);
  const name = pick(s.name, locale);
  const desc = s.description === undefined ? t("app.tagline") : pick(s.description, locale);
  const image = s.cover_url ?? s.logo_url;
  return {
    title: `${name} | ${t("app.name")}`,
    description: desc.slice(0, 200),
    alternates: { canonical: alt.canonical, languages: alt.languages },
    robots: { index: true, follow: true },
    openGraph: { title: name, description: desc.slice(0, 200), url: alt.canonical, images: [image ?? "/og-default.png"] },
  };
}

export default async function StorePage({ params }: { params: P }) {
  const p = await params;
  const locale = localeOf(p.locale);
  const id = idFromSegment(p.segment);
  if (id === null) notFound();
  const [r, products] = await Promise.all([loadStore(id), loadSearch("", undefined, id)]);
  if (r.kind === "not_found" || r.kind === "gone") notFound();
  const t = createTranslator(locale);
  if (r.kind === "unavailable") throw new Error("public_data_unavailable");
  const s = r.data;
  // Suspended stores answer 404 from the API (never reach here); PublicStore.status is always "active".
  const canonicalSegment = entitySegment(s.id, s.slug, s.name.en);
  if (safeDecode(p.segment).toLowerCase() !== canonicalSegment) permanentRedirect(`/${locale}/s/${encodeURIComponent(canonicalSegment)}`);
  const name = pick(s.name, locale);
  const url = alternatesFor(SITE, locale, `/s/${canonicalSegment}`).canonical;
  const items = products.kind === "ok" ? products.data.items : [];
  const li = s.legal_identity;
  return (
    <>
      <JsonLd data={sellerJsonLd(name, url, li.legal_name)} />
      <JsonLd data={breadcrumbJsonLd([{ name: t("nav.home"), url: alternatesFor(SITE, locale, "").canonical }, { name, url }])} />
      <Breadcrumbs locale={locale} items={[{ label: t("nav.home"), href: `/${locale}` }, { label: name }]} />
      <h1>{name}</h1>
      <p>
        <span className="pill">{t(s.kind === "local" ? "stores.kind.local" : "stores.kind.global")}</span>
        {s.verified_badge ? <span className="pill">{t("stores.verified")}</span> : null}
        {s.live_drop ? <span className="pill live">{t("stores.liveDrop")}</span> : null}
        {s.max_verified_discount_pct !== null && s.max_verified_discount_pct !== undefined ? (
          <span className="pill savings">{t("stores.maxVerifiedDiscount", { pct: formatPct(s.max_verified_discount_pct, locale) })}</span>
        ) : null}
      </p>
      {s.rating !== null && s.rating !== undefined && s.rating_count !== undefined && s.rating_count > 0 ? (
        <p>{t("stores.rating", { rating: s.rating.toFixed(1), count: s.rating_count })}</p>
      ) : null}
      {s.description !== undefined ? <p className="lede">{pick(s.description, locale)}</p> : null}
      {s.free_delivery_threshold !== undefined ? <p>{t("stores.freeDelivery", { amount: formatMoney(BigInt(s.free_delivery_threshold.amount), locale) })}</p> : null}
      <details data-nosnippet>
        <summary>{t("stores.legal")}</summary>
        <dl className="dl">
          <dt>{t("stores.legalName")}</dt><dd>{li.legal_name}</dd>
          {li.governorate !== undefined ? <><dt>{t("stores.governorate")}</dt><dd>{li.governorate}</dd></> : null}
          {li.commercial_register_no !== undefined ? <><dt>{t("stores.commercialRegister")}</dt><dd>{li.commercial_register_no}</dd></> : null}
          {li.tax_id !== undefined ? <><dt>{t("stores.taxId")}</dt><dd>{li.tax_id}</dd></> : null}
        </dl>
      </details>
      <h2>{t("stores.products")}</h2>
      {items.length === 0 ? <p>{t("stores.productsEmpty")}</p> : <ul className="grid">{items.map((it) => <ProductCard key={it.id} p={it} locale={locale} />)}</ul>}
      {products.kind === "ok" && products.data.page.has_more ? (
        <p><Link className="btn ghost" href={`/${locale}/search?store=${s.id}`}>{t("common.more")}</Link></p>
      ) : null}
    </>
  );
}
