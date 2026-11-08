import { normalizeArabic } from "./normalize.js";
import type { SearchDoc } from "./port.js";

export interface Judgment {
  readonly queryId: string;
  /** Regex alternations (already normalised), e.g. "فستان|dress". A doc is relevant when ALL match its title. */
  readonly patterns: readonly string[];
  readonly grade: number;
  readonly source: "synthetic" | "labelled";
}

const compile = (p: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])(?:${p})(?![\\p{L}\\p{N}])`, "u");

export const isRelevant = (doc: SearchDoc, judgment: Judgment, maxPriceMinor?: number): boolean => {
  if (maxPriceMinor !== undefined && doc.priceMinor > maxPriceMinor) return false;
  const title = normalizeArabic(`${doc.titleAr} ${doc.titleEn}`);
  return judgment.patterns.every((p) => compile(normalizeArabic(p)).test(title));
};

/** nDCG@k with binary gain, used later once real graded labels exist; included so the harness can report it today. */
export const ndcgAtK = (rankedRelevant: readonly boolean[], totalRelevant: number, k = 10): number => {
  const dcg = rankedRelevant.slice(0, k).reduce((s, rel, i) => s + (rel ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(k, totalRelevant) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return ideal === 0 ? 0 : dcg / ideal;
};

export const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
};
