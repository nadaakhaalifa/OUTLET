/**
 * Geometry for vertical (optionally stacked) column charts and histograms. Pure: unit-tested in
 * test/charts/columnsModel.test.ts. Heights are 0-100 percentages of the plot; the y domain always starts
 * at zero. In right-to-left locales a time axis runs right to left (`mirror`).
 */
import { niceTicks } from "./scale";

export interface ColumnInput {
  label: string;
  /** One value per series, bottom to top. */
  values: readonly number[];
}

export interface ColumnSegment {
  series: number;
  value: number;
  /** Height as a percentage of the plot. */
  heightPct: number;
}

export interface ColumnModel {
  empty: boolean;
  yTicks: { value: number; yPct: number }[];
  columns: {
    index: number;
    label: string;
    total: number;
    totalPct: number;
    segments: ColumnSegment[];
  }[];
  xLabels: { index: number; label: string }[];
}

export function columnsModel(
  input: readonly ColumnInput[],
  opts: { mirror: boolean; maxLabels?: number } = { mirror: false },
): ColumnModel {
  const totals = input.map((c) => c.values.reduce((a, b) => a + Math.max(0, b), 0));
  const max = Math.max(0, ...totals);
  const { domain, ticks } = niceTicks(0, max, 4);
  const top = domain[1] || 1;
  const ordered = input.map((c, index) => ({ c, index }));
  if (opts.mirror) ordered.reverse();
  const columns = ordered.map(({ c, index }) => ({
    index,
    label: c.label,
    total: totals[index] ?? 0,
    totalPct: ((totals[index] ?? 0) / top) * 100,
    segments: c.values.map((value, series) => ({
      series,
      value,
      heightPct: (Math.max(0, value) / top) * 100,
    })),
  }));
  const every = Math.max(1, Math.ceil(input.length / (opts.maxLabels ?? 6)));
  return {
    empty: max === 0,
    yTicks: ticks.map((value) => ({ value, yPct: 100 - (value / top) * 100 })),
    columns,
    xLabels: columns
      .map((col, pos) => ({ index: col.index, label: col.label, pos }))
      .filter((l) => l.pos % every === 0),
  };
}

/** Group `values` into at most `slots` consecutive buckets by summing (for sparse daily series). */
export function bucketSum(values: readonly number[], slots: number): number[][] {
  if (values.length === 0) return [];
  const size = Math.max(1, Math.ceil(values.length / Math.max(1, slots)));
  const out: number[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
