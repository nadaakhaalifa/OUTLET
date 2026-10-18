import { colors, type ColorScheme, type ColorTokens } from "@outlet/ui-tokens";

export type Tone = "info" | "warning" | "error" | "success";

export interface ToneColors {
  readonly background: string;
  readonly foreground: string;
  readonly border: string;
}

export function toneColors(tone: Tone, scheme: ColorScheme): ToneColors {
  const c = colors[scheme];
  switch (tone) {
    case "info":
      return { background: c.fill, foreground: c.textPrimary, border: c.textSecondary };
    case "success":
      return { background: c.fill, foreground: c.textPrimary, border: c.savings };
    case "warning":
      return { background: c.plusSurface, foreground: c.onPlusSurface, border: c.plusBorder };
    case "error":
      return { background: c.fill, foreground: c.textPrimary, border: c.danger };
  }
}

export function themeFor(scheme: ColorScheme | null | undefined): ColorTokens {
  return colors[scheme === "dark" ? "dark" : "light"];
}
