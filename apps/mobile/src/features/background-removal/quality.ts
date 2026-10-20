/**
 * Mobile copy of the pure quality score in apps/api/src/modules/product-media/domain/quality.ts. Keep the two
 * byte-for-byte equivalent in behaviour: quality.parity.test.ts runs both against
 * tooling/media/bg-benchmark/fixtures/quality-cases.json.
 */
export interface MaskStats {
  readonly coverage: number;
  readonly borderTouch: number;
  readonly components: number;
  readonly holeRatio: number;
  readonly softEdgeRatio: number;
  readonly subjectBrightRatio: number;
  readonly borderBrightRatio: number;
}

export interface QualityAssessment {
  readonly score: number;
  readonly reasons: readonly string[];
  readonly whiteOnWhiteRisk: number;
}

export const READY_THRESHOLD = 70;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const finite = (n: number): number => (Number.isFinite(n) ? n : 0);

export function assessQuality(stats: MaskStats): QualityAssessment {
  const coverage = clamp(finite(stats.coverage), 0, 1);
  const border = clamp(finite(stats.borderTouch), 0, 1);
  const holes = clamp(finite(stats.holeRatio), 0, 1);
  const soft = clamp(finite(stats.softEdgeRatio), 0, 1);
  const whiteRisk = clamp(finite(stats.subjectBrightRatio), 0, 1) * clamp(finite(stats.borderBrightRatio), 0, 1);
  const reasons: string[] = [];
  let score = 100;

  if (coverage < 0.005) {
    return { score: 0, reasons: ["no_subject_detected"], whiteOnWhiteRisk: whiteRisk };
  }
  if (coverage < 0.05) {
    score -= 50;
    reasons.push("subject_too_small");
  } else if (coverage < 0.15) {
    score -= 20;
    reasons.push("subject_small");
  } else if (coverage > 0.95) {
    score -= 30;
    reasons.push("subject_fills_frame");
  }
  if (border > 0.15) {
    score -= 35;
    reasons.push("subject_cut_by_frame");
  } else if (border > 0.02) {
    score -= 20;
    reasons.push("subject_touches_border");
  }
  if (stats.components > 1) {
    score -= Math.min(30, 10 * (stats.components - 1));
    reasons.push("multiple_components");
  }
  if (holes > 0.1) {
    score -= 30;
    reasons.push("mask_holes");
  } else if (holes > 0.03) {
    score -= 15;
    reasons.push("mask_small_holes");
  }
  if (soft > 0.2) {
    score -= 25;
    reasons.push("soft_edges");
  } else if (soft > 0.08) {
    score -= 10;
    reasons.push("slightly_soft_edges");
  }
  if (whiteRisk > 0.5) {
    score -= 25;
    reasons.push("white_on_white_risk");
  } else if (whiteRisk > 0.25) {
    score -= 10;
    reasons.push("low_contrast_backdrop");
  }
  return { score: clamp(Math.round(score), 0, 100), reasons, whiteOnWhiteRisk: whiteRisk };
}

export const isReady = (a: QualityAssessment): boolean => a.score >= READY_THRESHOLD && !a.reasons.includes("no_subject_detected");
