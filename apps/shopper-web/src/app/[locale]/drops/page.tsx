import type { Metadata } from "next";
import { Breadcrumbs } from "../../../components/Breadcrumbs";
import { DropCard } from "../../../components/Cards";
import { loadDrops } from "../../../data";
import { createTranslator } from "../../../i18n";
import { alternatesFor } from "../../../lib/paths";
import { SITE, localeOf } from "../../../lib/site";


export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeOf((await params).locale);
  const t = createTranslator(locale);
  const alt = alternatesFor(SITE, locale, "/drops");
  return { title: `${t("drops.title")} | ${t("app.name")}`, description: t("drops.intro"), alternates: { canonical: alt.canonical, languages: alt.languages }, openGraph: { title: t("drops.title"), url: alt.canonical, images: ["/og-default.png"] } };
}

export default async function DropsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeOf((await params).locale);
  const t = createTranslator(locale);
  const r = await loadDrops();
  if (r.kind === "unavailable") throw new Error("public_data_unavailable");
  return (
    <>
      <Breadcrumbs locale={locale} items={[{ label: t("nav.home"), href: `/${locale}` }, { label: t("drops.title") }]} />
      <h1>{t("drops.title")}</h1>
      <p className="lede">{t("drops.intro")}</p>
      {r.kind !== "ok" ? <p className="note warn" role="status">{t("state.unavailable")}</p> : null}
      {r.kind === "ok" && r.data.items.length === 0 ? <p>{t("drops.empty")}</p> : null}
      {r.kind === "ok" && r.data.items.length > 0 ? <ul className="cards">{r.data.items.map((d) => <DropCard key={d.id} d={d} locale={locale} />)}</ul> : null}
    </>
  );
}
