import { zoomedTextMetrics } from "./size-class";
import { fontFamilies, nativeTypography, type FontFace, type FontWeight, type TypeVariant } from "@outlet/ui-tokens";

export interface TextMetrics {
  readonly fontFamily: string | undefined;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly textTransform: "uppercase" | "none";
  readonly tabularNums: boolean;
}

/** Font family for a weight; undefined (system font) when fonts failed or have not loaded. */
export function fontFamilyFor(weight: FontWeight, arabic: boolean, fontsLoaded: boolean, face: FontFace = "text"): string | undefined {
  if (!fontsLoaded) return undefined;
  if (face === "display") return (arabic ? fontFamilies.displayArabic : fontFamilies.displayLatin)[weight];
  return (arabic ? fontFamilies.arabic : fontFamilies.latin)[weight];
}

/**
 * Reads the native density-v2 scale (`nativeTypography`).
 * Arabic: +10% line height (rounded to even), no letter spacing, no uppercase.
 * iPad: `zoom` > 1 is the zoom in force (logic/size-class.ts `zoomForWidth`); Dynamic Type is not faded.
 * Latin: tracked eyebrows are uppercase. Numeric text opts into tabular numerals.
 */
export function textMetrics(variant: TypeVariant, opts: { arabic: boolean; fontsLoaded: boolean; numeric?: boolean; weight?: FontWeight; zoom?: number }): TextMetrics {
  const t = nativeTypography[variant];
  // iPad zoom first (identity at z = 1), then the Arabic +10% rule on the zoomed leading.
  const z = zoomedTextMetrics(t, opts.zoom ?? 1);
  const lh = opts.arabic ? Math.round((z.lineHeight * 1.1) / 2) * 2 : z.lineHeight;
  return {
    fontFamily: fontFamilyFor(opts.weight ?? t.fontWeight, opts.arabic, opts.fontsLoaded, t.face),
    fontSize: z.fontSize,
    lineHeight: lh,
    letterSpacing: opts.arabic ? 0 : z.letterSpacing,
    textTransform: t.uppercase && !opts.arabic ? "uppercase" : "none",
    tabularNums: opts.numeric === true,
  };
}
