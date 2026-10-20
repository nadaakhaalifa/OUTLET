/** Logical-direction helpers. Components use start/end style props; these cover glyphs and previews. */
export type ChevronDirection = "forward" | "back";
export type ChevronName = "chevron-forward" | "chevron-back";

/** The glyph for "toward the content's end". RTL mirrors it, so lists point left in Arabic. */
export function chevronName(isRTL: boolean, direction: ChevronDirection = "forward"): ChevronName {
  const forward = direction === "forward";
  return forward !== isRTL ? "chevron-forward" : "chevron-back";
}

export type ArrowName = "arrow-forward" | "arrow-back";
export function arrowName(isRTL: boolean, direction: ChevronDirection = "forward"): ArrowName {
  return (direction === "forward") !== isRTL ? "arrow-forward" : "arrow-back";
}

/**
 * When the requested layout direction differs from the native one (styleguide preview without an app reload),
 * wrap the subtree in a `direction` style so flex rows and start/end follow the preview. Null when they agree.
 */
export function previewDirection(isRTL: boolean, nativeIsRTL: boolean): "rtl" | "ltr" | null {
  return isRTL === nativeIsRTL ? null : isRTL ? "rtl" : "ltr";
}

/** Maps a logical edge to the physical one; for the rare absolute-position case that cannot use start/end. */
export function physicalEdge(edge: "start" | "end", isRTL: boolean): "left" | "right" {
  return (edge === "start") !== isRTL ? "left" : "right";
}

/** Scroll/carousel "progress" direction: +1 left-to-right, -1 right-to-left. */
export function inlineSign(isRTL: boolean): 1 | -1 {
  return isRTL ? -1 : 1;
}

const ARABIC_RANGE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LATIN_RANGE = /[A-Za-z\u00C0-\u024F]/;

/**
 * Writing direction for a run of text: the script of the content wins (Arabic letters -> rtl, Latin -> ltr),
 * and content with neither (digits, symbols) follows the app direction. Keeps an English label LTR even
 * inside an RTL screen, and Arabic RTL inside an LTR one.
 */
export function textWritingDirection(text: string, appIsRTL: boolean): "rtl" | "ltr" {
  for (const ch of text) {
    if (ARABIC_RANGE.test(ch)) return "rtl";
    if (LATIN_RANGE.test(ch)) return "ltr";
  }
  return appIsRTL ? "rtl" : "ltr";
}
