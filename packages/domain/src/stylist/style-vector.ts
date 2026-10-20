export type FeedbackSignal = "like" | "dislike" | "swap_in" | "swap_out";

const WEIGHT: Readonly<Record<FeedbackSignal, number>> = { like: 1, swap_in: 1, dislike: -1, swap_out: -0.5 };
export const STYLE_LEARNING_RATE = 0.2;

const normalize = (v: readonly number[]): number[] => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? [...v] : v.map((x) => Math.round((x / n) * 1e6) / 1e6);
};

/**
 * Online style vector update (spec 11 Feedback): move toward liked items, away from disliked ones,
 * re-normalise. A dimension mismatch leaves the vector untouched rather than corrupting it.
 */
export function updateStyleVector(
  current: readonly number[] | null,
  itemEmbedding: readonly number[],
  signal: FeedbackSignal,
): number[] {
  if (itemEmbedding.length === 0) return current === null ? [] : [...current];
  const base = current === null ? new Array<number>(itemEmbedding.length).fill(0) : [...current];
  if (base.length !== itemEmbedding.length) return [...base];
  const w = WEIGHT[signal] * STYLE_LEARNING_RATE;
  return normalize(base.map((x, i) => x + w * (itemEmbedding[i] ?? 0)));
}
