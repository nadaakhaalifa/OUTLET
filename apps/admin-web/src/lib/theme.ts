export const THEME_COOKIE = "admin-theme";
export type ThemeChoice = "light" | "dark" | "system";
export const THEME_CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"];

/** Unknown or missing cookie values mean "system" (follow the OS). */
export function parseTheme(value: string | null | undefined): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

/** The `data-theme` attribute value, or undefined to leave the media query in charge. */
export function themeAttr(choice: ThemeChoice): "light" | "dark" | undefined {
  return choice === "system" ? undefined : choice;
}
