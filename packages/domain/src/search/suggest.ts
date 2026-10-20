import { normalizeSearchText, tokenize } from "./arabic";
import { lexiconKey, vocabulary } from "./lexicon";

export function levenshtein(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length] ?? cap + 1;
}

const allowance = (len: number): number => (len <= 3 ? 0 : len <= 6 ? 1 : 2);

/**
 * "Did you mean": replaces tokens that are not in the vocabulary (lexicon plus caller extras such as
 * store names) by the nearest vocabulary term within an edit-distance allowance. Returns null when
 * nothing changed. Numbers and short tokens are never corrected.
 */
export function didYouMean(text: string, extraVocabulary: readonly string[] = []): string | null {
  const vocab = [...new Set([...vocabulary(), ...extraVocabulary.map(normalizeSearchText)])].filter((v) => v.length > 0);
  const known = new Set(vocab.map(lexiconKey));
  let changed = false;
  const out = tokenize(normalizeSearchText(text)).map((tok) => {
    if (/\d/u.test(tok) || known.has(lexiconKey(tok))) return tok;
    const cap = allowance(tok.length);
    if (cap === 0) return tok;
    let best: { v: string; d: number } | null = null;
    for (const v of vocab) {
      const d = levenshtein(tok, v, cap);
      if (d <= cap && (best === null || d < best.d)) best = { v, d };
    }
    if (best === null) return tok;
    changed = true;
    return best.v;
  });
  return changed ? out.join(" ") : null;
}
