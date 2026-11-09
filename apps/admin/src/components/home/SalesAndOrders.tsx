import Link from "next/link";
import type { Locale, MessageKey, Translator } from "@outlet/i18n";
import { bucketSeries, flattenTiles, permille, RANGES, tileState, type DashboardResponse, type Range, type SeriesPoint, type TileKey, type Tiles } from "../../lib/dashboard";
import { fmtMoney, fmtNumber } from "../../lib/fmt";
import { BarList, type BarListItem } from "../kit/BarList";
import { ChartTableToggle } from "../kit/ChartTableToggle";
import { DataTable } from "../kit/ChartFrame";
import { ColumnsChart } from "../kit/ColumnsChart";
import { KpiCard } from "../kit/KpiCard";
import { shortDay } from "./HomeTile";

/** Bar geometry only (relative length). Every displayed amount goes through fmtMoney from the exact string. */
const scale = (minor: string): number => Number(BigInt(minor));
const STEPS = ["paid_awaiting_accept", "accepted", "packed", "in_transit", "delivery_failed"] as const;

function Unavailable({ t, label, reason }: { t: Translator; label: string; reason: "not_connected" | "read_failed" | "stale" }) {
  return (
    <div className="card" data-testid="panel-unavailable">
      <h3 className="chartFrameTitle">{label}</h3>
      <p className="hint">{t(`admin.home.unavailable.${reason}`)}</p>
    </div>
  );
}

