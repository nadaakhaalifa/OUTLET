/** Shared Arabic/Latin text normaliser (ADR-0010 shared layer). Pure; applied to queries and indexed text. */

const EASTERN = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Eastern Arabic and Persian digits to ASCII. */
export const toAsciiDigits = (s: string): string =>
  s.replace(/[٠-٩۰-۹]/g, (c) => {
    const e = EASTERN.indexOf(c);
    return String(e >= 0 ? e : PERSIAN.indexOf(c));
  });

const step = (input: string): string =>
  toAsciiDigits(input.normalize("NFKC"))
    .replace(/[ً-ٰٟـ]/g, "") // tashkeel + superscript alef + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/٬/g, ",")
    .replace(/٫/g, ".")
    .replace(/،/g, ",")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Folds alef variants, ya, ta-marbuta; strips tashkeel/tatweel; digits to ASCII; lowercases. Idempotent. */
export const normalizeArabic = (input: string): string => {
  let cur = step(input);
  for (let i = 0; i < 4; i += 1) {
    const next = step(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
};

/** Splits on anything that is not a letter or digit; "1,500" stays one token. */
export const tokenize = (input: string): string[] =>
  normalizeArabic(input)
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .split(/[^\p{L}\p{N}.]+/u)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length > 0);
