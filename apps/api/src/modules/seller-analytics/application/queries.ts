import {
  agingAlerts,
  buildWatermarkedCsv,
  computeFunnel,
  freshnessOf,
  kAnonymize,
  kAnonymizeAdditive,
  snapToDays,
  recommendMarkdown,
  returnRateBps,
  sellThroughBps,
  sizeCurve,
  summarizeSales,
  type AgingAlert,
  type CsvCell,
  type Freshness,
  type Funnel,
  type KAnonymized,
  type MarkdownRecommendation,
  type SalesSummary,
  type SizeCurve,
} from "../domain/bridge";
import type { AnalyticsStore, AuditPort, GeoValue, Range } from "../domain/ports";

export interface QueryDeps {
  readonly store: AnalyticsStore;
  readonly audit: AuditPort;
  readonly clock: { nowMs(): number };
  /** Mints an unguessable per-export watermark. */
  readonly mintWatermark: () => string;
}

export const MAX_RANGE_MS = 366 * 86_400_000;
export class InvalidRangeError extends Error {
  constructor() {
    super("range must satisfy from < to and span at most 366 days");
    this.name = "InvalidRangeError";
  }
}
/**
 * Validates and SNAPS the window to whole UTC days (minimum granularity: one day). Sub-day or
 * second-sliding windows would otherwise let a caller difference two reports down to a few events.
 * Inherent limit (documented in spec): adjacent day windows can still be differenced; k-anonymity
 * protects each released cell, not the sequence of releases.
 */
export function assertRange(r: Range): Range {
  if (!Number.isFinite(r.fromMs) || !Number.isFinite(r.toMs)) throw new InvalidRangeError();
  if (!(r.fromMs < r.toMs) || r.toMs - r.fromMs > MAX_RANGE_MS) throw new InvalidRangeError();
  return snapToDays(r.fromMs, r.toMs);
}

export interface Meta {
  readonly storeId: string;
  readonly range: Range;
  readonly freshness: Freshness;
}
export type WithMeta<T> = T & { readonly meta: Meta };

export interface TrafficReport {
  readonly storeViews: number;
  readonly productViews: number;
  readonly uniqueVisitors: number;
  readonly bySource: KAnonymized<number>;
}
export interface FunnelReport {
  readonly total: Funnel;
  readonly products: readonly { readonly productId: string; readonly funnel: Funnel }[];
}
export interface SellThroughRow {
  readonly skuId: string;
  readonly productId: string;
  readonly sizeLabel: string;
  readonly soldUnits: number;
  readonly onHand: number;
  readonly sellThroughBps: number | null;
}
export interface SizeCurveReport {
  readonly products: readonly { readonly productId: string; readonly curve: SizeCurve }[];
}
export interface AgingReport {
  readonly alerts: readonly (AgingAlert & {
    readonly sizeLabel: string;
    readonly priceMinor: bigint;
    readonly recommendation: MarkdownRecommendation;
  })[];
}
export interface ReturnsReportRow {
  readonly skuId: string;
  readonly productId: string;
  readonly soldUnits: number;
  readonly returnedUnits: number;
  readonly returnRateBps: number | null;
  readonly reasons: readonly { readonly reason: string; readonly units: number }[];
}

export const REPORTS = ["sales", "funnel", "sell_through", "returns", "search_terms", "geography", "aging"] as const;
export type ReportName = (typeof REPORTS)[number];

export class SellerAnalyticsQueries {
  constructor(private readonly d: QueryDeps) {}

  private async meta(storeId: string, range: Range): Promise<Meta> {
    const f = await this.d.store.freshness(storeId);
    return {
      storeId,
      range,
      freshness: freshnessOf(f?.lastIngestMs ?? null, f?.lastEventMs ?? null, this.d.clock.nowMs()),
    };
  }

  async traffic(storeId: string, range: Range): Promise<WithMeta<TrafficReport>> {
    range = assertRange(range);
    const [t, src, meta] = await Promise.all([
      this.d.store.trafficTotals(storeId, range),
      this.d.store.trafficBySource(storeId, range),
      this.meta(storeId, range),
    ]);
    // Source buckets are released only when >= 50 distinct shoppers; suppressed cells are folded into the smallest
    // released cell so totals minus released cells is 0 (no differencing). Cell shopper counts are not returned.
    return { ...t, bySource: kAnonymizeAdditive(src, (a, b) => a + b), meta };
  }

