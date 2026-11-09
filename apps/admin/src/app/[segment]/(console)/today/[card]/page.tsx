import Link from "next/link";
import { notFound } from "next/navigation";
import { createTranslator, localeSegment, type Translator } from "@outlet/i18n";
import { ConsoleFrame } from "../../../../../components/ConsoleFrame";
import { HomeTile, shortDay } from "../../../../../components/home/HomeTile";
import { PopList, type PopRow } from "../../../../../components/home/PopList";
import { tileLabel } from "../../../../../components/home/tileModel";
import { BackLink } from "../../../../../components/kit/BackLink";
import { PageHeader } from "../../../../../components/kit/PageHeader";
import { ProblemBanner } from "../../../../../components/ProblemBanner";
import { AttentionPage } from "../../../../../lib/attention";
import { cardBySlug, DashboardResponse, DEFAULT_RANGE, flattenTiles, MAX_POP_ROWS, type CardDef } from "../../../../../lib/dashboard";
import { fmtDateTime, fmtNumber } from "../../../../../lib/fmt";
import { label } from "../../../../../lib/labels";
import { load } from "../../../../../lib/load";
import { ApprovalPage, KycSummaryPage } from "../../../../../lib/schemas";
import { requireLocale } from "../../../../../lib/segment-page";

const KYC_OPEN = ["SUBMITTED", "AUTO_CHECKS", "NEEDS_INFO"];

interface Listing { readonly head: readonly string[]; readonly rows: readonly PopRow[]; readonly total: number }
type Listed = { readonly kind: "list"; readonly list: Listing } | { readonly kind: "none" } | { readonly kind: "problem"; readonly code: string; readonly status: number };

/** Rows for the cards whose list endpoint exists; every other card is "none" (an honest "not connected yet", never a made-up list). */
async function listFor(card: CardDef, market: string, base: string, t: Translator, locale: "ar-EG" | "en-EG"): Promise<Listed> {
  if (card.slug === "kyc-queue") {
    const r = await load(KycSummaryPage, market, "kyc-cases");
    if (!r.ok) return { kind: "problem", code: r.code, status: r.status };
    const open = r.data.items.filter((i) => KYC_OPEN.includes(i.status));
    return { kind: "list", list: { total: open.length, head: [t("admin.home.pop.colLegal"), t("admin.home.pop.colStatus"), t("admin.home.pop.colSubmitted")], rows: open.slice(0, MAX_POP_ROWS).map((i) => ({ id: i.id, href: `${base}/kyc/${i.id}`, cells: [i.legal_name_ar, label(t, "admin.home.pop.kycStatus", i.status), fmtDateTime(i.submitted_at, locale)] })) } };
  }
  if (card.slug === "attention") {
    const r = await load(AttentionPage, market, "attention");
    if (!r.ok) return { kind: "problem", code: r.code, status: r.status };
    const open = r.data.items.filter((i) => i.status !== "RESOLVED");
    return { kind: "list", list: { total: open.length, head: [t("admin.attention.colKind"), t("admin.attention.colStatus"), t("admin.attention.colSince")], rows: open.slice(0, MAX_POP_ROWS).map((i) => ({ id: i.id, cells: [label(t, "admin.attention.kind", i.kind), label(t, "admin.attention.status", i.status), fmtDateTime(i.created_at, locale)] })) } };
  }
  if (card.slug === "approvals") {
    const r = await load(ApprovalPage, market, "approval-requests");
    if (!r.ok) return { kind: "problem", code: r.code, status: r.status };
    const pending = r.data.items.filter((i) => i.status === "PENDING");
    return { kind: "list", list: { total: pending.length, head: [t("admin.home.pop.colAction"), t("admin.home.pop.colExpires")], rows: pending.slice(0, MAX_POP_ROWS).map((i) => ({ id: i.id, cells: [i.action, fmtDateTime(i.expires_at, locale)] })) } };
  }
  return { kind: "none" };
}

export default async function PopPage({ params }: { params: Promise<{ segment: string; card: string }> }) {
  const { card: slug } = await params;
  const resolved = await requireLocale(params);
  const card = cardBySlug(slug);
  if (card === undefined) notFound();
  const t = createTranslator(resolved.locale);
  const locale = resolved.locale;
  const base = `/${localeSegment(resolved.marketId, locale)}`;
  const now = new Date();
  const dash = await load(DashboardResponse, resolved.marketId, "dashboard", { range: DEFAULT_RANGE });
  const title = tileLabel(t, card.tile);
  const header = <PageHeader title={title} back={<BackLink href={base}>{t("admin.home.pop.back")}</BackLink>} />;

  let content: React.ReactNode;
  if (!dash.ok) content = <ProblemBanner t={t} code={dash.code} status={dash.status} />;
  else {
    const tiles = flattenTiles(dash.data);
    // A card and its pop page need the same action: a forbidden tile means 403 here (the API enforced it when it computed the tile).
    if (tiles[card.tile].status === "forbidden") content = <ProblemBanner t={t} code="forbidden" status={403} />;
    else {
      const listed = await listFor(card, resolved.marketId, base, t, locale);
      const series = card.tile === "orders_today" && tiles.orders_today.status === "ok" ? tiles.orders_today.data.series_14d : null;
      content = (
        <div className="stack">
          <ul className="tileGrid"><HomeTile tileKey={card.tile} tiles={tiles} now={now} t={t} locale={locale} base={base} rtl={locale === "ar-EG"} href={null} /></ul>
          {series !== null ? <PopList caption={t("admin.home.pop.seriesTitle", { days: 14 })} head={[t("admin.home.pop.colDay"), t("admin.home.pop.colOrders")]} rows={series.map((p) => ({ id: p.day, cells: [shortDay(p.day, locale), fmtNumber(p.value, locale)] }))} viewLabel={t("admin.home.pop.view")} /> : null}
          {listed.kind === "problem" ? <ProblemBanner t={t} code={listed.code} status={listed.status} /> : null}
          {listed.kind === "none" ? <p className="hint" data-testid="list-missing">{t("admin.home.pop.listMissing")}</p> : null}
          {listed.kind === "list" ? (
            listed.list.rows.length === 0 ? <p className="hint" data-testid="list-empty">{t("admin.home.pop.empty")}</p> : (
              <>
                <PopList caption={title} head={listed.list.head} rows={listed.list.rows} viewLabel={t("admin.home.pop.view")} />
                {listed.list.total > MAX_POP_ROWS ? <p className="hint">{t("admin.home.pop.showing", { n: fmtNumber(MAX_POP_ROWS, locale) })}</p> : null}
              </>
            )
          ) : null}
          {card.fullList !== null ? <p><Link href={`${base}${card.fullList}`} className="btn btnSecondary">{t("admin.home.pop.openList")}</Link></p> : null}
        </div>
      );
    }
  }
  return <ConsoleFrame resolved={resolved} section="overview">{header}{content}</ConsoleFrame>;
}

