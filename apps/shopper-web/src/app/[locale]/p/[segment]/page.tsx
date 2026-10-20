import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { Breadcrumbs } from "../../../../components/Breadcrumbs";
import { JsonLd } from "../../../../components/JsonLd";
import { Price, PriceBadge } from "../../../../components/Price";
import { loadEvidence, loadHistory, loadProduct } from "../../../../data";
import { createTranslator } from "../../../../i18n";
import { formatDate, formatMoney, formatPct } from "../../../../lib/format";
import { pick } from "../../../../lib/localized";
import { alternatesFor, entitySegment, idFromSegment, productSegment, safeDecode } from "../../../../lib/paths";
import { SITE, localeOf } from "../../../../lib/site";
import { priceView } from "../../../../view-models/price";
import { breadcrumbJsonLd, isInStock, productJsonLd, sizeRows } from "../../../../view-models/product";


type P = Promise<{ locale: string; segment: string }>;

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const p = await params;
  const locale = localeOf(p.locale);
  const id = idFromSegment(p.segment);
  const r = id === null ? null : await loadProduct(id);
  const t = createTranslator(locale);
  if (r === null || r.kind !== "ok") return { title: t("app.name"), robots: { index: false, follow: false } };
  const pr = r.data;
  const title = pick(pr.title, locale);
  const alt = alternatesFor(SITE, locale, `/p/${productSegment(pr.id)}`);
  const desc = (pr.description === undefined ? `${title} - ${pick(pr.store.name, locale)}` : pick(pr.description, locale)).slice(0, 200);
  const img = pr.images[0]?.url ?? pr.image_url;
  return {
    title: `${title} | ${t("app.name")}`,
    description: desc,
    alternates: { canonical: alt.canonical, languages: alt.languages },
    robots: { index: true, follow: true },
    openGraph: { title, description: desc, url: alt.canonical, type: "website", images: [img ?? "/og-default.png"] },
    twitter: { card: "summary_large_image" },
  };
}

