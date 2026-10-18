import { describe, expect, it } from "vitest";
import { colors } from "@outlet/ui-tokens";
import { ADMIN_CSS, SELLER_CSS, uiWebCss } from "./css";
import { colorVars, contrast, tokensCss } from "./tokens-css";

describe("uiWebCss", () => {
  it("references each app's own variable names", () => {
    expect(uiWebCss(ADMIN_CSS)).toContain("var(--surface)");
    expect(uiWebCss(ADMIN_CSS)).toContain("var(--sp-md)");
    expect(uiWebCss(SELLER_CSS)).toContain("var(--c-surface)");
    expect(uiWebCss(SELLER_CSS)).toContain("var(--s-md)");
    expect(uiWebCss(SELLER_CSS)).toContain("var(--target)");
  });
  it("uses logical properties only and no colour literals or physical direction", () => {
    const css = uiWebCss(ADMIN_CSS);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
    expect(css).not.toMatch(/(margin|padding|border)-(left|right)|[^-]\b(left|right):|text-align:(left|right)/);
  });
  it("honours reduced motion", () => expect(uiWebCss(ADMIN_CSS)).toContain("prefers-reduced-motion:reduce"));
  const hostile = ["--;}body{", "--\n", "--a\nb", "--\u2028", "--\u2029", "--;}", "--)", "--a)", "--A", "--ABC", "-- x", "--x y", "--é", "--ش", "x", "", "-", "--a;b", "--a}", "--a{", "--/*", "--\\", "--\"", "--'", "--a,b"];
  const keys = ["color", "space", "radius", "tap"] as const;
  const good = { color: "--", space: "--sp-", tap: "--tap", radius: "--r-" };
  for (const key of keys) {
    for (const bad of hostile) {
      it(`rejects ${JSON.stringify(bad)} for ${key}`, () => {
        expect(() => uiWebCss({ ...good, [key]: bad })).toThrow();
      });
    }
  }
  it("tap additionally needs a name after the dashes", () => expect(() => uiWebCss({ ...good, tap: "--" })).toThrow());
  it("rejects unknown options and accepts clean ones without leaking into the output", () => {
    expect(() => uiWebCss({ ...good, extra: "x" } as never)).toThrow();
    const css = uiWebCss(good);
    expect(css).toContain("var(--tap)");
    expect(css).not.toContain("\u2028");
  });
});

describe("shared token generator", () => {
  it("colorVars honours the prefix for every role", () => {
    expect(colorVars(colors.light, "--c-")).toContain(`--c-text-primary:${colors.light.textPrimary};`);
    expect(colorVars(colors.light, "--")).toContain(`--text-primary:${colors.light.textPrimary};`);
  });
  it("tokensCss emits light, dark-by-preference and forced-dark blocks", () => {
    const css = tokensCss();
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toContain('[data-theme="dark"]');
  });
  it("contrast is 21 for black on white and symmetric", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
  });
  it("core text roles meet AA on their surfaces in both schemes", () => {
    for (const s of ["light", "dark"] as const) {
      expect(contrast(colors[s].textPrimary, colors[s].surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors[s].textSecondary, colors[s].surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("client entry stays zod-free", () => {
  it("nothing reachable from index.ts through relative imports imports zod, css.ts, tokens-css.ts or ui-tokens", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const resolve = (from: string, spec: string): string | null => {
      const base = `${from.slice(0, from.lastIndexOf("/"))}/${spec.replace(/^\.\//, "")}`;
      for (const ext of [".ts", ".tsx"]) if (existsSync(base + ext)) return base + ext;
      return null;
    };
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1] ?? "";
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^zod(\/|$)|^@outlet\/ui-tokens|^\.\/(css|tokens-css|css-entry)$/);
        if (spec.startsWith("./")) { const r = resolve(file, spec); if (r !== null) walk(r); }
      }
    };
    walk(`${__dirname}/index.ts`);
    expect(seen.size).toBeGreaterThan(8);
    expect([...seen].some((f) => f.endsWith("/contrast.ts"))).toBe(true);
  });
  it("contrast is exported from the zod-free entry", async () => {
    const m = await import("./index");
    expect(m.contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });
});

describe("chart css", () => {
  it("supports forced colors and keyboard focus without colour literals", () => {
    const css = uiWebCss(ADMIN_CSS);
    expect(css).toContain("forced-colors:active");
    expect(css).toContain(".uw-chart:focus-visible");
  });
  it("forced-colors block uses system colours only, covers chart fills, strokes and KPI state borders", () => {
    const css = uiWebCss(ADMIN_CSS);
    const start = css.indexOf("@media (forced-colors:active)");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("@media (prefers-reduced-motion"));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|var\(/);
    for (const k of ["CanvasText", "GrayText", "Highlight", "Canvas"]) expect(block).toContain(k);
    for (const sel of [".uw-ch-up", ".uw-ch-down", ".uw-ch-line", ".uw-ch-pat-fg", '.uw-kpi[data-state="stale"]', '.uw-kpi[data-state="error"]']) expect(block, sel).toContain(sel);
    expect(block).toContain("forced-color-adjust:none");
  });
  it("keeps the series patterns (not colour-only) in the stylesheet", () => {
    const css = uiWebCss(ADMIN_CSS);
    expect(css).toContain(".uw-ch-pat-fg");
    expect(css).toContain(".uw-ch-pat-dot");
  });
});
