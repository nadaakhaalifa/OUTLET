/** Unicode bidi isolates (UAX #9): FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE. */
export const FSI = "⁨";
export const PDI = "⁩";

/**
 * Central i18next `interpolation.format` for Arabic. Every interpolated value (product name, store/title names, formatted
 * amounts, percentages, counts) is wrapped in an isolate so Latin text, digits and currency marks cannot reorder the
 * surrounding RTL punctuation. English is untouched. Already-isolated values are not wrapped twice.
 */
export function isolateInterpolation(value: unknown, _format: string | undefined, lng: string | undefined): string {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : value === null || value === undefined ? "" : String(value);
  if (lng !== "ar" || text === "" || text.startsWith(FSI)) return text;
  return `${FSI}${text}${PDI}`;
}
