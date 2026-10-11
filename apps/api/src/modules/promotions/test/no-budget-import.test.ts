import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Spec 12 and 17: the promotions module must never read the shopper's budget data. The budget tables
 * carry `forbidden_importers: [promotions, ads]` in data_inventory.yaml; this guard enforces it on
 * every source file of the module and of the pure domain (budget is financial-behaviour data, P3).
 */
const roots = [
  fileURLToPath(new URL("..", import.meta.url)),
  fileURLToPath(new URL("../../../../../../packages/domain/src/promotions", import.meta.url)),
];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (p.endsWith(".ts") && !p.endsWith("no-budget-import.test.ts")) yield p;
  }
}

const IMPORT = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
const BUDGET_TABLES = /\b(budgets|budget_cycles|installment_commitments|savings_goals)\b/;

describe("promotions never import budget data", () => {
  const files = roots.flatMap((r) => [...sources(r)]);

  it("finds the module sources", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("no import specifier mentions budget, and no source names a budget table", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? "";
        if (/budget|installment/i.test(spec)) offenders.push(`${f}: import of ${spec}`);
      }
      // Tests may describe the rule; production sources may not mention the tables at all.
      if (!/\.test\.ts$/.test(f) && !/\/test\//.test(f) && BUDGET_TABLES.test(text)) offenders.push(`${f}: names a budget table`);
    }
    expect(offenders).toEqual([]);
  });

  it("the migration has no column or foreign key to budget tables", () => {
    const sql = readFileSync(
      fileURLToPath(new URL("../../../../../../packages/db/migrations/0021_promotions.sql", import.meta.url)),
      "utf8",
    ).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(BUDGET_TABLES);
    expect(sql).not.toMatch(/REFERENCES\s+(budgets|budget_cycles|installment_commitments|savings_goals)/i);
  });
});
