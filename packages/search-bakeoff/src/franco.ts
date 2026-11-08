import { GROUPS } from "./lexicon.js";
import { normalizeArabic } from "./normalize.js";

export interface FrancoCandidate {
  readonly text: string;
  readonly confidence: number;
  readonly source: "dictionary" | "fuzzy" | "rule";
}

/** Function words that are not catalog concepts but appear in Franco queries. */
const EXTRAS: readonly (readonly [string, string])[] = [
  ["ta7t", "تحت"], ["ta7et", "تحت"], ["a2al", "اقل"], ["men", "من"], ["le7ad", "لحد"], ["la7ad", "لحد"],
  ["3ayez", "عايز"], ["3ayza", "عايزه"], ["3awez", "عاوز"], ["3awza", "عاوزه"], ["ma7tag", "محتاج"],
  ["ma7taga", "محتاجه"], ["gneh", "جنيه"], ["geneh", "جنيه"], ["fi", "في"], ["w", "و"],
];

export interface FrancoEntry {
  readonly franco: string;
  readonly arabic: string;
}

/** Dictionary: every Franco spelling in the lexicon (maps to the group's first Arabic form) plus function words. */
export const FRANCO_WORDS: readonly FrancoEntry[] = [
  ...EXTRAS.map(([franco, arabic]) => ({ franco, arabic: normalizeArabic(arabic) })),
  ...GROUPS.flatMap((g) => g.franco.map((f) => ({ franco: f.toLowerCase(), arabic: normalizeArabic(g.ar[0] ?? g.id) }))),
];

const DICT = new Map<string, string[]>();
for (const e of FRANCO_WORDS) {
  const list = DICT.get(e.franco) ?? [];
  if (!list.includes(e.arabic)) list.push(e.arabic);
  DICT.set(e.franco, list);
}

const DIGITS: Readonly<Record<string, string>> = {
  "2": "ء", "3": "ع", "5": "خ", "6": "ط", "7": "ح", "8": "غ", "9": "ص",
};
const DIGRAPHS: readonly (readonly [string, string])[] = [
  ["sh", "ش"], ["kh", "خ"], ["gh", "غ"], ["th", "ث"], ["ch", "تش"], ["ee", "ي"], ["oo", "و"], ["aa", "ا"],
];
const LETTERS: Readonly<Record<string, string>> = {
  b: "ب", t: "ت", g: "ج", j: "ج", d: "د", r: "ر", z: "ز", s: "س", f: "ف", k: "ك", q: "ق",
  l: "ل", m: "م", n: "ن", h: "ه", w: "و", y: "ي", p: "ب", v: "ف", c: "ك", x: "كس",
};
const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/** Rule-based transliteration; keepVowels renders internal vowels as long-vowel letters. */
const byRules = (word: string, keepVowels: boolean): string => {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const two = word.slice(i, i + 2);
    const digraph = DIGRAPHS.find(([k]) => k === two);
    const ch = word.charAt(i);
    if (digraph !== undefined && !(VOWELS.has(ch) && !keepVowels)) {
      out += digraph[1];
      i += 2;
      continue;
    }
    const digit = DIGITS[ch];
    const letter = LETTERS[ch];
    if (digit !== undefined) out += digit;
    else if (letter !== undefined) out += letter;
    else if (VOWELS.has(ch)) {
      const initial = i === 0;
      const final = i === word.length - 1;
      if (initial) out += ch === "o" || ch === "u" ? "و" : "ا";
      else if (final) out += ch === "a" ? "ه" : ch === "e" || ch === "i" ? "ي" : "و";
      else if (keepVowels) out += ch === "a" ? "ا" : ch === "o" || ch === "u" ? "و" : "ي";
    } else if (/\p{L}|\p{N}/u.test(ch)) out += ch;
    i += 1;
  }
  return out;
};

export const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
};

/**
 * Franco-Arabic transliteration candidates, best first. Dictionary hits (0.95), then dictionary words one edit
 * away (0.7, for typos), then rule-based guesses (0.35 vowels dropped, 0.25 vowels kept).
 */
export const transliterateFranco = (token: string): FrancoCandidate[] => {
  const word = token.trim().toLowerCase();
  if (word.length === 0 || /^\d+$/.test(word) || /\p{Script=Arabic}/u.test(word)) return [];
  const out: FrancoCandidate[] = [];
  const push = (text: string, confidence: number, source: FrancoCandidate["source"]): void => {
    const t = normalizeArabic(text);
    if (t.length > 0 && !out.some((c) => c.text === t)) out.push({ text: t, confidence, source });
  };
  for (const a of DICT.get(word) ?? []) push(a, 0.95, "dictionary");
  if (out.length === 0 && word.length >= 4) {
    for (const [k, arabics] of DICT) {
      if (Math.abs(k.length - word.length) <= 1 && levenshtein(k, word) === 1) for (const a of arabics) push(a, 0.7, "fuzzy");
    }
  }
  push(byRules(word, false), 0.35, "rule");
  push(byRules(word, true), 0.25, "rule");
  return out.sort((x, y) => y.confidence - x.confidence);
};
