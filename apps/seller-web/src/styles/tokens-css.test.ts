import { readFileSync } from "node:fs";
import { join } from "node:path";
import { colors, radius, shadows, motion, typography } from "@outlet/ui-tokens";
import { describe, expect, it } from "vitest";
import { contrast, tokensCss } from "./tokens-css";

describe("tokens", () => {
  it("emits every colour token of both schemes (kebab-cased) from @outlet/ui-tokens", () => {
    const css = tokensCss();
    const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    for (const scheme of ["light", "dark"] as const) {
      for (const [k, v] of Object.entries(colors[scheme])) expect(css, `${scheme}.${k}`).toContain(`--c-${kebab(k)}:${v};`);
    }
  });
  it("derives radii and soft card shadows from the tokens and leaves no v1 hex literal", () => {
    const css = tokensCss();
    expect(css).toContain(`--r-md:${radius.md}px`);
    expect(css).toContain(`--r-pill:${radius.pill}px`);
    expect(css).toContain(`--shadow-card:${shadows.card.shadowOffset.width}px ${shadows.card.shadowOffset.height}px ${shadows.card.shadowRadius}px`);
    expect(css).toContain("--shadow-lift:");
    for (const v1 of ["#6B1D2A", "#F7F3EB", "#0A0807"]) expect(css.toUpperCase()).not.toContain(v1);
  });

  it("emits light, dark-by-preference and forced-dark blocks", () => {
    const css = tokensCss();
    expect(css).toContain(":root{");
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain(`--c-text-primary:${colors.light.textPrimary}`);
  });
  it("emits every colour token in both schemes, including the brand set", () => {
    const css = tokensCss();
    for (const scheme of ["light", "dark"] as const) {
      const c = colors[scheme];
      for (const [name, value] of [["brand", c.brand], ["on-brand", c.onBrand], ["brand-soft", c.brandSoft]] as const) {
        expect(css).toContain(`--c-${name}:${value};`);
      }
    }
  });
  it("derives motion and display type from the tokens", () => {
    const css = tokensCss();
    expect(css).toContain(`--d1:${motion.fast}ms`);
    expect(css).toContain(`--d2:${motion.base}ms`);
    expect(css).toContain(`--t-display-size:${typography.display.fontSize}px`);
  });
  for (const scheme of ["light", "dark"] as const) {
    const c = colors[scheme];
    it(`${scheme}: text and control pairs meet WCAG AA (4.5:1)`, () => {
      expect(contrast(c.textPrimary, c.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.textPrimary, c.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.textSecondary, c.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.textSecondary, c.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.onAccent, c.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.onDanger, c.danger)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.accent, c.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.danger, c.background)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${scheme}: form control outlines use textSecondary (3:1 non-text contrast); border token is decorative only`, () => {
      expect(contrast(c.textSecondary, c.background)).toBeGreaterThanOrEqual(3);
      expect(contrast(c.textSecondary, c.surface)).toBeGreaterThanOrEqual(3);
      // Documented finding: ui-tokens `border` is below 3:1, so it must never be the only boundary of a control.
      expect(contrast(c.border, c.background)).toBeLessThan(3);
    });
  }
  it("web mark geometry is the same file as the mobile source of truth", () => {
    const mobile = readFileSync(join(__dirname, "../../../mobile/src/art/brand-geometry.ts"), "utf8");
    expect(readFileSync(join(__dirname, "../lib/brand-geometry.ts"), "utf8")).toBe(mobile);
  });
});
