import { InvalidSizingInputError } from "./errors";
import type {
  BrandHistory,
  ChartRow,
  FitPreference,
  ItemCounts,
  ItemTendency,
  MeasureKey,
  Measurements,
  Stretch,
} from "./types";

/** Fit v1: ease-aware chart matching + item flags + the user's own brand history. Pure. */

export const MIN_ITEM_SAMPLE = 20;
export const NOT_SURE_BELOW = 0.6;
export const TIGHT_FACTOR = 3;
export const BETWEEN_SIZES_BAND_CM = 1.0;
export const HISTORY_MIN_NET = 2;
export const USUAL_SIZE_CONFIDENCE_CAP = 0.55;
export const USUAL_SIZE_BASE_CONFIDENCE = 0.4;

const CIRCUMFERENCE: ReadonlySet<MeasureKey> = new Set([
  "bust_cm",
  "under_bust_cm",
  "waist_cm",
  "high_hip_cm",
  "hip_cm",
  "thigh_cm",
]);

const EASE_CIRC: Readonly<Record<FitPreference, number>> = { snug: 0, regular: 4, loose: 10 };
const EASE_SHOULDER: Readonly<Record<FitPreference, number>> = { snug: 0, regular: 1, loose: 2 };
const EASE_FOOT: Readonly<Record<FitPreference, number>> = { snug: 0.5, regular: 1.0, loose: 1.5 };
const MODEST_EASE_CM = 4;
const STRETCH_CREDIT: Readonly<Record<Stretch, number>> = { none: 0, some: 2, high: 5 };

export const MEASURE_WEIGHTS: Readonly<Partial<Record<MeasureKey, number>>> = {
  bust_cm: 1.0,
  waist_cm: 1.0,
  hip_cm: 1.0,
  shoulders_cm: 0.6,
  sleeve_cm: 0.5,
  inseam_cm: 0.8,
  foot_length_cm: 1.5,
  height_cm: 0.8,
};
export const DEFAULT_WEIGHT = 0.5;

const weightOf = (k: MeasureKey): number => MEASURE_WEIGHTS[k] ?? DEFAULT_WEIGHT;

export interface ItemFlag {
  readonly n: number;
  readonly tendency: ItemTendency;
}

/** Beta-Binomial with a uniform Beta(1,1) prior. Below MIN_ITEM_SAMPLE the flag is `insufficient`. */
export function computeItemFlag(c: ItemCounts): ItemFlag {
  for (const v of [c.nSmall, c.nOk, c.nLarge]) {
    if (!Number.isInteger(v) || v < 0) throw new InvalidSizingInputError("counts must be non-negative integers");
  }
  const n = c.nSmall + c.nOk + c.nLarge;
  if (n < MIN_ITEM_SAMPLE) return { n, tendency: "insufficient" };
  const mSmall = (c.nSmall + 1) / (n + 2);
  const mLarge = (c.nLarge + 1) / (n + 2);
  if (mSmall >= 0.3 && mSmall - mLarge >= 0.15) return { n, tendency: "runs_small" };
  if (mLarge >= 0.3 && mLarge - mSmall >= 0.15) return { n, tendency: "runs_large" };
  return { n, tendency: "true_to_size" };
}

/** +1 means "go up a size". Needs a net of at least two events in the same brand. */
export function historyShift(h: BrandHistory): -1 | 0 | 1 {
  const net = h.tooSmall - h.tooLarge;
  if (net >= HISTORY_MIN_NET) return 1;
  if (net <= -HISTORY_MIN_NET) return -1;
  return 0;
}

export type ExplanationCode =
  | "not_sure"
  | "chart_match"
  | "usual_size_only"
  | "between_sizes_smaller"
  | "between_sizes_larger"
  | "item_runs_small"
  | "item_runs_large"
  | "history_too_small"
  | "history_too_large";

export interface Explanation {
  readonly code: ExplanationCode;
  /** Numbers and size labels only, no personal data. */
  readonly params: Readonly<Record<string, string | number>>;
}

