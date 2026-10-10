import { createContext, useContext, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { type ColorScheme, type ColorTokens } from "@outlet/ui-tokens";
import { themeFor } from "./logic/palette";

interface ThemeValue { readonly scheme: ColorScheme; readonly colors: ColorTokens }
const ThemeContext = createContext<ThemeValue | null>(null);

/** Optional override; without it the system colour scheme is used. */
export function ThemeProvider(props: { scheme?: ColorScheme; children: ReactNode }) {
  const system = useColorScheme();
  const scheme: ColorScheme = props.scheme ?? (system === "dark" ? "dark" : "light");
  return <ThemeContext.Provider value={{ scheme, colors: themeFor(scheme) }}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  const system = useColorScheme();
  if (ctx) return ctx;
  const scheme: ColorScheme = system === "dark" ? "dark" : "light";
  return { scheme, colors: themeFor(scheme) };
}
