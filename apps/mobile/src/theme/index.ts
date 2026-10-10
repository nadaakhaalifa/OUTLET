import { useColorScheme } from "react-native";
import { colors, type ColorTokens } from "@outlet/ui-tokens";

export function useColors(): ColorTokens {
  return colors[useColorScheme() === "dark" ? "dark" : "light"];
}
