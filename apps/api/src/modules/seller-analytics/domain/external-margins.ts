import { SELLER_BREAKDOWNS, SELLER_METRICS } from "./series-registry";

/**
 * ADR-0052 decision 1: every additive shopper-gated breakdown declares the UNGATED metric equal to its column sum.
 * That metric is released at every grain, so the release treats the column sum as always published.
 * VERIFIED against the traffic query (`trafficBySource` counts `store_view` AND `view` events per source, and
 * `trafficTotals` exposes them as store_views and product_views), so the column sum of `seller.traffic.views` by source
 * is store_views + product_views: BOTH ungated metrics are declared. The spec text says only "the ungated view totals".
 */
export const EXTERNAL_MARGINS: Readonly<Record<string, { readonly dimension: string; readonly externalMetrics: readonly string[] }>> = {
  "seller.traffic.views": { dimension: "source", externalMetrics: ["seller.traffic.store_views", "seller.traffic.product_views"] },
  "seller.geography.orders": { dimension: "governorate", externalMetrics: ["seller.sales.orders"] },
};

/**
 * The FIXED dimension domain per breakdown (rows of every column, whatever the request filters or top-N). The hidden set
 * is only comparable to the public ungated total when rows span this whole domain. ASSUMPTION (flag): the source list
 * follows spec 19.1 and `unknown` (events without a source); governorates are Egypt's 27.
 */
export const DIMENSION_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  "seller.traffic.views": ["ad", "creator", "feed", "my_stores", "search", "shared_link", "stylist", "unknown"],
  "seller.geography.orders": [
    "alexandria", "aswan", "asyut", "beheira", "beni_suef", "cairo", "dakahlia", "damietta", "faiyum", "gharbia", "giza",
    "ismailia", "kafr_el_sheikh", "luxor", "matrouh", "minya", "monufia", "new_valley", "north_sinai", "port_said", "qalyubia",
    "qena", "red_sea", "sharqia", "sohag", "south_sinai", "suez",
  ],
};

export function dimensionDomain(metric: string): readonly string[] {
  const d = DIMENSION_DOMAINS[metric];
  if (d === undefined) throw new RangeError(`no dimension domain for ${metric}`);
  return d;
}

/** Problems found by the registry completeness check (empty = complete). */
export function externalMarginProblems(): readonly string[] {
  const problems: string[] = [];
  for (const [metric, dims] of Object.entries(SELLER_BREAKDOWNS)) {
    for (const d of dims) {
      const m = EXTERNAL_MARGINS[metric];
      if (m === undefined || m.dimension !== d) {
        problems.push(`${metric}/${d}: no external margin declared`);
        continue;
      }
      if (DIMENSION_DOMAINS[metric] === undefined) problems.push(`${metric}: no fixed dimension domain`);
      for (const id of m.externalMetrics) {
        const ext = SELLER_METRICS.find((x) => x.def.id === id);
        if (ext === undefined) problems.push(`${metric}: external metric ${id} not in registry`);
        else if (ext.gated || !ext.def.additive) problems.push(`${metric}: external metric ${id} must be ungated and additive`);
      }
    }
  }
  return problems;
}
