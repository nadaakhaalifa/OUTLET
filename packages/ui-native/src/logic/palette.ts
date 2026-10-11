import { colors, type ColorScheme, type ColorTokens } from "@outlet/ui-tokens";

export type Tone = "info" | "warning" | "error";

export interface ToneColors {
  readonly background: string;
  readonly foreground: string;
  readonly border: string;
}

/**
 * ui-tokens has no info/warning tokens yet. These two are LOCAL to ui-native
 * and should move into @outlet/ui-tokens (owner: tokens package). Contrast is
 * unit-tested in palette.test.ts.
 */
const WARNING: Readonly<Record<ColorScheme, ToneColors>> = {
  light: { background: "#FFF4D6", foreground: "#4A3500", border: "#E0B84A" },
  dark: { background: "#3A2D05", foreground: "#FFE9A8", border: "#8A6D12" },
};

export function toneColors(tone: Tone, scheme: ColorScheme): ToneColors {
  const c = colors[scheme];
  switch (tone) {
    case "info":
      return { background: c.surface, foreground: c.textPrimary, border: c.accent };
    case "warning":
      return WARNING[scheme];
    case "error":
      return { background: c.surface, foreground: c.textPrimary, border: c.danger };
  }
}

export function themeFor(scheme: ColorScheme | null | undefined): ColorTokens {
  return colors[scheme === "dark" ? "dark" : "light"];
}
