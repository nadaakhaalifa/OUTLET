/** Pure helpers shared by the chart kit (unit-tested in test/charts). */

/** Bar widths as 0-100 percentages of the largest value (min 2 so a real value never vanishes). */
export function barWidths(values: readonly number[]): number[] {
  const max = Math.max(0, ...values);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => (v <= 0 ? 0 : Math.max(2, (v / max) * 100)));
}

/** Sparkline bar heights as 0-1 of the tallest; a non-zero value never drops below `floor`. */
export function barHeights(values: readonly number[], floor = 0.08): number[] {
  const max = values.reduce((m, v) => Math.max(m, v), 0);
  if (max === 0) return values.map(() => 0);
  return values.map((v) => (v <= 0 ? 0 : Math.max(floor, v / max)));
}

/** Indexes to label directly on a column series: the highest value and the newest point (deduplicated, ascending). */
export function directLabelIndexes(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  let hi = 0;
  values.forEach((v, i) => {
    if (v > (values[hi] ?? 0)) hi = i;
  });
  if ((values[hi] ?? 0) <= 0) return [values.length - 1];
  return Array.from(new Set([hi, values.length - 1])).sort((a, b) => a - b);
}

export interface TableData {
  head: string[];
  rows: string[][];
}
