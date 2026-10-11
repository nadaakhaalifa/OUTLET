import { colors, minTouchTarget, radius, spacing, typography, type ColorTokens } from "@outlet/ui-tokens";

const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const colorVars = (c: ColorTokens): string =>
  Object.entries(c)
    .map(([k, v]) => `--c-${kebab(k)}:${v};`)
    .join("");

/** CSS custom properties generated from @outlet/ui-tokens (single source). Dark follows the OS unless forced. */
export function tokensCss(): string {
  const base =
    Object.entries(spacing).map(([k, v]) => `--s-${k}:${v}px;`).join("") +
    Object.entries(radius).map(([k, v]) => `--r-${k}:${v}px;`).join("") +
    Object.entries(typography)
      .map(([k, t]) => `--t-${k}-size:${t.fontSize}px;--t-${k}-line:${t.lineHeight}px;--t-${k}-weight:${t.fontWeight};`)
      .join("") +
    `--target:${minTouchTarget}px;`;
  return [
    `:root{color-scheme:light dark;${base}${colorVars(colors.light)}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${colorVars(colors.dark)}}}`,
    `:root[data-theme="dark"]{${colorVars(colors.dark)}}`,
  ].join("\n");
}

/** WCAG 2.x relative luminance contrast ratio for two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
