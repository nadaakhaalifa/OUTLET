import { InvalidSizingInputError } from "./errors";
import { MEASURE_KEYS, type LengthUnit, type MeasureKey, type Measurements } from "./types";

export interface Range {
  readonly min: number;
  readonly max: number;
}

/** Same ranges as the OpenAPI `Measurements` schema (inclusive). */
export const MEASURE_RANGES: Readonly<Record<MeasureKey, Range>> = {
  height_cm: { min: 30, max: 250 },
  weight_kg: { min: 2, max: 400 },
  bust_cm: { min: 20, max: 250 },
  under_bust_cm: { min: 20, max: 250 },
  waist_cm: { min: 20, max: 250 },
  high_hip_cm: { min: 20, max: 250 },
  hip_cm: { min: 20, max: 250 },
  shoulders_cm: { min: 10, max: 100 },
  sleeve_cm: { min: 10, max: 120 },
  inseam_cm: { min: 10, max: 150 },
  thigh_cm: { min: 10, max: 150 },
  neck_cm: { min: 10, max: 80 },
  foot_length_cm: { min: 5, max: 40 },
  foot_width_cm: { min: 2, max: 20 },
};

export type MeasurementErrorCode =
  | "unknown_key"
  | "not_a_number"
  | "out_of_range"
  | "exceeds_bust"
  | "exceeds_hip"
  | "implausible_bmi";

export interface MeasurementError {
  readonly key: string;
  readonly code: MeasurementErrorCode;
}

export type MeasurementsResult =
  | { readonly ok: true; readonly value: Measurements }
  | { readonly ok: false; readonly errors: readonly MeasurementError[] };

export const INCH_TO_CM = 2.54;

/** One decimal place. Used for every stored length so equal inputs give equal bytes. */
export const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Converts a length. Weight is never converted (the caller passes kg). */
export function toCm(value: number, unit: LengthUnit): number {
  if (!Number.isFinite(value)) throw new InvalidSizingInputError("length must be finite");
  return round1(unit === "in" ? value * INCH_TO_CM : value);
}

const KEY_SET: ReadonlySet<string> = new Set(MEASURE_KEYS);

/**
 * Validates and normalises a measurements object. `unit` applies to length keys only; `weight_kg`
 * is always kilograms. Never throws on bad data, it returns every error so a form can show them.
 */
export function normalizeMeasurements(input: Readonly<Record<string, unknown>>, unit: LengthUnit = "cm"): MeasurementsResult {
  const errors: MeasurementError[] = [];
  const out: Partial<Record<MeasureKey, number>> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!KEY_SET.has(key)) {
      errors.push({ key, code: "unknown_key" });
      continue;
    }
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      errors.push({ key, code: "not_a_number" });
      continue;
    }
    const k = key as MeasureKey;
    const v = k === "weight_kg" ? round1(raw) : toCm(raw, unit);
    const r = MEASURE_RANGES[k];
    if (v < r.min || v > r.max) {
      errors.push({ key, code: "out_of_range" });
      continue;
    }
    out[k] = v;
  }
  const { bust_cm, under_bust_cm, hip_cm, high_hip_cm, height_cm, weight_kg } = out;
  if (under_bust_cm !== undefined && bust_cm !== undefined && under_bust_cm > bust_cm) {
    errors.push({ key: "under_bust_cm", code: "exceeds_bust" });
  }
  if (high_hip_cm !== undefined && hip_cm !== undefined && high_hip_cm > hip_cm) {
    errors.push({ key: "high_hip_cm", code: "exceeds_hip" });
  }
  if (height_cm !== undefined && weight_kg !== undefined) {
    const m = height_cm / 100;
    const bmi = weight_kg / (m * m);
    if (bmi < 8 || bmi > 80) errors.push({ key: "weight_kg", code: "implausible_bmi" });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}
