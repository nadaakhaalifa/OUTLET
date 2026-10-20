import { useTheme } from "@outlet/ui-native";
import type { ColorTokens } from "@outlet/ui-tokens";

/** Semantic colours for the active scheme (light/dark, honouring the manual override). */
export function useColors(): ColorTokens {
  return useTheme().colors;
}

export { AppThemeProvider, THEME_PREFERENCE_KEY } from "./provider";
export { useAppFonts, type AppFonts } from "./fonts";
