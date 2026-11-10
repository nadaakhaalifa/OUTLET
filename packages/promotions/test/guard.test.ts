import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
const SRC = new URL("../src", import.meta.url).pathname;

describe("budget data never reaches promotions (master prompt section 12 and 17)", () => {
  const files = walk(SRC);
  it("no source file imports @outlet/budget or names a budget table", () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/@outlet\/budget|budget_cycles|budget_insights|installment_commitments|savings_goals|FROM budgets\b/);
    }
  });
  it("package.json does not depend on a budget package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((d) => d.includes('budget'))).toEqual([]);
  });
});
