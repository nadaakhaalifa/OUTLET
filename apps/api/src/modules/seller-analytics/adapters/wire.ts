import type { Freshness, Funnel, KAnonymized, MarkdownRecommendation, SalesSummary, SizeCurve } from "../domain/bridge";
import type {
  AgingReport,
  FunnelReport,
  Meta,
  ReturnsReportRow,
  SellThroughRow,
  SizeCurveReport,
  TrafficReport,
  WithMeta,
} from "../application/queries";
import type { GeoValue } from "../domain/ports";
import type { DashboardSummary, Growth, PeriodMetrics } from "../application/dashboard";

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const money = (v: bigint) => ({ amount_minor: v.toString(), currency: "EGP" as const });

function freshnessWire(f: Freshness) {
  return { as_of: iso(f.asOfMs), lag_ms: f.lagMs, slo_ms: f.sloMs, within_slo: f.withinSlo };
}
export function metaWire(m: Meta) {
  return {
    store_id: m.storeId,
    from: new Date(m.range.fromMs).toISOString(),
    to: new Date(m.range.toMs).toISOString(),
    freshness: freshnessWire(m.freshness),
    k_anonymity_min: 50,
  };
}

const funnelWire = (f: Funnel) => ({
  steps: f.steps.map((s) => ({
    stage: s.stage,
    count: s.count,
    from_previous_bps: s.fromPreviousBps,
    exceeds_previous: s.exceedsPrevious,
  })),
  overall_bps: f.overallBps,
});

/** Cells are released without their cell sizes; suppressed cells are only counted. */
const kWire = <V, W>(k: KAnonymized<V>, value: (v: V) => W) => ({
  items: k.released.map((c) => ({
    key: c.key,
    ...(value(c.value) as object),
    ...(c.includesSuppressed === true ? { includes_suppressed: true } : {}),
  })),
  suppressed_cells: k.suppressedCells,
});

const recommendationWire = (r: MarkdownRecommendation) => ({
  action: r.action,
  suggested_price: r.suggestedPriceMinor === null ? null : money(r.suggestedPriceMinor),
  step_bps: r.stepBps,
  basis: r.basis,
  shows_percent_off: r.showsPercentOff,
  notice: { en: r.notice.en, ar: r.notice.ar },
});

export const trafficWire = (r: WithMeta<TrafficReport>) => ({
  store_views: r.storeViews,
  product_views: r.productViews,
  unique_visitors: r.uniqueVisitors,
  unique_visitors_suppressed: r.uniqueVisitors === null,
  by_source: kWire(r.bySource, (events) => ({ events })),
  meta: metaWire(r.meta),
});

export const funnelReportWire = (r: WithMeta<FunnelReport>) => ({
  total: funnelWire(r.total),
  products: r.products.map((p) => ({ product_id: p.productId, ...funnelWire(p.funnel) })),
  meta: metaWire(r.meta),
});

export const salesWire = (r: WithMeta<{ summary: SalesSummary }>) => {
  const s = r.summary;
  return {
    gmv: money(s.gmvMinor),
    commission: money(s.commissionMinor),
    net: money(s.netMinor),
    units: s.units,
    orders: s.orders,
    aov: s.aovMinor === null ? null : money(s.aovMinor),
    repeat_rate_bps: s.repeatRateBps.suppressed ? null : s.repeatRateBps.value,
    repeat_rate_suppressed: s.repeatRateBps.suppressed,
    meta: metaWire(r.meta),
  };
};

export const sellThroughWire = (r: WithMeta<{ skus: readonly SellThroughRow[] }>) => ({
  skus: r.skus.map((s) => ({
    sku_id: s.skuId,
    product_id: s.productId,
    size: s.sizeLabel,
    sold_units: s.soldUnits,
    on_hand: s.onHand,
    sell_through_bps: s.sellThroughBps,
  })),
  meta: metaWire(r.meta),
});

const curveWire = (c: SizeCurve) => ({
  rows: c.rows.map((x) => ({
    size: x.size,
    sold_units: x.soldUnits,
    on_hand_units: x.onHandUnits,
    sold_share_bps: x.soldShareBps,
    stocked_share_bps: x.stockedShareBps,
    gap_bps: x.gapBps,
  })),
  total_sold: c.totalSold,
  total_stocked: c.totalStocked,
});

export const sizeCurveWire = (r: WithMeta<SizeCurveReport>) => ({
  products: r.products.map((p) => ({ product_id: p.productId, ...curveWire(p.curve) })),
  meta: metaWire(r.meta),
});

