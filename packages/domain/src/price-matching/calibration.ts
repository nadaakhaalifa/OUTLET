import { MIN_KAPPA_MILLI, MIN_LABELLED_PAIRS, TARGET_PRECISION_BP } from "./types";

/**
 * Calibration and threshold selection for the matcher (spec 08 tau tuning).
 * Options compared: (a) Platt/logistic scaling, (b) isotonic regression. Isotonic makes no shape
 * assumption and only needs monotonicity, which is what a hand-weighted raw score gives us; Platt
 * needs more data to be stable and cannot represent the plateau near the GTIN rung. Chosen: isotonic (PAVA).
 */

export interface LabelledScore {
  /** Uncalibrated raw score, 0..10000. */
  readonly rawBp: number;
  /** Ground truth: same product. */
  readonly same: boolean;
}

export interface IsotonicModel {
  /** Strictly increasing raw breakpoints with non-decreasing calibrated values (basis points). */
  readonly xs: readonly number[];
  readonly ys: readonly number[];
}

/** Pool-adjacent-violators on sorted raw scores. Output is a monotone step map in basis points. */
export function fitIsotonic(samples: readonly LabelledScore[]): IsotonicModel {
  const sorted = [...samples].sort((a, b) => a.rawBp - b.rawBp);
  interface Block { sum: number; n: number; xMax: number }
  const blocks: Block[] = [];
  for (const s of sorted) {
    blocks.push({ sum: s.same ? 1 : 0, n: 1, xMax: s.rawBp });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a === undefined || b === undefined || a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n, xMax: b.xMax });
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of blocks) {
    xs.push(b.xMax);
    ys.push(Math.round((b.sum / b.n) * 10_000));
  }
  return { xs, ys };
}

/** Step lookup: the calibrated value of the first block whose upper edge is >= raw; the last block above. */
export function applyIsotonic(model: IsotonicModel, rawBp: number): number {
  if (model.xs.length === 0) return rawBp;
  for (let i = 0; i < model.xs.length; i += 1) {
    const x = model.xs[i];
    if (x !== undefined && rawBp <= x) return model.ys[i] ?? 0;
  }
  return model.ys[model.ys.length - 1] ?? 0;
}

export interface PrecisionRecall {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  /** Basis points; 10000 when nothing is predicted positive. */
  readonly precisionBp: number;
  readonly recallBp: number;
}

/** Precision/recall of "confBp >= tau" over (calibrated confidence, truth) pairs. */
export function precisionRecall(pairs: readonly { readonly confBp: number; readonly same: boolean }[], tauBp: number): PrecisionRecall {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const p of pairs) {
    const pos = p.confBp >= tauBp;
    if (pos && p.same) tp += 1;
    else if (pos) fp += 1;
    else if (p.same) fn += 1;
  }
  const precisionBp = tp + fp === 0 ? 10_000 : Math.floor((tp * 10_000) / (tp + fp));
  const recallBp = tp + fn === 0 ? 0 : Math.floor((tp * 10_000) / (tp + fn));
  return { tp, fp, fn, precisionBp, recallBp };
}

export type TauChoice =
  | { readonly ok: true; readonly tauBp: number; readonly validation: PrecisionRecall }
  | { readonly ok: false; readonly reason: "no_threshold_reaches_precision" | "empty_validation_set" };

/**
 * The lowest threshold (so the highest recall) whose validation precision is at least `targetBp`.
 * Candidates are the distinct confidence values in the validation split.
 */
export function chooseTau(
  validation: readonly { readonly confBp: number; readonly same: boolean }[],
  targetBp: number = TARGET_PRECISION_BP,
): TauChoice {
  if (validation.length === 0) return { ok: false, reason: "empty_validation_set" };
  const candidates = [...new Set(validation.map((v) => v.confBp))].sort((a, b) => a - b);
  for (const tau of candidates) {
    const pr = precisionRecall(validation, tau);
    if (pr.tp > 0 && pr.precisionBp >= targetBp) return { ok: true, tauBp: tau, validation: pr };
  }
  return { ok: false, reason: "no_threshold_reaches_precision" };
}

export interface LabelSetStats {
  readonly pairs: number;
  /** Cohen's kappa of the two annotators, thousandths. */
  readonly kappaMilli: number;
}

/** External evidence may leave shadow mode only with a big enough, well-agreed labelled set (VR-13). */
export function labelledSetReady(s: LabelSetStats): boolean {
  return s.pairs >= MIN_LABELLED_PAIRS && s.kappaMilli >= MIN_KAPPA_MILLI;
}

/** Cohen's kappa for two binary annotators, in thousandths. Returns 0 when agreement is no better than chance. */
export function cohenKappaMilli(pairs: readonly { readonly a: boolean; readonly b: boolean }[]): number {
  const n = pairs.length;
  if (n === 0) return 0;
  let agree = 0;
  let aYes = 0;
  let bYes = 0;
  for (const p of pairs) {
    if (p.a === p.b) agree += 1;
    if (p.a) aYes += 1;
    if (p.b) bYes += 1;
  }
  const po = agree / n;
  const pe = (aYes / n) * (bYes / n) + (1 - aYes / n) * (1 - bYes / n);
  if (pe >= 1) return 1_000;
  return Math.max(0, Math.round(((po - pe) / (1 - pe)) * 1_000));
}
