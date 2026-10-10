export const MEASURE_KEYS = [
  "height_cm",
  "weight_kg",
  "bust_cm",
  "under_bust_cm",
  "waist_cm",
  "high_hip_cm",
  "hip_cm",
  "shoulders_cm",
  "sleeve_cm",
  "inseam_cm",
  "thigh_cm",
  "neck_cm",
  "foot_length_cm",
  "foot_width_cm",
] as const;
export type MeasureKey = (typeof MEASURE_KEYS)[number];

/** All values centimetres (weight in kg), rounded to 0.1. Every key is optional. */
export type Measurements = Partial<Record<MeasureKey, number>>;

export const FIT_PREFERENCES = ["snug", "regular", "loose"] as const;
export type FitPreference = (typeof FIT_PREFERENCES)[number];

export const STRETCH_LEVELS = ["none", "some", "high"] as const;
export type Stretch = (typeof STRETCH_LEVELS)[number];

export const FIT_RATINGS = ["too_small", "ok", "too_large"] as const;
export type FitRating = (typeof FIT_RATINGS)[number];

export type LengthUnit = "cm" | "in";

export interface ChartRow {
  readonly sizeLabel: string;
  readonly measurements: Measurements;
}

export type ItemTendency = "runs_small" | "true_to_size" | "runs_large" | "insufficient";

export interface ItemCounts {
  readonly nSmall: number;
  readonly nOk: number;
  readonly nLarge: number;
}

/** The user's own feedback in one brand. Never other users' data. */
export interface BrandHistory {
  readonly tooSmall: number;
  readonly tooLarge: number;
}
