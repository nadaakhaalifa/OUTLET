/**
 * PII scrubber (LLM02). Conservative: it over-redacts rather than risk letting a phone number,
 * email, national id or card number reach a vendor. Arabic-Indic digits are normalised first.
 */
const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_INDIC = "۰۱۲۳۴۵۶۷۸۹";

export function westernDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    const e = EXT_INDIC.indexOf(ch);
    out += a >= 0 ? String(a) : e >= 0 ? String(e) : ch;
  }
  return out;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const URL = /\b(?:https?:\/\/|www\.)\S+/giu;
/** Egyptian mobile (01x, +20 1x) and generic international numbers with separators. */
const PHONE = /(?<![\d])(?:\+?\d[\d\s().-]{7,}\d)(?![\d])/g;
const LONG_DIGITS = /\d{6,}/g;

export interface ScrubResult {
  readonly text: string;
  readonly redactions: number;
}

export function scrubPii(input: string): ScrubResult {
  let n = 0;
  const hit = (token: string) => () => {
    n++;
    return token;
  };
  let t = westernDigits(input);
  t = t.replace(EMAIL, hit("[email]"));
  t = t.replace(URL, hit("[link]"));
  t = t.replace(PHONE, hit("[number]"));
  t = t.replace(LONG_DIGITS, hit("[number]"));
  return { text: t, redactions: n };
}
