import { parseBudget } from "./budget.js";
import { levenshtein, transliterateFranco } from "./franco.js";
import { STOPWORDS, VARIANT_TO_GROUP, canonicalTerm } from "./lexicon.js";
import { normalizeArabic, tokenize } from "./normalize.js";

export interface QueryAnalysis {
  readonly input: string;
  readonly normalized: string;
  readonly maxPriceMinor?: bigint;
  /** Unique concept ids in order of appearance. */
  readonly concepts: readonly string[];
  /** Tokens the lexicon could not resolve (typos, unseen words), normalised. */
  readonly unknown: readonly string[];
  /** Order-independent form of the query: sorted concept ids, then unknown tokens. Used by `expected_normalized`. */
  readonly canonical: string;
  /** Text sent to every engine: canonical English term per concept, then unknown tokens. */
  readonly engineQuery: string;
}

export interface AnalyzeOptions {
  /** Resolve near-miss tokens against the lexicon (default true). The bake-off turns this off to measure engine typo tolerance. */
  readonly fuzzy?: boolean;
}

const VOCAB_SINGLE = [...VARIANT_TO_GROUP.keys()].filter((k) => !k.includes(" "));

type Resolved = { kind: "concept"; id: string } | { kind: "stop" };

const lookup = (key: string): Resolved | undefined => {
  const hit = VARIANT_TO_GROUP.get(key) ?? (key.startsWith("ال") ? VARIANT_TO_GROUP.get(key.slice(2)) : undefined);
  if (hit !== undefined) return { kind: "concept", id: hit };
  if (STOPWORDS.has(key)) return { kind: "stop" };
  return undefined;
};

const viaFranco = (key: string, allowFuzzy: boolean): Resolved | undefined => {
  for (const c of transliterateFranco(key)) {
    if (c.source === "rule") continue;
    if (c.source === "fuzzy" && !allowFuzzy) continue;
    const r = lookup(c.text);
    if (r !== undefined) return r;
  }
  return undefined;
};

const viaFuzzy = (key: string): Resolved | undefined => {
  if (key.length < 4 || /^\d+$/.test(key)) return undefined;
  const limit = key.length >= 8 ? 2 : 1;
  let best: { d: number; id: string } | undefined;
  for (const v of VOCAB_SINGLE) {
    if (Math.abs(v.length - key.length) > limit) continue;
    const d = levenshtein(v, key);
    const id = VARIANT_TO_GROUP.get(v);
    if (d <= limit && id !== undefined && (best === undefined || d < best.d)) best = { d, id };
  }
  return best === undefined ? undefined : { kind: "concept", id: best.id };
};

/** Greedy longest-match (3 to 1 tokens) over exact variants, Franco transliteration and optional fuzzy match. */
export const analyzeQuery = (input: string, options: AnalyzeOptions = {}): QueryAnalysis => {
  const fuzzy = options.fuzzy ?? true;
  const normalized = normalizeArabic(input);
  const budget = parseBudget(normalized);
  const tokens = tokenize(budget?.rest ?? normalized);
  const concepts: string[] = [];
  const unknown: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let consumed = 0;
    for (let n = Math.min(3, tokens.length - i); n >= 1 && consumed === 0; n -= 1) {
      const key = tokens.slice(i, i + n).join(" ");
      const r = lookup(key) ?? viaFranco(key, fuzzy) ?? (fuzzy && n === 1 ? viaFuzzy(key) : undefined);
      if (r === undefined) continue;
      consumed = n;
      if (r.kind === "concept" && !concepts.includes(r.id)) concepts.push(r.id);
    }
    if (consumed === 0) {
      const tok = tokens[i] ?? "";
      if (!/^\d+$/.test(tok) && !unknown.includes(tok)) unknown.push(tok);
      consumed = 1;
    }
    i += consumed;
  }
  const canonical = [...[...concepts].sort(), ...unknown].join(" ");
  const engineQuery = [...concepts.map(canonicalTerm), ...unknown].join(" ");
  return {
    input,
    normalized,
    ...(budget === null ? {} : { maxPriceMinor: budget.maxMinor }),
    concepts,
    unknown,
    canonical,
    engineQuery,
  };
};