  async funnel(storeId: string, range: Range, productId: string | null): Promise<WithMeta<FunnelReport>> {
    range = assertRange(range);
    const [rows, meta] = await Promise.all([this.d.store.funnelByProduct(storeId, range), this.meta(storeId, range)]);
    const picked = productId === null ? rows : rows.filter((r) => r.productId === productId);
    const sum = (k: keyof (typeof rows)[number]["counts"]) => picked.reduce((n, r) => n + r.counts[k], 0);
    return {
      total: computeFunnel({
        impression: sum("impression"),
        view: sum("view"),
        save: sum("save"),
        bag: sum("bag"),
        checkout: sum("checkout"),
        purchase: sum("purchase"),
      }),
      products: picked.map((r) => ({ productId: r.productId, funnel: computeFunnel(r.counts) })),
      meta,
    };
  }

  async sales(storeId: string, range: Range): Promise<WithMeta<{ summary: SalesSummary }>> {
    range = assertRange(range);
    const [t, meta] = await Promise.all([this.d.store.salesTotals(storeId, range), this.meta(storeId, range)]);
    return { summary: summarizeSales(t), meta };
  }

  async sellThrough(storeId: string, range: Range): Promise<WithMeta<{ skus: readonly SellThroughRow[] }>> {
    range = assertRange(range);
    const [stock, sales, meta] = await Promise.all([
      this.d.store.stockLevels(storeId),
      this.d.store.skuSales(storeId, range),
      this.meta(storeId, range),
    ]);
    const sold = new Map(sales.map((s) => [s.skuId, s.soldUnits]));
    return {
      skus: stock.map((s) => ({
        skuId: s.skuId,
        productId: s.productId,
        sizeLabel: s.sizeLabel,
        soldUnits: sold.get(s.skuId) ?? 0,
        onHand: s.onHand,
        sellThroughBps: sellThroughBps(sold.get(s.skuId) ?? 0, s.onHand),
      })),
      meta,
    };
  }

  async sizeCurve(storeId: string, range: Range, order: readonly string[]): Promise<WithMeta<SizeCurveReport>> {
    range = assertRange(range);
    const [stock, sales, meta] = await Promise.all([
      this.d.store.stockLevels(storeId),
      this.d.store.skuSales(storeId, range),
      this.meta(storeId, range),
    ]);
    const sold = new Map(sales.map((s) => [s.skuId, s.soldUnits]));
    const byProduct = new Map<string, { size: string; soldUnits: number; onHandUnits: number }[]>();
    for (const s of stock) {
      const rows = byProduct.get(s.productId) ?? [];
      rows.push({ size: s.sizeLabel, soldUnits: sold.get(s.skuId) ?? 0, onHandUnits: s.onHand });
      byProduct.set(s.productId, rows);
    }
    return {
      products: [...byProduct].sort(([a], [b]) => (a < b ? -1 : 1)).map(([productId, rows]) => ({ productId, curve: sizeCurve(rows, order) })),
      meta,
    };
  }

  async aging(storeId: string, range: Range): Promise<WithMeta<AgingReport>> {
    range = assertRange(range);
    const [stock, sales, meta] = await Promise.all([
      this.d.store.stockLevels(storeId),
      this.d.store.skuSales(storeId, range),
      this.meta(storeId, range),
    ]);
    const sold = new Map(sales.map((s) => [s.skuId, s.soldUnits]));
    const by = new Map(stock.map((s) => [s.skuId, s]));
    const alerts = agingAlerts(
      stock.map((s) => ({ skuId: s.skuId, productId: s.productId, onHand: s.onHand, listedAtMs: s.listedAtMs, soldUnits: sold.get(s.skuId) ?? 0 })),
      this.d.clock.nowMs(),
    );
    return {
      alerts: alerts.map((a) => {
        const s = by.get(a.skuId);
        const price = s?.priceMinor ?? 1n;
        return {
          ...a,
          sizeLabel: s?.sizeLabel ?? "",
          priceMinor: price,
          recommendation: recommendMarkdown({ currentPriceMinor: price, severity: a.severity, sellThroughBps: a.sellThroughBps }),
        };
      }),
      meta,
    };
  }

  async returns(storeId: string, range: Range): Promise<WithMeta<{ skus: readonly ReturnsReportRow[] }>> {
    range = assertRange(range);
    const [sales, reasons, meta] = await Promise.all([
      this.d.store.skuSales(storeId, range),
      this.d.store.returnReasons(storeId, range),
      this.meta(storeId, range),
    ]);
    return {
      skus: sales
        .filter((s) => s.returnedUnits > 0)
        .map((s) => ({
          skuId: s.skuId,
          productId: s.productId,
          soldUnits: s.soldUnits,
          returnedUnits: s.returnedUnits,
          returnRateBps: returnRateBps(s.returnedUnits, s.soldUnits),
          reasons: reasons.filter((r) => r.skuId === s.skuId).map((r) => ({ reason: r.reason, units: r.units })),
        })),
      meta,
    };
  }

