import { normalizeLegalName } from "../payouts/iban";

export const NAME_MATCH_MIN_SCORE = 85;
const FUZZY_TOKEN_MIN = 0.8;

export type NameMatchEvidence =
  | { readonly kind: "exact"; readonly token: string }
  | { readonly kind: "fuzzy"; readonly holder: string; readonly legal: string; readonly similarity: number }
  | { readonly kind: "missing_from_holder"; readonly token: string }
  | { readonly kind: "extra_in_holder"; readonly token: string };

export interface NameMatchScore {
  /** 0 to 100. */
  readonly score: number;
  readonly decision: "match" | "mismatch";
  readonly evidence: readonly NameMatchEvidence[];
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j] ?? 0;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

const similarity = (a: string, b: string): number => {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 0 : 1 - levenshtein(a, b) / m;
};

/**
 * Explainable fuzzy match between an account-holder name and the legal name of the approved
 * application. Tokens are normalised (Arabic letter folding, company suffix words dropped), each legal
 * token is paired with its closest unused holder token (exact, or similarity >= 0.8 for typos and
 * transliteration slips), and the score is a Dice-style ratio. Short tokens (<= 3 chars) must match
 * exactly so initials cannot be fuzzed into each other. Fail closed: empty names score 0.
 */
export function scoreNameMatch(holderName: string, legalName: string): NameMatchScore {
  const holder = normalizeLegalName(holderName).split(" ").filter((t) => t.length > 0);
  const legal = normalizeLegalName(legalName).split(" ").filter((t) => t.length > 0);
  if (holder.length === 0 || legal.length === 0) {
    return { score: 0, decision: "mismatch", evidence: [] };
  }
  const evidence: NameMatchEvidence[] = [];
  const unusedHolder = new Set(holder);
  let matched = 0;
  for (const l of legal) {
    if (unusedHolder.has(l)) {
      unusedHolder.delete(l);
      matched += 1;
      evidence.push({ kind: "exact", token: l });
      continue;
    }
    let best: { token: string; sim: number } | null = null;
    if (l.length > 3) {
      for (const h of unusedHolder) {
        const sim = h.length > 3 ? similarity(l, h) : 0;
        if (sim >= FUZZY_TOKEN_MIN && (best === null || sim > best.sim)) best = { token: h, sim };
      }
    }
    if (best !== null) {
      unusedHolder.delete(best.token);
      matched += best.sim;
      evidence.push({ kind: "fuzzy", holder: best.token, legal: l, similarity: Math.round(best.sim * 100) / 100 });
    } else {
      evidence.push({ kind: "missing_from_holder", token: l });
    }
  }
  for (const h of unusedHolder) evidence.push({ kind: "extra_in_holder", token: h });
  const score = Math.round((100 * 2 * matched) / (holder.length + legal.length));
  return { score, decision: score >= NAME_MATCH_MIN_SCORE ? "match" : "mismatch", evidence };
}
