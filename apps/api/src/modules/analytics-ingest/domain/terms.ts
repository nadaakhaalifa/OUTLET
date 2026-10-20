import { scrubPii } from "../../llm-gateway";

/**
 * Search term handling (M9). `term` is shopper free text, P2 as stored. No name heuristic exists in
 * the privacy module (finding F6) and a name blacklist cannot be complete for Arabic, English and
 * Franco-Arabic, so the rule is a vocabulary allow-list:
 *   1. normalise, then reject phone, email, URL and long digit shapes (same patterns as the LLM scrubber);
 *   2. a term whose every token is catalogue vocabulary is kept in clear (P1);
 *   3. any other term is kept only as a keyed hash and is never released as text;
 *   4. terms shorter than MIN_TERM_CHARS are dropped.
 */
export const MIN_TERM_CHARS = 3;
export const MAX_TERM_CHARS = 60;

export type TermDecision =
  | { readonly kind: "vocabulary"; readonly term: string }
  | { readonly kind: "hashed"; readonly termHash: string }
  | { readonly kind: "rejected"; readonly reason: "pii_shape" | "too_short" | "too_long" };

export function normaliseTerm(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function tokensOf(normalised: string): string[] {
  return normalised.split(/[\s,.;:!?()"'`-]+/u).filter((t) => t.length > 0);
}

export interface TermVocabulary {
  /** True only when EVERY token is a known catalogue word (category, attribute, brand, synonym; AR, EN, Franco). */
  allKnown(tokens: readonly string[]): Promise<boolean>;
}

export async function classifyTerm(
  raw: string,
  vocabulary: TermVocabulary,
  hash: (normalised: string) => string,
): Promise<TermDecision> {
  const t = normaliseTerm(raw);
  if (t.length < MIN_TERM_CHARS) return { kind: "rejected", reason: "too_short" };
  if (t.length > MAX_TERM_CHARS) return { kind: "rejected", reason: "too_long" };
  if (/[@/\\]|https?:|www\./i.test(t) || scrubPii(t).redactions > 0) return { kind: "rejected", reason: "pii_shape" };
  const tokens = tokensOf(t);
  if (tokens.length > 0 && tokens.length <= 6 && (await vocabulary.allKnown(tokens))) return { kind: "vocabulary", term: t };
  return { kind: "hashed", termHash: hash(t) };
}
