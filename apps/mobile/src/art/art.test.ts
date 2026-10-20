import { describe, expect, it } from "vitest";
import { coverLayers, HERO_VARIANTS, heroSpec, initialOf } from "./art-geometry";
import { wordmarkGeometry } from "./brand-geometry";
import { CATEGORY_ICONS, CATEGORY_NAMES, ILLUSTRATION_NAMES, ILLUSTRATIONS } from "./glyph-data";
import { grainPaths, hashSeed, mix, paletteFor, PALETTES, ratioValue, viewBoxFor } from "./palette";
import { BOX, PRODUCT_KINDS, shapeFor } from "./product-shapes";

describe("palette", () => {
  it("is deterministic and covers all palettes over many seeds", () => {
    expect(paletteFor("abc")).toBe(paletteFor("abc"));
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => paletteFor(`s${i}`).name));
    expect(seen.size).toBe(PALETTES.length);
  });
  it("grain is deterministic and compact", () => {
    const a = grainPaths("x", 300, 400, 100);
    expect(a).toEqual(grainPaths("x", 300, 400, 100));
    expect(a.light.length + a.dark.length).toBeGreaterThan(500);
  });
  it("mixes colours", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
  it("aspect math", () => {
    expect(ratioValue("3:4")).toBe(0.75);
    expect(ratioValue("1:1")).toBe(1);
    expect(viewBoxFor("16:9").height).toBeCloseTo(168.75, 2);
    expect(viewBoxFor("3:4")).toEqual({ width: 300, height: 400 });
  });
});

describe("product shapes", () => {
  it.each(PRODUCT_KINDS)("%s renders non-empty path data inside the box", (kind) => {
    for (let v = 0; v < 4; v++) {
      const layers = shapeFor(kind, v);
      expect(layers.length).toBeGreaterThan(2);
      for (const l of layers) {
        expect(l.d).toMatch(/^M[\d.\s-]/);
        expect(l.d).not.toMatch(/NaN|undefined/);
        for (const n of l.d.match(/-?\d+(\.\d+)?/g) ?? []) expect(Math.abs(Number(n))).toBeLessThanOrEqual(BOX + 40);
      }
      expect(layers.some((l) => l.role === "base" || l.role === "accent")).toBe(true);
    }
  });
});

describe("store + hero + glyphs", () => {
  it("cover layers are deterministic and non-empty", () => {
    for (const s of ["a", "b", "c", "d", "e", "f"]) {
      const a = coverLayers(s);
      expect(a.layers.length).toBeGreaterThan(3);
      expect(JSON.stringify(a)).toBe(JSON.stringify(coverLayers(s)));
      expect(JSON.stringify(a)).not.toMatch(/NaN/);
    }
  });
  it("hero specs have layers", () => {
    for (const v of HERO_VARIANTS) {
      const h = heroSpec(v);
      expect(h.layers.length).toBeGreaterThan(2);
      expect(JSON.stringify(h)).not.toMatch(/NaN/);
    }
  });
  it("illustrations and icons have path data", () => {
    for (const n of ILLUSTRATION_NAMES) {
      expect(ILLUSTRATIONS[n].ink.length).toBeGreaterThan(0);
      expect(ILLUSTRATIONS[n].gold.length).toBe(1);
    }
    expect(CATEGORY_NAMES).toHaveLength(12);
    for (const n of CATEGORY_NAMES) expect(CATEGORY_ICONS[n].length).toBeGreaterThan(0);
  });
  it("wordmark geometry", () => {
    const w = wordmarkGeometry();
    expect(w.parts.filter((p) => p.accent === true)).toHaveLength(1);
    expect(w.parts).toHaveLength(8);
    expect(w.width).toBeGreaterThan(150);
    expect(JSON.stringify(w)).not.toMatch(/NaN|undefined/);
  });
  it("initials", () => {
    expect(initialOf("nile")).toBe("N");
    expect(initialOf("  مصنع")).toBe("م");
    expect(initialOf("")).toBe("?");
  });
});