export interface Alternative {
  readonly size: string;
  readonly direction: "smaller" | "larger";
}

export interface FitProfile {
  readonly measurements: Measurements;
  readonly fitPreference: FitPreference;
  readonly modestFit: boolean;
  readonly usualSizeLabel: string | null;
}

export interface FitInput {
  /** Validated chart rows in ascending size order, normalised to cm. At least one. */
  readonly rows: readonly ChartRow[];
  readonly profile: FitProfile;
  readonly stretch: Stretch;
  /** Community counters for this product and chart version, or null when none exist. */
  readonly itemCounts: ItemCounts | null;
  /** The user's own feedback in this brand, or null. */
  readonly history: BrandHistory | null;
}

export interface FitResult {
  readonly kind: "ok";
  readonly size: string;
  readonly index: number;
  readonly confidence: number;
  readonly notSure: boolean;
  readonly explanation: readonly Explanation[];
  readonly alternatives: readonly Alternative[];
  readonly communityFit: { readonly tendency: Exclude<ItemTendency, "insufficient">; readonly sampleSize: number } | null;
}

export type FitOutcome = FitResult | { readonly kind: "no_data" };

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round2 = (x: number): number => Math.round(x * 100) / 100;

function easeFor(key: MeasureKey, pref: FitPreference, modest: boolean, stretch: Stretch): number {
  if (CIRCUMFERENCE.has(key)) {
    return EASE_CIRC[pref] + (modest ? MODEST_EASE_CM : 0) - STRETCH_CREDIT[stretch];
  }
  if (key === "shoulders_cm") return EASE_SHOULDER[pref];
  if (key === "foot_length_cm") return EASE_FOOT[pref];
  if (key === "neck_cm") return 1;
  return 0;
}

interface RowScore {
  readonly index: number;
  readonly penalty: number;
}

function scoreRows(rows: readonly ChartRow[], p: FitProfile, stretch: Stretch): { scores: RowScore[]; coverage: number } {
  const first = rows[0] as ChartRow;
  const chartKeys = (Object.keys(first.measurements) as MeasureKey[]).filter(
    (k) => first.measurements[k] !== undefined,
  );
  const usable = chartKeys.filter((k) => p.measurements[k] !== undefined);
  if (usable.length === 0) return { scores: [], coverage: 0 };
  const totalW = chartKeys.reduce((s, k) => s + weightOf(k), 0);
  const usableW = usable.reduce((s, k) => s + weightOf(k), 0);
  const coverage = usableW / totalW;
  const scores = rows.map((row, index) => {
    let sum = 0;
    for (const k of usable) {
      const body = p.measurements[k] as number;
      const garment = row.measurements[k];
      if (garment === undefined) continue;
      const target = body + easeFor(k, p.fitPreference, p.modestFit, stretch);
      const gap = garment - target;
      let pen = gap < 0 ? TIGHT_FACTOR * -gap : gap;
      if (p.modestFit && gap < 0 && (k === "sleeve_cm" || k === "inseam_cm")) pen *= 2;
      sum += weightOf(k) * pen;
    }
    return { index, penalty: sum / usableW };
  });
  return { scores, coverage };
}

function betweenRule(p: FitProfile, stretch: Stretch): "smaller" | "larger" {
  if (p.modestFit) return "larger";
  if (p.fitPreference === "loose") return "larger";
  if (p.fitPreference === "snug") return "smaller";
  return stretch === "none" ? "larger" : "smaller";
}

