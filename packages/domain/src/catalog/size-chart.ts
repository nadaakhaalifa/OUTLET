/**
 * Structure-only size chart validation hook (spec section 10, layer 1). Fit maths (confidence, bias,
 * latent size) belongs to the sizing module. This checks only that a chart is well formed and that every
 * measurement is non-decreasing from the smallest to the largest listed size.
 */
export interface SizeChartRow {
  readonly sizeLabel: string;
  /** Measurement name (for example `chest_cm`) to value in centimetres. */
  readonly measurements: Readonly<Record<string, number>>;
}

export type SizeChartIssueCode =
  | "empty"
  | "too_many_rows"
  | "duplicate_size_label"
  | "blank_size_label"
  | "no_measurements"
  | "measurement_set_mismatch"
  | "not_positive_finite"
  | "non_monotonic";

export interface SizeChartIssue {
  readonly row: number;
  readonly measurement?: string;
  readonly code: SizeChartIssueCode;
}

export const SIZE_CHART_MAX_ROWS = 40;
export const SIZE_CHART_MAX_MEASUREMENTS = 16;

export function validateSizeChartStructure(rows: readonly SizeChartRow[]): SizeChartIssue[] {
  const issues: SizeChartIssue[] = [];
  if (rows.length === 0) return [{ row: -1, code: "empty" }];
  if (rows.length > SIZE_CHART_MAX_ROWS) return [{ row: -1, code: "too_many_rows" }];
  const first = rows[0];
  const keys = first === undefined ? [] : Object.keys(first.measurements).sort();
  if (keys.length === 0 || keys.length > SIZE_CHART_MAX_MEASUREMENTS) return [{ row: 0, code: "no_measurements" }];
  const labels = new Set<string>();
  rows.forEach((r, i) => {
    const label = r.sizeLabel.trim().toLowerCase();
    if (label.length === 0) issues.push({ row: i, code: "blank_size_label" });
    else if (labels.has(label)) issues.push({ row: i, code: "duplicate_size_label" });
    labels.add(label);
    const rk = Object.keys(r.measurements).sort();
    if (rk.length !== keys.length || rk.some((k, j) => k !== keys[j])) {
      issues.push({ row: i, code: "measurement_set_mismatch" });
      return;
    }
    for (const k of keys) {
      const v = r.measurements[k];
      if (v === undefined || !Number.isFinite(v) || v <= 0) issues.push({ row: i, measurement: k, code: "not_positive_finite" });
    }
  });
  if (issues.length > 0) return issues;
  for (const k of keys) {
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1]?.measurements[k];
      const cur = rows[i]?.measurements[k];
      if (prev !== undefined && cur !== undefined && cur < prev) issues.push({ row: i, measurement: k, code: "non_monotonic" });
    }
  }
  return issues;
}
