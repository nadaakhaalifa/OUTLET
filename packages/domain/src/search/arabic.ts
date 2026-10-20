/**
 * Pure Arabic and Latin search-text normalization (spec 4). No I/O, no locale APIs.
 * `normalizeSearchText` iterates a single pass to a fixed point, so it is idempotent by construction.
 */

const EASTERN_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Harakat, superscript alef, Quranic annotation marks. */
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/gu;
const TATWEEL = /ـ/gu;
const ALEF_VARIANTS = /[آأإٱ]/gu;
const YA_VARIANTS = /[ىیې]/gu;
const HAMZA_ON_YA = /ئ/gu;
const HAMZA_ON_WAW = /ؤ/gu;
const KAF_PERSIAN = /ک/gu;
const TA_MARBUTA = /ة/gu;
const NOT_WORD = /[^\p{L}\p{N}\s.,]/gu;
const SPACES = /\s+/gu;

/** Maps Eastern Arabic-Indic and Persian digits to ASCII; leaves everything else untouched. */
export function normalizeDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const e = EASTERN_DIGITS.indexOf(ch);
    if (e >= 0) {
      out += String(e);
      continue;
    }
    const p = PERSIAN_DIGITS.indexOf(ch);
    out += p >= 0 ? String(p) : ch;
  }
  return out;
}

function pass(input: string): string {
  return normalizeDigits(input.normalize("NFKC").toLowerCase())
    .replace(DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(ALEF_VARIANTS, "ا")
    .replace(YA_VARIANTS, "ي")
    .replace(HAMZA_ON_YA, "ي")
    .replace(HAMZA_ON_WAW, "و")
    .replace(KAF_PERSIAN, "ك")
    .replace(TA_MARBUTA, "ه")
    .replace(/،/gu, ",")
    .replace(/٫/gu, ".")
    .replace(/٬/gu, ",")
    .replace(NOT_WORD, " ")
    .replace(SPACES, " ")
    .trim();
}

const MAX_PASSES = 4;

export function normalizeSearchText(input: string): string {
  let cur = pass(input);
  for (let i = 0; i < MAX_PASSES; i += 1) {
    const next = pass(cur);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** Splits normalized text into tokens, trimming stray separators ("1,500." keeps 1,500). */
export function tokenize(normalized: string): string[] {
  return normalized
    .split(" ")
    .map((t) => t.replace(/^[.,]+|[.,]+$/gu, ""))
    .filter((t) => t.length > 0);
}
