import type { MetricDef, SeriesNote } from "../../platform-metrics";

export interface SellerMetricDef {
  readonly def: MetricDef;
  /** Shopper-gated (k >= 50, Cairo grid presets, suppression memo): behind `release.seller_analytics.shopper_series` (DPO). */
  readonly gated: boolean;
  /** Needs a facts source the rollups cannot provide (exact facts, shopper keys): 503 metric_source_unconfigured until wired. */
  readonly needsFacts: boolean;
}

const CLIENT: readonly SeriesNote[] = ["consent_sampled"];
const sum = (id: string, metric: string, unit: MetricDef["unit"], notes: readonly SeriesNote[] = []): SellerMetricDef => ({
  def: { id, unit, additive: true, basis: "rollup", notes, calc: { kind: "sum", metric } },
  gated: false,
  needsFacts: false,
});

/** Seller metric registry v1 (closed enum `SellerMetricId`, spec section 4). */
export const SELLER_METRICS: readonly SellerMetricDef[] = [
  sum("seller.sales.gmv", "gmv_minor", "piastres"),
  sum("seller.sales.commission", "commission_minor", "piastres"),
  {
    def: { id: "seller.sales.net_after_commission", unit: "piastres", additive: true, basis: "rollup", notes: [], calc: { kind: "diff", a: "gmv_minor", b: "commission_minor" } },
    gated: false,
    needsFacts: false,
  },
  sum("seller.sales.orders", "orders", "count"),
  sum("seller.sales.units", "units", "count"),
  {
    def: { id: "seller.sales.aov", unit: "piastres", additive: false, basis: "rollup", notes: [], calc: { kind: "aov", num: "gmv_minor", den: "orders" } },
    gated: false,
    needsFacts: false,
  },
  sum("seller.traffic.store_views", "store_views", "count", CLIENT),
  sum("seller.traffic.product_views", "product_views", "count", CLIENT),
  sum("seller.funnel.impressions", "impressions", "count", CLIENT),
  sum("seller.funnel.views", "product_views", "count", CLIENT),
  sum("seller.funnel.saves", "saves", "count", CLIENT),
  sum("seller.funnel.bags", "bags", "count", CLIENT),
  sum("seller.funnel.checkouts", "checkouts", "count", CLIENT),
  sum("seller.funnel.purchases", "purchases", "count"),
  {
    def: { id: "seller.funnel.conversion_bps", unit: "bps", additive: false, basis: "rollup", notes: CLIENT, calc: { kind: "bps", num: "purchases", den: "product_views" } },
    gated: false,
    needsFacts: false,
  },
  sum("seller.returns.units", "returned_units", "count"),
  {
    def: { id: "seller.returns.rate_bps", unit: "bps", additive: false, basis: "exact_facts", notes: [], calc: { kind: "bps", num: "returned_units", den: "units" } },
    gated: false,
    needsFacts: true,
  },
  {
    def: { id: "seller.traffic.unique_visitors", unit: "distinct_shoppers", additive: false, basis: "exact_facts", notes: CLIENT, calc: { kind: "sum", metric: "unique_visitors" } },
    gated: true,
    needsFacts: true,
  },
  {
    def: { id: "seller.sales.repeat_rate_bps", unit: "bps", additive: false, basis: "exact_facts", notes: [], calc: { kind: "bps", num: "repeat_purchasers", den: "purchasers" } },
    gated: true,
    needsFacts: true,
  },
];

/** Breakdown series exist only for shopper-gated dimensions. */
export const SELLER_BREAKDOWNS: Readonly<Record<string, readonly ("source" | "governorate")[]>> = {
  "seller.traffic.views": ["source"],
  "seller.geography.orders": ["governorate"],
};

export const sellerMetric = (id: string): SellerMetricDef | undefined => SELLER_METRICS.find((m) => m.def.id === id);

/** The four tiles of the store-scoped summary (day grain). Net *payable* is not shown (ADR-0049 item 6, owner decision). */
export const SUMMARY_TILES = [
  "seller.sales.gmv",
  "seller.sales.orders",
  "seller.funnel.conversion_bps",
  "seller.sales.net_after_commission",
] as const;
