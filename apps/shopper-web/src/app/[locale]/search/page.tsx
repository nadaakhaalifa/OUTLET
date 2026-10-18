import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "../../../components/Breadcrumbs";
import { ProductCard } from "../../../components/Cards";
import { loadSearch } from "../../../data";
import { createTranslator } from "../../../i18n";
import { formatInt } from "../../../lib/format";
import { alternatesFor } from "../../../lib/paths";
import { SITE, localeOf } from "../../../lib/site";

type P = Promise<{ locale: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Search result pages are never indexed (spec: only allow-listed facets are indexable; query spam is stripped). */
export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const locale = localeOf((await params).locale);
  const t = createTranslator(locale);
  const alt = alternatesFor(SITE, locale, "/search");
  return { title: `${t("search.title")} | ${t("app.name")}`, alternates: { canonical: alt.canonical, languages: alt.languages }, robots: { index: false, follow: true } };
}

export default async function SearchPage({ params, searchParams }: { params: P; searchParams: SP }) {
  const locale = localeOf((await params).locale);
  const sp = await searchParams;
  const q = (one(sp.q) ?? "").trim().slice(0, 300);
  const rawCursor = one(sp.cursor);
  const cursor = rawCursor !== undefined && rawCursor.length <= 512 ? rawCursor : undefined;
  const rawStore = one(sp.store);
  const store = rawStore !== undefined && GUID.test(rawStore) ? rawStore.toLowerCase() : undefined;
  const t = createTranslator(locale);
  const r = q === "" && store === undefined ? null : await loadSearch(q, cursor, store);
  const next = r !== null && r.kind === "ok" && r.data.page.has_more ? r.data.page.next_cursor : null;
  const nextHref = next === null ? null : `/${locale}/search?${new URLSearchParams({ ...(q === "" ? {} : { q }), ...(store === undefined ? {} : { store }), cursor: next }).toString()}`;
  return (
    <>
      <Breadcrumbs locale={locale} items={[{ label: t("nav.home"), href: `/${locale}` }, { label: t("search.title") }]} />
      <h1>{q === "" ? t("search.title") : t("search.resultsFor", { q })}</h1>
      <form className="search" role="search" action={`/${locale}/search`} method="get">
        <label className="vh" htmlFor="search-q">{t("search.label")}</label>
        <input id="search-q" name="q" type="search" maxLength={300} defaultValue={q} placeholder={t("search.placeholder")} autoComplete="off" />
        <button className="btn" type="submit">{t("search.submit")}</button>
      </form>
      {r === null ? <p>{t("search.emptyPrompt")}</p> : null}
      {r !== null && r.kind !== "ok" ? <p className="note warn" role="status">{t("state.unavailable")}</p> : null}
      {r !== null && r.kind === "ok" ? (
        <>
          {r.data.did_you_mean !== null && r.data.did_you_mean !== undefined ? (
            <p><Link href={`/${locale}/search?q=${encodeURIComponent(r.data.did_you_mean)}`}>{t("search.didYouMean", { term: r.data.did_you_mean })}</Link></p>
          ) : null}
          {r.data.total_estimate !== undefined ? <p className="hint">{t("search.count", { n: formatInt(r.data.total_estimate, locale) })}</p> : null}
          {r.data.items.length === 0 ? <p>{t("search.empty")}</p> : <ul className="grid">{r.data.items.map((it) => <ProductCard key={it.id} p={it} locale={locale} />)}</ul>}
          {nextHref !== null ? <nav className="pager" aria-label={t("common.pagination")}><Link className="btn ghost" href={nextHref} rel="next">{t("common.more")}</Link></nav> : null}
        </>
      ) : null}
    </>
  );
}
