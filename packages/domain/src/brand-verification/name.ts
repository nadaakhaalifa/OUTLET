/**
 * Brand-name normalisation and similarity (ADR-0031 decision 7). Pure functions.
 * Options compared: (a) edit distance only, (b) trigram Jaccard only, (c) Jaro-Winkler plus token-set
 * logic. Chose (c) for scoring because brand names are short, prefix-heavy and word-order varies
 * ("Nile Cotton" / "Cotton Nile"); trigram Jaccard is kept as the candidate filter and as a
 * second signal. All scores are integers 0..100 so results are deterministic and auditable.
 */

const ARABIC_DIGITS = /[٠-٩]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;

/** Arabic letter folding: tashkeel, tatweel, alef/ya/ta-marbuta/hamza variants, digits to ASCII. */
export function foldArabic(input: string): string {
  return input
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "") // harakat and Quranic marks
    .replace(/\u0640/g, "") // tatweel
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ک/g, "ك")
    .replace(/ی/g, "ي")
    .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Legal-form tokens removed from the END of a name (after folding), Latin and Arabic. */
const LEGAL_SUFFIX_TOKENS: ReadonlySet<string> = new Set([
  "llc", "ltd", "limited", "inc", "incorporated", "corp", "corporation", "co", "company", "gmbh", "ag", "sa", "sarl",
  "spa", "srl", "bv", "nv", "plc", "llp", "lp", "fze", "fzco", "fzc", "pte", "pty", "oy", "ab", "as", "kg", "sas", "eurl", "jsc", "ooo",
  "group", "holding", "holdings", "international", "intl", "egypt", "eg",
  // Arabic, folded
  "شركه", "المحدوده", "محدوده", "مساهمه", "ش", "م", "ذ", "ذم", "شم", "شمم", "شذمم", "مصر", "المصريه", "للتجاره", "والتوزيع",
]);
/** Tokens removed from the START of a name. */
const LEGAL_PREFIX_TOKENS: ReadonlySet<string> = new Set(["شركه", "مؤسسه", "موسسه", "the", "al", "ال"]);

function strip(tokens: readonly string[]): string[] {
  const out = [...tokens];
  while (out.length > 1 && LEGAL_SUFFIX_TOKENS.has(out[out.length - 1] as string)) out.pop();
  while (out.length > 1 && LEGAL_PREFIX_TOKENS.has(out[0] as string)) out.shift();
  return out;
}

/**
 * Canonical comparison form: NFKD, remove combining marks, lowercase, Arabic folding, "&" to "and",
 * punctuation to space, whitespace collapse, legal-form tokens stripped. Never returns an empty string
 * for a non-empty input (a name made only of legal tokens keeps its tokens).
 */
export function normaliseBrandName(input: string): string {
  const base = foldArabic(
    input
      .normalize("NFKD")
      .replace(/\p{M}/gu, "") // drop combining marks: Latin accents, Arabic hamza and harakat
      .toLowerCase()
      .replace(/&/g, " and "),
  );
  // Dotted initialisms ("S.A.S.", "ش.م.م") collapse to one token so legal-form suffixes strip.
  const joined = base.replace(/\b(\p{L})\.(?=\p{L}\b)/gu, "$1");
  const spaced = joined.replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  if (spaced === "") return "";
  const tokens = spaced.split(" ");
  const stripped = strip(tokens);
  // "and" glue words never discriminate a brand.
  // Peel repeatedly: "x & &" must reach the same fixed point as "x" or normalisation is not idempotent.
  let from = 0;
  let to = stripped.length;
  while (to - from > 1 && stripped[from] === "and") from += 1;
  while (to - from > 1 && stripped[to - 1] === "and") to -= 1;
  return stripped.slice(from, to).join(" ");
}

export function trigrams(input: string): ReadonlySet<string> {
  const padded = `  ${input} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/** pg_trgm-style Jaccard on trigrams, integer 0..100. */
export function trigramSimilarity(a: string, b: string): number {
  if (a === "" || b === "") return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : Math.round((inter * 100) / union);
}

/** Jaro-Winkler on code points, integer 0..100. */
export function jaroWinkler(a: string, b: string): number {
  const s1 = [...a];
  const s2 = [...b];
  if (s1.length === 0 && s2.length === 0) return 100;
  if (s1.length === 0 || s2.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array<boolean>(s1.length).fill(false);
  const m2 = new Array<boolean>(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i += 1) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(s2.length - 1, i + window);
    for (let j = lo; j <= hi; j += 1) {
      if (!m2[j] && s1[i] === s2[j]) {
        m1[i] = true;
        m2[j] = true;
        matches += 1;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i += 1) {
    if (!m1[i]) continue;
    while (!m2[k]) k += 1;
    if (s1[i] !== s2[k]) t += 1;
    k += 1;
  }
  const m = matches;
  const jaro = (m / s1.length + m / s2.length + (m - t / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < s1.length && prefix < s2.length && s1[prefix] === s2[prefix]) prefix += 1;
  return Math.round((jaro + prefix * 0.1 * (1 - jaro)) * 100);
}

const tokensOf = (n: string): string[] => (n === "" ? [] : n.split(" "));

export interface NameComparison {
  /** 0..100. */
  readonly score: number;
  /** Stable machine reasons, ordered. */
  readonly reasons: readonly NameMatchReason[];
}
export type NameMatchReason = "identical" | "token_set_equal" | "token_subset" | "high_jaro_winkler" | "high_trigram" | "no_overlap";

/** Compares two ALREADY NORMALISED names. Symmetric. */
export function compareNormalisedNames(a: string, b: string): NameComparison {
  if (a === "" || b === "") return { score: 0, reasons: ["no_overlap"] };
  if (a === b) return { score: 100, reasons: ["identical"] };
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  const reasons: NameMatchReason[] = [];
  let score = 0;
  const sa = [...ta].sort().join(" ");
  const sb = [...tb].sort().join(" ");
  if (sa === sb) {
    score = 98;
    reasons.push("token_set_equal");
  }
  const small = ta.length <= tb.length ? ta : tb;
  const big = new Set(ta.length <= tb.length ? tb : ta);
  if (small.length >= 1 && small.length < (ta.length <= tb.length ? tb : ta).length && small.every((t) => big.has(t))) {
    score = Math.max(score, small.length === 1 ? 80 : 88);
    reasons.push("token_subset");
  }
  const jw = jaroWinkler(a, b);
  if (jw >= 85) reasons.push("high_jaro_winkler");
  const tri = trigramSimilarity(a, b);
  if (tri >= 60) reasons.push("high_trigram");
  score = Math.max(score, Math.round((jw * 6 + tri * 4) / 10));
  if (reasons.length === 0) reasons.push("no_overlap");
  return { score: Math.min(100, score), reasons };
}

/** Raw-name convenience: normalise both sides first. */
export const compareBrandNames = (a: string, b: string): NameComparison =>
  compareNormalisedNames(normaliseBrandName(a), normaliseBrandName(b));

/** Thresholds shared by conflict detection and owner matching (config defaults, VERIFY with T&S). */
export const SAME_NAME_THRESHOLD = 95;
export const SIMILAR_NAME_THRESHOLD = 85;
