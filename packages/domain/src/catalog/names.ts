import type { Issue, LocalizedText } from "./types";
import { containsArabicLetter, hasForbiddenCharacters } from "./text";

/** Bilingual names are mandatory to publish (owner requirement: every item has an Arabic and an English name). */
export const NAME_LIMITS = { min: 2, max: 120 } as const;

const LATIN_LETTER = /\p{Script=Latin}/u;

function nonBlank(s: string | undefined): s is string {
  return s !== undefined && s.trim().length > 0;
}

/**
 * Read-time display name: the requested language, else the other, never blank unless both are.
 * Legacy rows keep their data; nothing is translated or backfilled.
 */
export function displayName(name: LocalizedText, locale: "ar" | "en"): string {
  const primary = locale === "en" ? name.en : name.ar;
  if (nonBlank(primary)) return primary.trim();
  const other = locale === "en" ? name.ar : name.en;
  return nonBlank(other) ? other.trim() : "";
}

export function isEnglishNameMissing(name: LocalizedText): boolean {
  return !nonBlank(name.en);
}

/** Blocking name issues for publish / activate. Empty means both names are acceptable. */
export function bilingualNameIssues(name: { readonly ar?: string | undefined; readonly en?: string | undefined }, pointer: string): Issue[] {
  const out: Issue[] = [];
  const ar = (name.ar ?? "").trim();
  const en = (name.en ?? "").trim();
  if (ar.length < NAME_LIMITS.min || !containsArabicLetter(ar) || hasForbiddenCharacters(ar, false)) {
    out.push({ pointer: `${pointer}/ar`, code: "title_ar_missing" });
  } else if (ar.length > NAME_LIMITS.max) {
    out.push({ pointer: `${pointer}/ar`, code: "text_too_long" });
  }
  if (en.length < NAME_LIMITS.min || !LATIN_LETTER.test(en) || containsArabicLetter(en) || hasForbiddenCharacters(en, false)) {
    out.push({ pointer: `${pointer}/en`, code: "title_en_missing" });
  } else if (en.length > NAME_LIMITS.max) {
    out.push({ pointer: `${pointer}/en`, code: "text_too_long" });
  }
  return out;
}