/** "Sales and orders": 7/30/90 pills (URL `?range=`), columns + table, orders by step, top stores, verified-discount share. Nothing is drawn for a tile the role may not see. */
export function SalesAndOrders({ resp, range, now, t, locale, base, rtl }: { resp: DashboardResponse; range: Range; now: Date; t: Translator; locale: Locale; base: string; rtl: boolean }) {
  const tiles: Tiles = flattenTiles(resp);
  const state = <K extends TileKey>(k: K) => tileState(k, tiles[k], now);
  const series = state("sales_series");
  const steps = state("orders_by_step");
  const top = state("top_stores");
  const verified = state("verified_discount_share");
  if ([series, steps, top, verified].every((s) => s.kind === "hidden")) return null;

  const pills = (
    <nav aria-label={t("admin.home.sales.range")} className="rangePills">
      {RANGES.map((r) => (
        <Link key={r} href={`${base}?range=${r}`} className="rangePill" {...(r === range ? { "aria-current": "true" as const } : {})} data-range={r}>{t(`admin.home.sales.range.${r}` as MessageKey, { days: Number.parseInt(r, 10) })}</Link>
      ))}
    </nav>
  );

  let chart: React.ReactNode = null;
  if (series.kind === "unavailable") chart = <Unavailable t={t} label={t("admin.home.sales.title")} reason={series.reason} />;
  else if (series.kind === "ok") {
    const d = series.data;
    const money = d.gmv !== null;
    const pts: SeriesPoint[] | null = d.gmv !== null ? d.gmv.map((p) => ({ day: p.day, value: BigInt(p.value.amount_minor) })) : d.orders !== null ? d.orders.map((p) => ({ day: p.day, value: BigInt(p.value) })) : null;
    if (pts === null) chart = <p className="hint">{t("admin.home.sales.noSeries")}</p>;
    else {
      const buckets = bucketSeries(pts);
      const weekly = pts.length > 14;
      const total = money && d.total_gmv !== null ? t("admin.home.sales.summaryGmv", { total: fmtMoney(d.total_gmv, locale) }) : d.total_orders !== null ? t("admin.home.sales.summaryOrders", { total: fmtNumber(d.total_orders, locale) }) : "";
      chart = (
        <ColumnsChart
            points={buckets.map((b) => ({ label: shortDay(b.from, locale), value: Number(b.value) }))}
            rtl={rtl}
            title={t(money ? (weekly ? "admin.home.sales.gmvTitleWeek" : "admin.home.sales.gmvTitle") : weekly ? "admin.home.sales.ordersTitleWeek" : "admin.home.sales.ordersTitle")}
            note={t(money ? "admin.home.sales.gmvNote" : "admin.home.sales.ordersNote")}
            {...(total !== "" ? { summary: total } : {})}
            format={{ kind: money ? "money" : "number", locale }}
            axisFormat={{ kind: money ? "moneyCompact" : "compact", locale }}
            valueHeader={t(money ? "admin.home.sales.colSales" : "admin.home.sales.colOrders")}
            labelHeader={t(weekly ? "admin.home.sales.colWeek" : "admin.home.sales.colDay")}
            tableLabel={t("admin.kit.tableView")}
            emptyText={t("admin.kit.chartEmpty")}
            highestLabel={t("admin.kit.highest")}
            latestLabel={t("admin.kit.latest")}
          />
      );
    }
  }

  const stepItems: BarListItem[] = steps.kind === "ok" ? STEPS.map((k) => ({ id: k, label: t(`admin.home.steps.${k}` as MessageKey), value: steps.data[k], valueText: fmtNumber(steps.data[k], locale) })) : [];
  const storeItems: BarListItem[] = top.kind === "ok"
    ? [
        ...top.data.items.map((s) => ({ id: s.store_id, label: locale === "ar-EG" ? s.name_ar : (s.name_en ?? s.name_ar), value: scale(s.gmv.amount_minor), valueText: fmtMoney(s.gmv, locale), sub: t("admin.home.topStores.line", { orders: fmtNumber(s.orders, locale) }) })),
        ...(top.data.other.stores > 0 ? [{ id: "other", label: t("admin.home.topStores.other", { stores: fmtNumber(top.data.other.stores, locale) }), value: scale(top.data.other.gmv.amount_minor), valueText: fmtMoney(top.data.other.gmv, locale), sub: t("admin.home.topStores.line", { orders: fmtNumber(top.data.other.orders, locale) }) }] : []),
      ]
    : [];

  return (
    <section aria-labelledby="home-sales" className="stack" data-section="sales">
      <h2 id="home-sales" className="panelTitle">{t("admin.home.sales.title")}</h2>
      {pills}
      {chart}
      {steps.kind !== "hidden" ? (
        <div className="card" data-panel="steps">
          <h3 className="chartFrameTitle">{t("admin.home.steps.title")}</h3>
          {steps.kind === "unavailable" ? <p className="hint">{t(`admin.home.unavailable.${steps.reason}`)}</p> : stepItems.length === 0 ? <BarList items={stepItems} emptyText={t("admin.kit.chartEmpty")} /> : <ChartTableToggle chart={<BarList items={stepItems} emptyText={t("admin.kit.chartEmpty")} />} table={<DataTable caption={t("admin.home.steps.title")} table={{ head: [t("admin.home.steps.colStep"), t("admin.home.sales.colOrders")], rows: STEPS.map((k) => [t(`admin.home.steps.${k}` as MessageKey), fmtNumber(steps.data[k], locale)]) }} />} label={t("admin.kit.tableView")} />}
        </div>
      ) : null}
      {top.kind !== "hidden" ? (
        <div className="card" data-panel="top-stores">
          <h3 className="chartFrameTitle">{t("admin.home.topStores.title")}</h3>
          {top.kind === "unavailable" ? <p className="hint">{t(`admin.home.unavailable.${top.reason}`)}</p> : <BarList items={storeItems} emptyText={t("admin.home.topStores.empty")} />}
        </div>
      ) : null}
      {verified.kind === "unavailable" ? <Unavailable t={t} label={t("admin.home.verified.title")} reason={verified.reason} /> : null}
      {verified.kind === "ok" ? (() => {
        const pm = permille(verified.data.verified, verified.data.live_skus);
        return pm === null
          ? <div className="card" data-panel="verified"><h3 className="chartFrameTitle">{t("admin.home.verified.title")}</h3><p className="hint">{t("admin.home.verified.none")}</p></div>
          : <KpiCard label={t("admin.home.verified.title")} value={t("admin.home.verified.value", { pct: new Intl.NumberFormat(locale === "ar-EG" ? "ar-EG" : "en-GB", { style: "percent", maximumFractionDigits: 1 }).format(pm / 1000) })} note={t("admin.home.verified.note", { verified: fmtNumber(verified.data.verified, locale), live: fmtNumber(verified.data.live_skus, locale) })} rtl={rtl} />;
      })() : null}
    </section>
  );
}
