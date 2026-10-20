import type { AgingReport } from "../api/schemas";
import type { SizeCurveReport } from "../api/schemas-phase2";
import type { Locale, MessageKey } from "../i18n";
import { formatBps, formatInt, formatMoney } from "../lib/format";

export interface MarkdownRowVM {
  readonly skuId: string;
  readonly size: string;
  readonly severityKey: MessageKey;
  readonly ageDays: string;
  readonly onHand: string;
  readonly sellThrough: string | null;
  readonly price: string;
  /** Suggested price, or null when there is no suggestion or the server flagged a percent-off claim (never shown). */
  readonly suggested: string | null;
  readonly notice: string;
  readonly percentOffBlocked: boolean;
}

const SEVERITY = new Set(["info", "warning", "critical"]);

export function markdownRows(report: AgingReport, locale: Locale): readonly MarkdownRowVM[] {
  return report.alerts.map((a) => {
    const r = a.markdown_recommendation;
    const blocked = r.shows_percent_off;
    return {
      skuId: a.sku_id,
      size: a.size,
      severityKey: SEVERITY.has(a.severity) ? (`insights.severity.${a.severity}` as MessageKey) : "insights.severity.unknown",
      ageDays: formatInt(a.age_days, locale),
      onHand: formatInt(a.on_hand, locale),
      sellThrough: a.sell_through_bps === null ? null : formatBps(a.sell_through_bps, locale),
      price: formatMoney(a.price.minor, locale),
      suggested: blocked || r.suggested_price === null ? null : formatMoney(r.suggested_price.minor, locale),
      notice: locale === "ar" ? r.notice.ar : r.notice.en,
      percentOffBlocked: blocked,
    };
  });
}

export interface SizeCurveVM {
  readonly productId: string;
  readonly totalSold: string;
  readonly totalStocked: string;
  readonly rows: readonly {
    readonly size: string; readonly sold: string; readonly onHand: string;
    readonly soldShare: string | null; readonly stockedShare: string | null;
    /** Positive gap = demand share above stocked share (under-stocked size). */
    readonly gap: string | null; readonly gapKey: MessageKey | null;
  }[];
}

export function sizeCurveRows(report: SizeCurveReport, locale: Locale): readonly SizeCurveVM[] {
  return report.products.map((p) => ({
    productId: p.product_id,
    totalSold: formatInt(p.total_sold, locale),
    totalStocked: formatInt(p.total_stocked, locale),
    rows: p.rows.map((r) => ({
      size: r.size,
      sold: formatInt(r.sold_units, locale),
      onHand: formatInt(r.on_hand_units, locale),
      soldShare: r.sold_share_bps === null ? null : formatBps(r.sold_share_bps, locale),
      stockedShare: r.stocked_share_bps === null ? null : formatBps(r.stocked_share_bps, locale),
      gap: r.gap_bps === null ? null : formatBps(Math.abs(r.gap_bps), locale),
      gapKey: r.gap_bps === null || r.gap_bps === 0 ? null : r.gap_bps > 0 ? "insights.gap.under" : "insights.gap.over",
    })),
  }));
}
