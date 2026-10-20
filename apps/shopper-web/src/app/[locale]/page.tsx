import type { Metadata } from "next";
import Link from "next/link";
import { DropCard, StoreCard } from "../../components/Cards";
import { JsonLd } from "../../components/JsonLd";
import { loadDrops, loadStores } from "../../data";
import { createTranslator } from "../../i18n";
import { alternatesFor } from "../../lib/paths";
import { SITE, localeOf } from "../../lib/site";
import { organizationJsonLd } from "../../view-models/product";


export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeOf((await params).locale);
  const t = createTranslator(locale);
  const alt = alternatesFor(SITE, locale, "");
  return {
    title: `${t("app.name")} | ${t("app.tagline")}`,
    description: t("home.subtitle"),
    alternates: { canonical: alt.canonical, languages: alt.languages },
    openGraph: { title: t("app.name"), description: t("home.subtitle"), url: alt.canonical, siteName: "Z-OUTLET", locale: locale === "ar" ? "ar_EG" : "en", type: "website", images: ["/og-default.png"] },
    twitter: { card: "summary_large_image" },
  };
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeOf((await params).locale);
  const t = createTranslator(locale);
  const [drops, stores] = await Promise.all([loadDrops(), loadStores(undefined, 6)]);
  if (drops.kind === "unavailable" && stores.kind === "unavailable") throw new Error("public_data_unavailable");
  const dropItems = drops.kind === "ok" ? drops.data.items.slice(0, 6) : [];
  const storeItems = stores.kind === "ok" ? stores.data.items.slice(0, 6) : [];
  return (
    <>
      <JsonLd data={organizationJsonLd(SITE, "Z-OUTLET")} />
      <section className="hero-banner" aria-labelledby="home-title">
        <span className="hero-art" aria-hidden="true"><span className="arch a1" /><span className="arch a2" /><span className="arch a3" /></span>
        <div className="hero-copy">
          <h1 id="home-title">{t("home.title")}</h1>
          <p className="lede">{t("home.subtitle")}</p>
          <form className="search" role="search" action={`/${locale}/search`} method="get">
            <label className="vh" htmlFor="home-q">{t("home.searchLabel")}</label>
            <input id="home-q" name="q" type="search" maxLength={300} placeholder={t("search.placeholder")} autoComplete="off" />
            <button className="btn" type="submit">{t("home.searchCta")}</button>
          </form>
        </div>
      </section>
      <nav className="shortcuts" aria-label={t("common.mainNav")}>
        <ul>
          <li><Link href={`/${locale}/drops`}><span className="circle" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z" /></svg></span><span>{t("nav.drops")}</span></Link></li>
          <li><Link href={`/${locale}/search`}><span className="circle" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg></span><span>{t("nav.search")}</span></Link></li>
          <li><a href="#home-stores"><span className="circle" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M4 9l1.5-5h13L20 9M5 9v11h14V9M9 20v-6h6v6" /></svg></span><span>{t("nav.stores")}</span></a></li>
        </ul>
      </nav>
      <section aria-labelledby="home-drops">
        <h2 id="home-drops">{t("home.drops.title")}</h2>
        {drops.kind === "unavailable" ? <p className="note">{t("state.unavailable")}</p> : null}
        {drops.kind !== "unavailable" && dropItems.length === 0 ? <p>{t("home.drops.empty")}</p> : null}
        {dropItems.length > 0 ? <ul className="cards">{dropItems.map((d) => <DropCard key={d.id} d={d} locale={locale} />)}</ul> : null}
        <p><Link className="btn ghost" href={`/${locale}/drops`}>{t("home.viewAllDrops")}</Link></p>
      </section>
      <section aria-labelledby="home-stores">
        <h2 id="home-stores">{t("home.stores.title")}</h2>
        {stores.kind === "unavailable" ? <p className="note">{t("state.unavailable")}</p> : null}
        {stores.kind !== "unavailable" && storeItems.length === 0 ? <p>{t("home.stores.empty")}</p> : null}
        {storeItems.length > 0 ? <ul className="cards">{storeItems.map((s) => <StoreCard key={s.id} s={s} locale={locale} />)}</ul> : null}
      </section>
    </>
  );
}