export const agingWire = (r: WithMeta<AgingReport>) => ({
  alerts: r.alerts.map((a) => ({
    sku_id: a.skuId,
    product_id: a.productId,
    size: a.sizeLabel,
    severity: a.severity,
    age_days: a.ageDays,
    on_hand: a.onHand,
    sell_through_bps: a.sellThroughBps,
    price: money(a.priceMinor),
    markdown_recommendation: recommendationWire(a.recommendation),
  })),
  meta: metaWire(r.meta),
});

export const returnsWire = (r: WithMeta<{ skus: readonly ReturnsReportRow[] }>) => ({
  skus: r.skus.map((s) => ({
    sku_id: s.skuId,
    product_id: s.productId,
    sold_units: s.soldUnits,
    returned_units: s.returnedUnits,
    return_rate_bps: s.returnRateBps,
    reasons: s.reasons,
  })),
  meta: metaWire(r.meta),
});

export const searchTermsWire = (r: WithMeta<{ terms: KAnonymized<number> }>) => ({
  terms: r.terms.released.map((c) => ({ term: c.key, clicks: c.value })),
  suppressed_terms: r.terms.suppressedCells,
  meta: metaWire(r.meta),
});

export const geographyWire = (r: WithMeta<{ governorates: KAnonymized<GeoValue> }>) => {
  const k = kWire(r.governorates, (v) => ({ orders: v.orders, gmv: money(v.gmvMinor) }));
  return {
    governorates: k.items.map((i) => {
      const { key, ...rest } = i;
      return { governorate: key, ...rest };
    }),
    suppressed_governorates: k.suppressed_cells,
    meta: metaWire(r.meta),
  };
};


const growthMoneyWire = (g: Growth) => ({ delta: money(g.delta), growth_bps: g.growthBps });
const growthCountWire = (g: Growth) => ({ delta: Number(g.delta), growth_bps: g.growthBps });

const periodMetricsWire = (m: PeriodMetrics) => ({
  gross_sales: money(m.grossSalesMinor),
  net_after_commission: money(m.netAfterCommissionMinor),
  orders: m.orders,
  units: m.units,
  average_order_value: m.aovMinor === null ? null : money(m.aovMinor),
  returned_units: m.returnedUnits,
  return_rate_bps: m.returnRateBps,
  repeat_customer_rate_bps: m.repeatRateBps,
  funnel: { views: m.funnel.views, bag_adds: m.funnel.bagAdds, checkouts: m.funnel.checkouts, purchases: m.funnel.purchases },
  top_products: m.topProducts.map((p) => ({ product_id: p.productId, units: p.units, gross_sales: money(p.grossMinor) })),
});

/** KPIs the dashboard cannot source from real events today: listed so a client never renders a zero in their place. */
export const DASHBOARD_UNAVAILABLE = [
  "net_sales_after_returns",
  "cancellation_rate",
  "cod_refusal_by_governorate",
  "in_transit_payouts",
] as const;

export const dashboardSummaryWire = (s: DashboardSummary) => ({
  store_id: s.storeId,
  period: s.period,
  currency: "EGP" as const,
  timezone: "Africa/Cairo" as const,
  current: { from: new Date(s.current.fromMs).toISOString(), to: new Date(s.current.toMs).toISOString(), partial: true, ...periodMetricsWire(s.currentMetrics) },
  previous: { from: new Date(s.previous.fromMs).toISOString(), to: new Date(s.previous.toMs).toISOString(), ...periodMetricsWire(s.previousMetrics) },
  growth: {
    gross_sales: growthMoneyWire(s.growth.grossSales),
    net_after_commission: growthMoneyWire(s.growth.netAfterCommission),
    orders: growthCountWire(s.growth.orders),
    units: growthCountWire(s.growth.units),
    average_order_value: s.growth.aov === null ? null : growthMoneyWire(s.growth.aov),
  },
  daily_sales: s.dailySales.map((d) => ({ day: d.day, gross_sales: money(d.grossMinor), orders: d.orders, units: d.units })),
  unavailable_metrics: DASHBOARD_UNAVAILABLE,
  definitions: {
    gross_sales: "Sum of purchase gross value (VAT-inclusive piastres) for orders placed in the period, before returns and commission.",
    net_after_commission: "Gross sales minus HAUL commission on those sales. Not net of returns (return value is not in analytics events) and not the payout statement.",
    return_rate: "Units returned in the period divided by units sold in the period (items sold before returns, as in Zalando ZEOS One), in basis points.",
    repeat_customer_rate: "Buyers with two or more orders in the period divided by distinct buyers in the period; null below 50 buyers.",
    funnel: "Consent-sampled client events (views, bag adds, checkouts) next to purchase facts; not a complete census.",
    growth: "(current - previous) / previous in half-even basis points; null when previous is 0.",
  },
  data_as_of: s.freshness.asOfMs === null ? null : new Date(s.freshness.asOfMs).toISOString(),
  freshness: freshnessWire(s.freshness),
  k_anonymity_min: 50,
});
