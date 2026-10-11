import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });

describe("budget isolation (spec 12 Privacy, spec 13)", () => {
  const files = [...walk(HERE), ...walk(join(HERE, "../history"))];
  it("no source file imports the budget module or reads budget tables", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/from\s+["'][^"']*modules\/budget/);
      expect(text, f).not.toMatch(/from\s+["']\.\.\/\.\.\/budget/);
      expect(text, f).not.toMatch(/\b(budgets|budget_cycles|installment_commitments|savings_goals)\b/);
    }
  });
  it("affordability reaches ranking only through the request-time AffordabilityFilterPort", () => {
    const ports = readFileSync(join(HERE, "domain/ports.ts"), "utf8");
    expect(ports).toMatch(/interface AffordabilityFilterPort/);
    const app = readFileSync(join(HERE, "application/recommendations.ts"), "utf8");
    expect(app).toMatch(/affordability\.filter\(/);
  });
});
