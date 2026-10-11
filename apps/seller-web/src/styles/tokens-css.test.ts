import { colors } from "@outlet/ui-tokens";
import { describe, expect, it } from "vitest";
import { contrast, tokensCss } from "./tokens-css";

describe("tokens", () => {
  it("emits light, dark-by-preference and forced-dark blocks", () => {
    const css = tokensCss();
    expect(css).toContain(":root{");
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("--c-text-primary:#16140F");
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
});
