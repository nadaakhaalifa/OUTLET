import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(pkg, "..", "..");

const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
}

/** Reads `--name: #hex;` declarations out of one CSS block that starts at `selector`. */
function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
}

describe("ui-tokens build", () => {
  let css = "";
  beforeAll(() => {
    execFileSync("node", [join(pkg, "build.mjs")], { stdio: "pipe" });
    css = readFileSync(join(pkg, "dist/tokens.css"), "utf8");
  });

  it("emits light and dark themes plus the prefers-color-scheme fallback", () => {
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(block(css, ":root,").get("--color-bg-page")).toBe("#F7F4EE");
    expect(block(css, '[data-theme="dark"] {').get("--color-bg-page")).toBe("#0F1812");
  });

  it("resolves every alias (no unresolved references in output)", () => {
    expect(css).not.toMatch(/\{color\./);
  });

  it("emitted theme values meet WCAG AA for the core text and ui pairs", () => {
    const pairs: [string, string, number][] = [
      ["--color-text-primary", "--color-bg-page", 4.5],
      ["--color-text-secondary", "--color-bg-surface", 4.5],
      ["--color-text-muted", "--color-bg-subtle", 4.5],
      ["--color-action-primary-text", "--color-action-primary-bg", 4.5],
      ["--color-discount-text", "--color-discount-bg", 4.5],
      ["--color-focus-ring", "--color-bg-page", 3],
      ["--color-border-input", "--color-bg-surface", 3],
    ];
    for (const sel of [":root,", '[data-theme="dark"] {']) {
      const vars = block(css, sel);
      for (const [fg, bg, min] of pairs) {
        const f = vars.get(fg);
        const b = vars.get(bg);
        expect(f && b, `${sel} ${fg}/${bg}`).toBeTruthy();
        expect(ratio(f ?? "", b ?? ""), `${sel} ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it("the shared contrast script passes against tokens.json", () => {
    const out = execFileSync("node", [join(repo, "tooling/design/contrast.mjs")], { encoding: "utf8" });
    expect(out).toContain("All pairs pass WCAG 2.2 AA");
  });

  it("emits a typed TS module", () => {
    const ts = readFileSync(join(pkg, "dist/tokens.ts"), "utf8");
    expect(ts).toContain("export const tokens");
    expect(ts).toMatch(/"bg\.page": "#F7F4EE"/);
    expect(ts).toContain("export type ThemeName");
  });
});
