/** SYNTHETIC DEMO DATA. Deterministic arrays made up for the chart spike; they are not Z-OUTLET figures. */
export const DEMO_LABEL = "Demo data: synthetic, not real figures";

export const DAYS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "D14"] as const;
export const ORDERS = [120, 132, 101, 134, 190, 230, 210, 180, 195, 240, 260, 245, 280, 300] as const;
export const REFUNDS = [12, 9, 14, 10, 18, 22, 19, 15, 17, 21, 24, 20, 26, 27] as const;

export const FUNNEL = [
  { stage: "Impressions", count: 10000 },
  { stage: "Product views", count: 4200 },
  { stage: "Saves", count: 1500 },
  { stage: "Added to bag", count: 900 },
  { stage: "Checkout", count: 420 },
  { stage: "Purchase", count: 300 },
] as const;

export const WEEKDAYS = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"] as const;
export const DAYPARTS = ["00-04", "04-08", "08-12", "12-16", "16-20", "20-24"] as const;
/** Orders per weekday x daypart (row-major by weekday). */
export const HEAT: readonly (readonly number[])[] = WEEKDAYS.map((_, d) => DAYPARTS.map((__, h) => ((d * 7 + h * 13) % 17) * 3 + (h >= 3 ? 20 : 2)));

export const WATERFALL = [
  { label: "Gross", value: 1000, kind: "total" },
  { label: "Commission", value: -150, kind: "delta" },
  { label: "Refunds", value: -90, kind: "delta" },
  { label: "Adjustments", value: 30, kind: "delta" },
  { label: "Payout", value: 790, kind: "total" },
] as const;

export const SPARK = [4, 6, 5, 8, 9, 7, 11, 12, 10, 14] as const;

/** Deterministic pseudo-series with `n` points for the 5k-mark performance check. */
export function bigSeries(n: number): number[] {
  const out: number[] = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    v += ((i * 7919) % 13) - 6;
    out.push(v);
  }
  return out;
}

/** One-sentence English summary (trend, max, min, change). Spike page only; production summaries come from i18n. */
export function summarize(name: string, labels: readonly string[], values: readonly number[]): string {
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const at = (v: number): string => labels[values.indexOf(v)] ?? "";
  const dir = last > first ? "rose" : last < first ? "fell" : "was flat";
  return `${name} ${dir} from ${first} to ${last}; highest ${max} (${at(max)}), lowest ${min} (${at(min)}).`;
}

/** Heatmap summary computed from the data: the peak daypart per weekday, then how many weekdays share the most common peak. */
export function heatSummary(heat: readonly (readonly number[])[] = HEAT): string {
  const peaks = heat.map((row) => {
    let best = 0;
    row.forEach((v, h) => { if (v > (row[best] ?? -Infinity)) best = h; });
    return DAYPARTS[best] ?? "";
  });
  const counts = new Map<string, number>();
  for (const p of peaks) counts.set(p, (counts.get(p) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const detail = WEEKDAYS.map((w, i) => `${w} ${peaks[i]}`).join(", ");
  return `The busiest daypart is ${top} on ${n} of ${heat.length} weekdays (peak per weekday: ${detail}).`;
}
