/** RTL helpers. Components use start/end style props; these cover icon mirroring. */
export type Direction = "ltr" | "rtl";

const RTL_LANGS = new Set(["ar", "he", "fa", "ur"]);

export function directionForLocale(locale: string): Direction {
  const base = locale.toLowerCase().split(/[-_]/)[0] ?? "";
  return RTL_LANGS.has(base) ? "rtl" : "ltr";
}

/** Directional glyphs (chevrons, back arrows) flip in RTL; others (play, check) do not. */
export function iconScaleX(direction: Direction, directional: boolean): 1 | -1 {
  return directional && direction === "rtl" ? -1 : 1;
}
