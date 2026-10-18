import { readFileSync } from "node:fs";
import { join } from "node:path";
import { colors, motion, radius, shadows, typography } from "@outlet/ui-tokens";
import { describe, expect, it } from "vitest";
import { MONOGRAM_Z, wordmarkGeometry } from "../lib/brand-geometry";
import { STYLES } from "./styles";

const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

describe("admin stylesheet derives from @outlet/ui-tokens", () => {
  it("emits every colour token for both schemes (brand, onBrand, brandSoft included)", () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const [k, v] of Object.entries(colors[scheme])) expect(STYLES, `${scheme}.${k}`).toContain(`--${kebab(k)}:${v};`);
    }
  });
  it("derives radii and soft shadows from the tokens and has no v1 hex literal", () => {
    expect(STYLES).toContain(`--r-md:${radius.md}px`);
    expect(STYLES).toContain(`--r-pill:${radius.pill}px`);
    expect(STYLES).toContain(`--shadow-card:${shadows.card.shadowOffset.width}px ${shadows.card.shadowOffset.height}px ${shadows.card.shadowRadius}px`);
    for (const v1 of ["#6B1D2A", "#F7F3EB", "#0A0807"]) expect(STYLES.toUpperCase()).not.toContain(v1);
  });
  it("uses the token motion durations, display type and local serif fonts", () => {
    expect(STYLES).toContain(`--d1:${motion.fast}ms`);
    expect(STYLES).toContain(`--d2:${motion.base}ms`);
    expect(STYLES).toContain(`font-size:${typography.display.fontSize}px`);
    expect(STYLES).toContain('/fonts/PlayfairDisplay_400Regular.ttf');
    expect(STYLES).toContain('/fonts/Amiri_400Regular.ttf');
    expect(STYLES).not.toMatch(/url\(["']?https?:/);
  });
  it("keeps CSP-safe: no inline style attributes in the shared mark, reduced-motion honoured", () => {
    expect(STYLES).toContain("prefers-reduced-motion:reduce");
    expect(readFileSync(join(__dirname, "../components/identity-mark.tsx"), "utf8")).not.toMatch(/\bstyle=/);
  });
  it("mark geometry matches the mobile source of truth", () => {
    const mobile = readFileSync(join(__dirname, "../../../mobile/src/art/brand-geometry.ts"), "utf8");
    expect(mobile).toContain(MONOGRAM_Z);
    expect(wordmarkGeometry().parts).toHaveLength(8);
    expect(readFileSync(join(__dirname, "../lib/brand-geometry.ts"), "utf8")).toBe(mobile);
  });
});
