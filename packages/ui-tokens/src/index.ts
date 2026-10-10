export type ColorScheme = "light" | "dark";

export interface ColorTokens {
  readonly background: string;
  readonly surface: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly border: string;
  readonly accent: string;
  readonly onAccent: string;
  readonly danger: string;
  readonly onDanger: string;
}

export const colors: Readonly<Record<ColorScheme, ColorTokens>> = {
  light: {
    background: "#FFFFFF",
    surface: "#F6F5F3",
    textPrimary: "#16140F",
    textSecondary: "#5A564E",
    border: "#DDDAD3",
    accent: "#0F5C4D",
    onAccent: "#FFFFFF",
    danger: "#B3261E",
    onDanger: "#FFFFFF",
  },
  dark: {
    background: "#100F0D",
    surface: "#1B1A17",
    textPrimary: "#F4F2ED",
    textSecondary: "#B8B3A8",
    border: "#37342E",
    accent: "#5CC9AE",
    onAccent: "#07201A",
    danger: "#F2B8B5",
    onDanger: "#601410",
  },
};

/** 4pt grid. */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

export const typography = {
  title: { fontSize: 24, lineHeight: 32, fontWeight: "700" },
  heading: { fontSize: 18, lineHeight: 26, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "400" },
} as const;

/** Minimum touch target in points (Apple HIG, WCAG 2.2 target size). */
export const minTouchTarget = 44;
