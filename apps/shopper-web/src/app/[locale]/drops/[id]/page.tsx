import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "../../../../components/Breadcrumbs";
import { ServerCountdown } from "../../../../components/ServerCountdown";
import { loadDrop } from "../../../../data";
import { createTranslator } from "../../../../i18n";
import { formatDateTime, formatInt, formatMoney } from "../../../../lib/format";
import { alternatesFor, idFromSegment } from "../../../../lib/paths";
import { SITE, localeOf } from "../../../../lib/site";
import { dropStateKey, isIndexableDrop, ladderSteps, mysteryText, priceRange } from "../../../../view-models/drops";


type P = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const p = await params;
  const locale = localeOf(p.locale);
  const id = idFromSegment(p.id);
  const r = id === null ? null : await loadDrop(id);
  const t = createTranslator(locale);
  if (r === null || r.kind !== "ok") return { title: t("app.name"), robots: { index: false, follow: false } };
  const d = r.data;
  const alt = alternatesFor(SITE, locale, `/drops/${d.id}`);
  return {
    title: `${d.title} | ${t("app.name")}`,
    description: `${t(`drops.type.${d.type}`)}. ${t("drops.starts", { time: formatDateTime(d.starts_at, locale) })}`,
    alternates: { canonical: alt.canonical, languages: alt.languages },
    robots: isIndexableDrop(d) ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: { title: d.title, url: alt.canonical, images: ["/og-default.png"] },
  };
}

export default async function DropPage({ params }: { params: P }) {
  const p = await params;
  const locale = localeOf(p.locale);
  const id = idFromSegment(p.id);
  if (id === null) notFound();
  const r = await loadDrop(id);
  if (r.kind === "not_found" || r.kind === "gone") notFound();
  const t = createTranslator(locale);
  // Fail closed and do not cache a fallback: ISR keeps serving the last good page; first render shows the error state.
  if (r.kind === "unavailable") throw new Error("public_data_unavailable");
  const d = r.data;
  const key = dropStateKey(d.state);
  const range = priceRange(d);
  const mystery = mysteryText(d, locale);
  const ladder = ladderSteps(d);
  const upcoming = key === "SCHEDULED" || key === "EARLY_ACCESS";
  return (
    <>
      <Breadcrumbs locale={locale} items={[{ label: t("nav.home"), href: `/${locale}` }, { label: t("drops.title"), href: `/${locale}/drops` }, { label: d.title }]} />
      <h1>{d.title}</h1>
      <p>
        <span className={key === "LIVE" ? "pill live" : "pill"}>{t(`drops.state.${key}`)}</span>
        <span className="pill">{t(`drops.type.${d.type}`)}</span>
        {d.paused ? <span className="pill">{t("drops.paused")}</span> : null}
      </p>
      <dl className="dl">
        <dt>{t("drops.starts", { time: "" }).trim()}</dt>
        <dd>{formatDateTime(d.starts_at, locale)}</dd>
        <dt>{t("drops.ends", { time: "" }).trim()}</dt>
        <dd>{formatDateTime(d.ends_at, locale)}</dd>
      </dl>
      {d.early_access_at !== null ? <p>{t("drops.earlyAccess", { time: formatDateTime(d.early_access_at, locale) })}</p> : null}
      {upcoming ? <ServerCountdown deadlineIso={d.starts_at} locale={locale} kind="startsIn" /> : null}
      {key === "LIVE" ? <ServerCountdown deadlineIso={d.ends_at} locale={locale} kind="endsIn" /> : null}
      <p>{t("drops.limits", { perUser: formatInt(d.limits.per_user, locale), perDevice: formatInt(d.limits.per_device, locale) })}</p>
      {mystery !== null ? <p className="note">{t("drops.mysteryRange", mystery)}</p> : null}
      {range !== null ? (
        <>
          <h2>{t("drops.items")}</h2>
          <p>{t("drops.priceFrom", { amount: formatMoney(range.min, locale) })}</p>
        </>
      ) : null}
      {ladder.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption>{t("drops.ladderTitle")}</caption>
            <thead><tr><th scope="col">{t("drops.ladderAt")}</th><th scope="col">{t("drops.ladderPrices")}</th></tr></thead>
            <tbody>
              {ladder.map((s) => (
                <tr key={s.at}>
                  <td>{formatDateTime(s.at, locale)}</td>
                  <td>{t("drops.ladderRange", { min: formatMoney(s.min, locale), max: formatMoney(s.max, locale) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="note">{t("drops.openInApp")}</p>
    </>
  );
}
