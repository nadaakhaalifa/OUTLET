import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOMAIN = fileURLToPath(new URL("../../../../../../packages/domain/src/seller-analytics", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const production = (files: string[]) => files.filter((f) => !/\.test\.ts$|\/test\//.test(f));
const importsOf = (src: string): string[] =>
  [...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

describe("module boundaries (mirror of the depcruise rules, enforced locally)", () => {
  const files = [...production(walk(ROOT)), ...production(walk(DOMAIN))];

  it("scans a non-trivial number of files", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("never imports a budget module or table (budget data is never shared with sellers)", () => {
    const offenders = files.filter((f) => importsOf(readFileSync(f, "utf8")).some((i) => /budget/i.test(i)));
    expect(offenders).toEqual([]);
  });

  it("never reads budget, measurement or per-shopper tables in SQL", () => {
    const sql = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(sql).not.toMatch(/\b(from|join)\s+(budgets?|budget_cycles|size_profiles|fit_model_params|installment_commitments|savings_goals)\b/i);
  });

  it("the pure domain imports nothing outside its own package (no infra, no crypto)", () => {
    for (const f of production(walk(DOMAIN))) {
      for (const i of importsOf(readFileSync(f, "utf8"))) {
        expect(i.startsWith("./") || i === "../money", `${f} imports ${i}`).toBe(true);
      }
    }
  });

  it("no exported read-model type carries a shopper key", () => {
    const wire = readFileSync(`${ROOT}/adapters/wire.ts`, "utf8");
    const queries = readFileSync(`${ROOT}/application/queries.ts`, "utf8");
    expect(wire).not.toMatch(/shopper/i);
    expect(queries).not.toMatch(/shopperKey/);
  });
});
