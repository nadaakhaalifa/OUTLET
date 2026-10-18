// Layout decision for the entrance page (docs/specs/ipad-adaptation.md section 6A). Pure: no React, no react-native.
export type EntranceMode = "phone" | "band" | "split";

/** Effective width (window / zoom) from which the side-by-side split is used. */
export const SPLIT_MIN_EFFECTIVE = 640;
/** Effective width from which the brand panel is 50% instead of 42%. */
export const WIDE_PANEL_MIN_EFFECTIVE = 760;
/** Effective content width from which the band mode puts the two choice cards side by side. */
export const CARDS_SIDE_BY_SIDE_MIN_CONTENT = 500;

/** No orientation branch: size class (compact = phone) then effective width. Font scale never changes the mode (everything scrolls). */
export function entranceMode(sizeClass: "compact" | "regular" | "expanded", effectiveWidth: number): EntranceMode {
  if (sizeClass === "compact") return "phone";
  return effectiveWidth >= SPLIT_MIN_EFFECTIVE ? "split" : "band";
}

/** Brand panel share of the window width in split mode. */
export function panelShare(effectiveWidth: number): number {
  return effectiveWidth >= WIDE_PANEL_MIN_EFFECTIVE ? 0.5 : 0.42;
}

/** Band mode: cards side by side when the (effective) content width allows. */
export function cardsSideBySide(effectiveContentWidth: number): boolean {
  return effectiveContentWidth >= CARDS_SIDE_BY_SIDE_MIN_CONTENT;
}
