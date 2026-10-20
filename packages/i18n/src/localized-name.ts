/** A bilingual name as it travels on the wire. Legacy rows may lack `en`; Arabic is always present. */
export interface LocalizedName {
  readonly ar: string;
  readonly en?: string | null | undefined;
}

function nonBlank(s: string | null | undefined): s is string {
  return s !== null && s !== undefined && s.trim().length > 0;
}

/**
 * The single display helper for bilingual names (products, stores, categories): the requested language
 * when present, else the other one, never blank unless both are blank. Pure; does not translate.
 */
export function localizedName(name: LocalizedName, locale: "ar" | "en"): string {
  const primary = locale === "en" ? name.en : name.ar;
  if (nonBlank(primary)) return primary;
  const other = locale === "en" ? name.ar : name.en;
  if (nonBlank(other)) return other;
  return primary ?? other ?? "";
}

/** True when the English name is absent or blank (legacy rows): drives the "English name missing" badge. */
export function isEnglishNameMissing(name: LocalizedName): boolean {
  return !nonBlank(name.en);
}
