import type { EvalThresholds } from "../domain/metrics";

/**
 * CI regression gate for the SYNTHETIC set only (see synthetic.ts). Set a little below the
 * deterministic baseline (recall@5 0.977, MRR 1.000) so a retrieval regression fails the build while float noise does not.
 * The production gate for enabling the feature per model version is the real Egyptian labelled set
 * (VR-P3-13): recall@K and coverage on that set are owner/data deliverables, not asserted here.
 */
export const SYNTHETIC_THRESHOLDS: EvalThresholds = { recallAtK: 0.93, mrr: 0.95, coverage: 1 };
export const SYNTHETIC_K = 5;