export function recommendSize(input: FitInput): FitOutcome {
  const { rows, profile, stretch } = input;
  if (rows.length === 0) throw new InvalidSizingInputError("chart has no rows");
  const last = rows.length - 1;
  const explanation: Explanation[] = [];

  let baseIndex: number;
  /** Confidence before the evidence bonuses. */
  let baseConfidence: number;
  let usualOnly = false;

  const { scores, coverage: cov } = scoreRows(rows, profile, stretch);
  if (scores.length > 0) {
    const ranked = [...scores].sort((a, b) => a.penalty - b.penalty || a.index - b.index);
    const best = ranked[0] as RowScore;
    const second = ranked[1];
    baseIndex = best.index;
    explanation.push({ code: "chart_match", params: { size: (rows[best.index] as ChartRow).sizeLabel, penalty_cm: round2(best.penalty) } });
    let separation = 0.5;
    if (second !== undefined) {
      const margin = second.penalty - best.penalty;
      separation = Math.min(1, margin / 3);
      if (margin <= BETWEEN_SIZES_BAND_CM && Math.abs(second.index - best.index) === 1) {
        const lo = Math.min(best.index, second.index);
        const hi = Math.max(best.index, second.index);
        const dir = betweenRule(profile, stretch);
        baseIndex = dir === "smaller" ? lo : hi;
        explanation.push({
          code: dir === "smaller" ? "between_sizes_smaller" : "between_sizes_larger",
          params: { size: (rows[baseIndex] as ChartRow).sizeLabel, fit: profile.fitPreference },
        });
      }
    }
    const quality = 1 / (1 + best.penalty / 2);
    baseConfidence = 0.2 + 0.6 * cov * quality * (0.5 + 0.5 * separation);
  } else {
    const idx = profile.usualSizeLabel === null ? -1 : rows.findIndex((r) => r.sizeLabel === profile.usualSizeLabel);
    if (idx < 0) return { kind: "no_data" };
    baseIndex = idx;
    usualOnly = true;
    baseConfidence = USUAL_SIZE_BASE_CONFIDENCE;
    explanation.push({ code: "usual_size_only", params: { size: (rows[idx] as ChartRow).sizeLabel } });
  }

  // Signals from other people's feedback and from the user's own history.
  let itemShift = 0;
  let communityFit: FitResult["communityFit"] = null;
  let flagKnown = false;
  if (input.itemCounts !== null) {
    const flag = computeItemFlag(input.itemCounts);
    if (flag.tendency !== "insufficient") {
      flagKnown = true;
      communityFit = { tendency: flag.tendency, sampleSize: flag.n };
      if (flag.tendency === "runs_small") {
        itemShift = 1;
        explanation.push({ code: "item_runs_small", params: { n: flag.n } });
      } else if (flag.tendency === "runs_large") {
        itemShift = -1;
        explanation.push({ code: "item_runs_large", params: { n: flag.n } });
      }
    }
  }
  let histShift = 0;
  let historyKnown = false;
  if (input.history !== null) {
    histShift = historyShift(input.history);
    historyKnown = input.history.tooSmall + input.history.tooLarge >= HISTORY_MIN_NET;
    if (histShift === 1) explanation.push({ code: "history_too_small", params: { count: input.history.tooSmall } });
    if (histShift === -1) explanation.push({ code: "history_too_large", params: { count: input.history.tooLarge } });
  }
  const shift = clamp(itemShift + histShift, -1, 1);
  const index = clamp(baseIndex + shift, 0, last);

  const bonus = (flagKnown ? 0.1 : 0) + (historyKnown ? 0.1 : 0);
  let confidence = baseConfidence + bonus;
  if (usualOnly) confidence = Math.min(USUAL_SIZE_CONFIDENCE_CAP, confidence);
  confidence = round2(clamp(confidence, 0, 1));
  const notSure = confidence < NOT_SURE_BELOW;
  if (notSure) explanation.unshift({ code: "not_sure", params: {} });

  const alternatives: Alternative[] = [];
  if (index > 0) alternatives.push({ size: (rows[index - 1] as ChartRow).sizeLabel, direction: "smaller" });
  if (index < last) alternatives.push({ size: (rows[index + 1] as ChartRow).sizeLabel, direction: "larger" });

  return {
    kind: "ok",
    size: (rows[index] as ChartRow).sizeLabel,
    index,
    confidence,
    notSure,
    explanation,
    alternatives,
    communityFit,
  };
}