  async searchTerms(storeId: string, range: Range): Promise<WithMeta<{ terms: KAnonymized<number> }>> {
    range = assertRange(range);
    const [cells, meta] = await Promise.all([this.d.store.searchTerms(storeId, range), this.meta(storeId, range)]);
    return { terms: kAnonymize(cells), meta };
  }

  async geography(storeId: string, range: Range): Promise<WithMeta<{ governorates: KAnonymized<GeoValue> }>> {
    range = assertRange(range);
    const [cells, meta] = await Promise.all([this.d.store.geography(storeId, range), this.meta(storeId, range)]);
    return { governorates: kAnonymizeAdditive(cells, (a, b) => ({ orders: a.orders + b.orders, gmvMinor: a.gmvMinor + b.gmvMinor })), meta };
  }

  /**
   * CSV export. Builds ONLY from the same privacy-filtered read models the dashboard uses, so the
   * export cannot reveal more than the API. The audit entry is written BEFORE the content is
   * returned; if the audit trail is unavailable the export fails closed.
   */
  async exportCsv(
    actorId: string,
    storeId: string,
    report: ReportName,
    range: Range,
  ): Promise<{ readonly filename: string; readonly csv: string; readonly watermark: string; readonly rowCount: number }> {
    range = assertRange(range);
    const { columns, rows } = await this.tabulate(storeId, report, range);
    const watermark = this.d.mintWatermark();
    const now = this.d.clock.nowMs();
    await this.d.audit.record({
      action: "seller_analytics.export",
      actorId,
      storeId,
      report,
      rowCount: rows.length,
      watermark,
      fromMs: range.fromMs,
      toMs: range.toMs,
      atMs: now,
    });
    const csv = buildWatermarkedCsv({
      sellerId: storeId,
      report,
      generatedAtIso: new Date(now).toISOString(),
      watermark,
      columns,
      rows,
    });
    return { filename: `seller-analytics-${report}-${storeId}.csv`, csv, watermark, rowCount: rows.length };
  }

  private async tabulate(
    storeId: string,
    report: ReportName,
    range: Range,
  ): Promise<{ columns: readonly string[]; rows: (readonly CsvCell[])[] }> {
    switch (report) {
      case "sales": {
        const { summary: s } = await this.sales(storeId, range);
        return {
          columns: ["gmv_minor", "commission_minor", "net_minor", "units", "orders", "aov_minor", "repeat_rate_bps"],
          rows: [[s.gmvMinor, s.commissionMinor, s.netMinor, s.units, s.orders, s.aovMinor, s.repeatRateBps.suppressed ? null : s.repeatRateBps.value]],
        };
      }
      case "funnel": {
        const f = await this.funnel(storeId, range, null);
        return {
          columns: ["product_id", "impression", "view", "save", "bag", "checkout", "purchase"],
          rows: f.products.map((p) => [p.productId, ...p.funnel.steps.map((x) => x.count)]),
        };
      }
      case "sell_through": {
        const r = await this.sellThrough(storeId, range);
        return {
          columns: ["sku_id", "product_id", "size", "sold_units", "on_hand", "sell_through_bps"],
          rows: r.skus.map((s) => [s.skuId, s.productId, s.sizeLabel, s.soldUnits, s.onHand, s.sellThroughBps]),
        };
      }
      case "returns": {
        const r = await this.returns(storeId, range);
        return {
          columns: ["sku_id", "product_id", "sold_units", "returned_units", "return_rate_bps", "reasons"],
          rows: r.skus.map((s) => [s.skuId, s.productId, s.soldUnits, s.returnedUnits, s.returnRateBps, s.reasons.map((x) => `${x.reason}:${x.units}`).join(";")]),
        };
      }
      case "search_terms": {
        const r = await this.searchTerms(storeId, range);
        return { columns: ["term", "clicks"], rows: r.terms.released.map((c) => [c.key, c.value]) };
      }
      case "geography": {
        const r = await this.geography(storeId, range);
        return { columns: ["governorate", "orders", "gmv_minor"], rows: r.governorates.released.map((c) => [c.key, c.value.orders, c.value.gmvMinor]) };
      }
      case "aging": {
        const r = await this.aging(storeId, range);
        return {
          columns: ["sku_id", "product_id", "severity", "age_days", "on_hand", "suggested_price_minor", "shows_percent_off"],
          rows: r.alerts.map((a) => [a.skuId, a.productId, a.severity, a.ageDays, a.onHand, a.recommendation.suggestedPriceMinor, false]),
        };
      }
    }
  }
}
