import type { ChartRow, FitProfile } from "./index";

export const TOPS: readonly ChartRow[] = [
  { sizeLabel: "XS", measurements: { bust_cm: 82, waist_cm: 64 } },
  { sizeLabel: "S", measurements: { bust_cm: 86, waist_cm: 68 } },
  { sizeLabel: "M", measurements: { bust_cm: 90, waist_cm: 72 } },
  { sizeLabel: "L", measurements: { bust_cm: 96, waist_cm: 78 } },
  { sizeLabel: "XL", measurements: { bust_cm: 102, waist_cm: 84 } },
];

export const profile = (over: Partial<FitProfile> = {}): FitProfile => ({
  measurements: { bust_cm: 86, waist_cm: 68 },
  fitPreference: "regular",
  modestFit: false,
  usualSizeLabel: null,
  ...over,
});
