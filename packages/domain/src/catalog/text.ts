import type { Issue } from "./types";

const ARABIC_RANGES: readonly (readonly [number, number])[] = [
  [0x0620, 0x064a],
  [0x066e, 0x06d3],
  [0x06d5, 0x06d5],
  [0x06fa, 0x06ff],
  [0x0750, 0x077f],
  [0x08a0, 0x08ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff],
];

/** Code point is an Arabic-script letter (Arabic, Supplement, Extended-A, Presentation Forms-A/-B). */
export function isArabicLetterCode(cp: number): boolean {
  return ARABIC_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function containsArabicLetter(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isArabicLetterCode(cp)) return true;
  }
  return false;
}

/** C0/C1 controls (tab and newline only where allowed) and bidi override/isolate characters (spoofing). */
function isForbiddenCode(cp: number, allowNewlines: boolean): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return !allowNewlines;
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  return cp >= 0x2066 && cp <= 0x2069;
}

export function hasForbiddenCharacters(s: string, allowNewlines: boolean): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isForbiddenCode(cp, allowNewlines)) return true;
  }
  return false;
}

export interface TextRule {
  readonly pointer: string;
  readonly max: number;
  readonly requireArabic: boolean;
  readonly allowNewlines?: boolean;
}

/** Returns the issue for a single text value, or null when it is acceptable. */
export function checkText(value: string, rule: TextRule): Issue | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { pointer: rule.pointer, code: rule.requireArabic ? "arabic_text_required" : "invalid_value" };
  if (trimmed.length > rule.max) return { pointer: rule.pointer, code: "text_too_long" };
  if (hasForbiddenCharacters(trimmed, rule.allowNewlines === true)) return { pointer: rule.pointer, code: "text_invalid_characters" };
  if (rule.requireArabic && !containsArabicLetter(trimmed)) return { pointer: rule.pointer, code: "arabic_text_required" };
  return null;
}