export default async function ProductPage({ params }: { params: P }) {
  const p = await params;
  const locale = localeOf(p.locale);
  const id = idFromSegment(p.segment);
  if (id === null) notFound();
  const [r, ev, hist] = await Promise.all([loadProduct(id), loadEvidence(id), loadHistory(id)]);
  // 410 (delisted) cannot be emitted from an App Router page; 404 + noindex is the closest honest answer.
  if (r.kind === "not_found" || r.kind === "gone") notFound();
  const t = createTranslator(locale);
  if (r.kind === "unavailable") throw new Error("public_data_unavailable");
  const pr = r.data;
  const seg = productSegment(pr.id);
  if (safeDecode(p.segment).toLowerCase() !== seg) permanentRedirect(`/${locale}/p/${encodeURIComponent(seg)}`);
  // Evidence missing (fetch failed) fails closed: no claim is shown.
  const evidence = ev.kind === "ok" ? ev.data : null;
  const view = priceView(pr.price, evidence);
  const rows = sizeRows(pr, evidence);
  const title = pick(pr.title, locale);
  const storeName = pick(pr.store.name, locale);
  const url = alternatesFor(SITE, locale, `/p/${seg}`).canonical;
  const images = pr.images.length > 0 ? pr.images : pr.image_url === undefined ? [] : [{ url: pr.image_url }];
  const lead = images[0];
  const lowest = hist.kind === "ok" ? hist.data.lowest_30d : null;
  const legal = pr.seller_legal_identity_visible ? pr.seller_legal_identity : undefined;
  return (
    <>
      <JsonLd data={productJsonLd({ product: pr, url, site: SITE, locale, imageUrls: images.map((i) => i.url) })} />
      <JsonLd data={breadcrumbJsonLd([
        { name: t("nav.home"), url: alternatesFor(SITE, locale, "").canonical },
        { name: storeName, url: alternatesFor(SITE, locale, `/s/${entitySegment(pr.store.id, pr.store.slug, pr.store.name.en)}`).canonical },
        { name: title, url },
      ])} />
      <Breadcrumbs locale={locale} items={[
        { label: t("nav.home"), href: `/${locale}` },
        { label: storeName, href: `/${locale}/s/${encodeURIComponent(entitySegment(pr.store.id, pr.store.slug, pr.store.name.en))}` },
        { label: title },
      ]} />
      <div className="pdp">
        <div className="gallery">
          {images.length === 0 ? <div className="media" /> : null}
          {images.slice(0, 4).map((im, i) => (
            <div className="media" key={im.url}>
              <img src={im.url} alt={title} width={900} height={1200}
                {...(i === 0 && lead !== undefined ? { fetchPriority: "high" as const } : { loading: "lazy" as const })} decoding="async" />
            </div>
          ))}
        </div>
        <div>
          <h1>{title}</h1>
          <p>{t("product.seller")}: <Link href={`/${locale}/s/${encodeURIComponent(entitySegment(pr.store.id, pr.store.slug, pr.store.name.en))}`}>{storeName}</Link></p>
          <Price view={view} locale={locale} large />
          <p><PriceBadge view={view} locale={locale} /><span className="pill">{t(`product.condition.${pr.condition}`)}</span></p>
          <p className="hint">{t("product.priceVat")}</p>
          {view.claim !== null ? <p>{t("product.referenceLabel")}: {formatMoney(view.claim.reference, locale)} ({formatPct(view.claim.pct, locale)})</p> : null}
          <details>
            <summary>{t("product.howVerified")}</summary>
            <p>{t("product.howVerifiedBody")}</p>
          </details>
          <h2>{t("product.sizes")}</h2>
          <ul className="sizes">
            {rows.map((s) => (
              <li key={s.id} className={s.available ? "" : "out"}>
                <span>{s.label}</span>
                <span className="vh">{s.available ? t("product.size.available") : t("product.size.unavailable")}</span>
                {s.unitsLeft !== null ? <small>{t("product.size.unitsLeft", { n: s.unitsLeft })}</small> : null}
              </li>
            ))}
          </ul>
          <p>{isInStock(pr) ? t("product.inStock") : t("product.outOfStock")}</p>
          <p>
            {pr.return_eligibility.returnable && pr.return_eligibility.window_days !== undefined
              ? t("product.returns.eligible", { days: pr.return_eligibility.window_days })
              : t("product.returns.notEligible")}
          </p>
          {pr.material !== undefined ? <p>{t("product.material")}: {pr.material}</p> : null}
          {pr.size_chart_available === true ? <p>{t("product.sizeChart")}</p> : null}
          <p className="note">{t("product.openInApp")}</p>
        </div>
      </div>
      {pr.description !== undefined ? (
        <section>
          <h2>{t("product.description")}</h2>
          <p>{pick(pr.description, locale)}</p>
        </section>
      ) : null}
      {hist.kind === "ok" && hist.data.points.length > 0 ? (
        <section>
          <h2>{t("product.history.title")}</h2>
          {lowest !== null && lowest !== undefined ? <p>{t("product.history.lowest", { amount: formatMoney(BigInt(lowest.amount), locale) })}</p> : null}
          <div className="table-wrap">
            <table>
              <caption className="vh">{t("product.history.title")}</caption>
              <thead><tr><th scope="col">{t("product.history.row", { date: "" }).trim()}</th><th scope="col">{t("product.price")}</th></tr></thead>
              <tbody>
                {hist.data.points.slice(-12).map((pt) => (
                  <tr key={pt.valid_from}><td>{formatDate(pt.valid_from, locale)}</td><td>{formatMoney(BigInt(pt.price.amount), locale)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {pr.defect_photos !== undefined && pr.defect_photos.length > 0 ? (
        <section>
          <h2>{t("product.defectPhotos")}</h2>
          <ul className="grid">
            {pr.defect_photos.slice(0, 4).map((u) => <li key={u}><img src={u} alt={t("product.defectPhotos")} width={600} height={800} loading="lazy" decoding="async" /></li>)}
          </ul>
        </section>
      ) : null}
      {legal !== undefined ? (
        <details data-nosnippet>
          <summary>{t("stores.legal")}</summary>
          <dl className="dl">
            <dt>{t("stores.legalName")}</dt><dd>{legal.legal_name}</dd>
            <dt>{t("stores.governorate")}</dt><dd>{legal.governorate}</dd>
            <dt>{t("stores.commercialRegister")}</dt><dd>{legal.commercial_register_no}</dd>
            <dt>{t("stores.taxId")}</dt><dd>{legal.tax_card_no}</dd>
          </dl>
        </details>
      ) : null}
    </>
  );
}
