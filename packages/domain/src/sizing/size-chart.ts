import { toCm, MEASURE_RANGES } from "./measurements";
import type { ChartRow, LengthUnit, MeasureKey, Measurements } from "./types";
import { MEASURE_KEYS } from "./types";

/** Measures a chart of a given product type must carry on every row. */
export const CHART_TEMPLATES: Readonly<Record<string, readonly MeasureKey[]>> = {
  tops: ["bust_cm", "waist_cm"],
  dresses: ["bust_cm", "waist_cm", "hip_cm"],
  bottoms: ["waist_cm", "hip_cm", "inseam_cm"],
  outerwear: ["bust_cm", "shoulders_cm", "sleeve_cm"],
  shoes: ["foot_length_cm"],
  kids_tops: ["height_cm", "bust_cm"],
};

/** Largest believable step between two neighbouring sizes of one measure, in cm. */
export const MAX_DELTA_CM: Readonly<Partial<Record<MeasureKey, number>>> = {
  bust_cm: 12,
  waist_cm: 12,
  hip_cm: 12,
  high_hip_cm: 12,
  under_bust_cm: 12,
  thigh_cm: 10,
  inseam_cm: 6,
  shoulders_cm: 5,
  sleeve_cm: 5,
  neck_cm: 4,
  foot_length_cm: 2.5,
  foot_width_cm: 1.5,
  height_cm: 20,
};

export const MAX_CHART_ROWS = 30;
export const SIZE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ./+-]{0,11}$/;

export type ChartErrorCode =
  | "unknown_product_type"
  | "unknown_measure"
  | "invalid_size_label"
  | "duplicate_size_label"
  | "missing_measure"
  | "out_of_range"
  | "not_monotonic"
  | "no_progress"
  | "delta_too_large"
  | "too_many_rows"
  | "empty_chart";

export interface ChartError {
  readonly sizeLabel: string;
  readonly code: ChartErrorCode;
}

export interface ChartInput {
  readonly productType: string;
  readonly unit: LengthUnit;
  readonly rows: readonly { readonly sizeLabel: string; readonly measurements: Readonly<Record<string, number>> }[];
}

export interface ChartValidation {
  readonly validated: boolean;
  /** Normalised to cm, same order as the input. */
  readonly rows: readonly ChartRow[];
  readonly errors: readonly ChartError[];
}

const KEY_SET: ReadonlySet<string> = new Set(MEASURE_KEYS);

/** Pure. Always returns a result (a chart that fails is a draft, spec section 10 failure handling). */
export function validateChart(input: ChartInput): ChartValidation {
  const errors: ChartError[] = [];
  const add = (sizeLabel: string, code: ChartErrorCode): void => {
    if (!errors.some((e) => e.sizeLabel === sizeLabel && e.code === code)) errors.push({ sizeLabel, code });
  };

  const rows: ChartRow[] = input.rows.map((r) => {
    const m: Partial<Record<MeasureKey, number>> = {};
    for (const [k, v] of Object.entries(r.measurements)) {
      if (!KEY_SET.has(k) || k === "weight_kg") {
        add(r.sizeLabel, "unknown_measure");
        continue;
      }
      if (!Number.isFinite(v)) {
        add(r.sizeLabel, "out_of_range");
        continue;
      }
      m[k as MeasureKey] = toCm(v, input.unit);
    }
    return { sizeLabel: r.sizeLabel, measurements: m };
  });

  if (rows.length === 0) {
    add("", "empty_chart");
    return { validated: false, rows, errors };
  }
  if (rows.length > MAX_CHART_ROWS) add("", "too_many_rows");

  const required = CHART_TEMPLATES[input.productType];
  if (required === undefined) add("", "unknown_product_type");

  const seen = new Set<string>();
  for (const r of rows) {
    if (!SIZE_LABEL.test(r.sizeLabel)) add(r.sizeLabel, "invalid_size_label");
    const key = r.sizeLabel.toLowerCase();
    if (seen.has(key)) add(r.sizeLabel, "duplicate_size_label");
    seen.add(key);
    for (const k of required ?? []) {
      if (r.measurements[k] === undefined) add(r.sizeLabel, "missing_measure");
    }
    for (const [k, v] of Object.entries(r.measurements) as [MeasureKey, number][]) {
      const range = MEASURE_RANGES[k];
      if (v < range.min || v > range.max) add(r.sizeLabel, "out_of_range");
    }
  }

  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1] as ChartRow;
    const cur = rows[i] as ChartRow;
    let progressed = false;
    for (const k of required ?? []) {
      const a = prev.measurements[k];
      const b = cur.measurements[k];
      if (a === undefined || b === undefined) continue;
      if (b < a) add(cur.sizeLabel, "not_monotonic");
      if (b > a) progressed = true;
      const max = MAX_DELTA_CM[k];
      if (max !== undefined && round(b - a) > max) add(cur.sizeLabel, "delta_too_large");
    }
    if (!progressed && !errors.some((e) => e.sizeLabel === cur.sizeLabel && e.code === "not_monotonic")) {
      add(cur.sizeLabel, "no_progress");
    }
  }

  return { validated: errors.length === 0, rows, errors };
}

const round = (x: number): number => Math.round(x * 10) / 10;

export function requiredMeasures(productType: string): readonly MeasureKey[] | null {
  return CHART_TEMPLATES[productType] ?? null;
}

export type { Measurements };
