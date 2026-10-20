import type { MetricDef } from "./series";

export type AdminMetricAccess = "counts" | "money";
export interface AdminMetricDef {
  readonly def: MetricDef;
  readonly access: AdminMetricAccess;
  /** Needs a facts source that the rollup tables cannot provide (distinct stores): answers 503 metric_source_unconfigured until one is wired. */
  readonly needsFacts: boolean;
}

const sum = (id: string, metric: string, unit: "count" | "piastres", extra: Partial<MetricDef> = {}): MetricDef => ({
  id,
  unit,
  additive: true,
  basis: "rollup",
  notes: [],
  calc: { kind: "sum", metric },
  ...extra,
});

/** Admin metric registry v1: platform-wide, no shopper breakdowns, so no k-gate. Closed set. */
export const ADMIN_METRICS: readonly AdminMetricDef[] = [
  { def: sum("platform.orders.placed", "orders_placed", "count"), access: "counts", needsFacts: false },
  { def: sum("platform.seller_orders.placed", "seller_orders_placed", "count"), access: "counts", needsFacts: false },
  { def: sum("platform.orders.purchased", "orders_purchased", "count"), access: "counts", needsFacts: false },
  { def: sum("platform.units.purchased", "units_purchased", "count"), access: "counts", needsFacts: false },
  { def: sum("platform.gmv.purchased", "gmv_purchased_minor", "piastres"), access: "money", needsFacts: false },
  {
    def: { id: "platform.aov", unit: "piastres", additive: false, basis: "rollup", notes: [], calc: { kind: "aov", num: "gmv_purchased_minor", den: "orders_purchased" } },
    access: "money",
    needsFacts: false,
  },
  {
    def: { id: "platform.stores.with_purchase", unit: "count", additive: false, basis: "exact_facts", notes: [], calc: { kind: "sum", metric: "stores_with_purchase" } },
    access: "counts",
    needsFacts: true,
  },
];

export const adminMetric = (id: string): AdminMetricDef | undefined => ADMIN_METRICS.find((m) => m.def.id === id);
