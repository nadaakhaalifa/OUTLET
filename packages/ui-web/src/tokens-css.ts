import { colors, minTouchTarget, motion, radius, shadows, spacing, typography, type ColorTokens } from "@outlet/ui-tokens";

/** camelCase token key to kebab-case CSS name. */
export const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** `--<prefix><token>:<value>;` for every colour role. Seller uses "--c-", Admin uses "--". */
export function colorVars(c: ColorTokens, prefix: string): string {
  return Object.entries(c)
    .map(([k, v]) => `${prefix}${kebab(k)}:${v};`)
    .join("");
}

/** Calm motion from the shared tokens: fast, base and slow durations plus one eased curve. */
export function motionVars(): string {
  const [a, b, c, d] = motion.easing.standard;
  return `--ease:cubic-bezier(${a},${b},${c},${d});--d1:${motion.fast}ms;--d2:${motion.base}ms;--d3:${motion.slow}ms;`;
}

type Shadow = { shadowColor: string; shadowOpacity: number; shadowRadius: number; shadowOffset: { width: number; height: number } };

/** rgba() from a #RRGGBB token value. */
export const rgba = (hex: string, a: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export const boxShadow = (s: Shadow, dark: boolean): string =>
  `${s.shadowOffset.width}px ${s.shadowOffset.height}px ${s.shadowRadius}px ${
    dark ? rgba(colors.dark.scrim, Math.min(0.6, s.shadowOpacity * 4)) : rgba(s.shadowColor, s.shadowOpacity)
  }`;

/** Soft card shadows from the shared tokens; stronger black in dark so they stay visible. */
export function shadowVars(scheme: "light" | "dark"): string {
  const dark = scheme === "dark";
  return `--shadow-card:${boxShadow(shadows.card, dark)};--shadow-lift:${boxShadow(shadows.lift, dark)};`;
}

/** Seller-style stylesheet: `--c-*` colours, `--s-*` spacing, `--r-*` radii, `--t-*` type. Dark follows the OS unless forced. */
export function tokensCss(): string {
  const base =
    Object.entries(spacing).map(([k, v]) => `--s-${k}:${v}px;`).join("") +
    Object.entries(radius).map(([k, v]) => `--r-${k}:${v}px;`).join("") +
    Object.entries(typography)
      .map(([k, t]) => `--t-${k}-size:${t.fontSize}px;--t-${k}-line:${t.lineHeight}px;--t-${k}-weight:${t.fontWeight};`)
      .join("") +
    `--target:${minTouchTarget}px;` +
    motionVars();
  return [
    `:root{color-scheme:light dark;${base}${colorVars(colors.light, "--c-")}${shadowVars("light")}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${colorVars(colors.dark, "--c-")}${shadowVars("dark")}}}`,
    `:root[data-theme="dark"]{${colorVars(colors.dark, "--c-")}${shadowVars("dark")}}`,
  ].join("\n");
}

export { contrast } from "./contrast";
