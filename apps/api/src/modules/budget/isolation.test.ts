import { existsSync, mkdirSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Spec 12 and 17: budget data is never a targeting or ranking input. The dependency-cruiser rule
 * `budget-isolated-from-targeting-and-ranking` must fail when promotions, ads, seller analytics,
 * recommendations or ranking import the budget module (or the budget domain folder), and must
 * stay quiet for consumers that are allowed (feed/search/stylist/checkout via the public index).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");
const require = createRequire(import.meta.url);
type Cruise = (paths: string[], options: never, resolve: undefined) => Promise<{ output: unknown }>;
// dependency-cruiser is a root devDependency, not this package's: load it from the repo root.
const { cruise } = (await import(pathToFileURL(resolve(ROOT, "node_modules/dependency-cruiser/src/main/index.mjs")).href)) as {
  cruise: Cruise;
};
const loaded = require(resolve(ROOT, ".dependency-cruiser.cjs")) as { options: object };
/** The shared config names tsconfig.base.json relative to cwd; tests pin it to an absolute path. */
const rulesFor = (tsconfig: string): object => ({ ...loaded, options: { ...loaded.options, tsConfig: { fileName: tsconfig } } });
const RULE = "budget-isolated-from-targeting-and-ranking";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "budget-iso-")));
  dirs.push(dir);
  writeFileSync(join(dir, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler" } }));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

async function violations(dir: string): Promise<string[]> {
  const r = await cruise(["apps", "packages"].filter((p) => existsSync(join(dir, p))), { ruleSet: rulesFor(join(dir, "tsconfig.base.json")), validate: true, baseDir: dir, exclude: { path: "node_modules" } } as never, undefined);
  const out = r.output as { summary: { violations: { rule: { name: string }; from: string; to: string }[] } };
  return out.summary.violations.filter((v) => v.rule.name === RULE).map((v) => `${v.from} -> ${v.to}`);
}

const BUDGET_INDEX = "apps/api/src/modules/budget/index.ts";
const base = { [BUDGET_INDEX]: "export const budget = 1;\n", "apps/api/src/modules/budget/domain/secret.ts": "export const s = 1;\n" };

describe("dependency-cruiser budget isolation rule", () => {
  for (const mod of ["promotions", "ads", "seller-analytics", "recommendations", "ranking"]) {
    it(`fails when ${mod} imports budget (public index)`, async () => {
      const dir = fixture({ ...base, [`apps/api/src/modules/${mod}/uses.ts`]: `import { budget } from "../budget/index";\nexport const x = budget;\n` });
      expect(await violations(dir)).toEqual([`apps/api/src/modules/${mod}/uses.ts -> ${BUDGET_INDEX}`]);
    });
  }

  it("fails when a forbidden module reaches into budget internals", async () => {
    const dir = fixture({
      ...base,
      "apps/api/src/modules/promotions/deep.ts": `import { s } from "../budget/domain/secret";\nexport const x = s;\n`,
    });
    expect(await violations(dir)).toContain("apps/api/src/modules/promotions/deep.ts -> apps/api/src/modules/budget/domain/secret.ts");
  });

  it("fails when a forbidden module imports the budget domain folder", async () => {
    const dir = fixture({
      "packages/domain/src/budget/index.ts": "export const cycleFor = 1;\n",
      "apps/api/src/modules/ads/uses-domain.ts": `import { cycleFor } from "../../../../../packages/domain/src/budget/index";\nexport const x = cycleFor;\n`,
    });
    expect(await violations(dir)).toEqual(["apps/api/src/modules/ads/uses-domain.ts -> packages/domain/src/budget/index.ts"]);
  });

  it("allows the consumers that may use it: search, stylist and checkout, and budget itself", async () => {
    const dir = fixture({
      ...base,
      "apps/api/src/modules/search/uses.ts": `import { budget } from "../budget/index";\nexport const x = budget;\n`,
      "apps/api/src/modules/stylist/uses.ts": `import { budget } from "../budget/index";\nexport const x = budget;\n`,
      "apps/api/src/modules/checkout/uses.ts": `import { budget } from "../budget/index";\nexport const x = budget;\n`,
      "apps/api/src/modules/budget/domain/self.ts": `import { s } from "./secret";\nexport const x = s;\n`,
    });
    expect(await violations(dir)).toEqual([]);
  });

  it("holds for the real repository: no forbidden module imports budget today", async () => {
    const r = await cruise(["apps/api/src/modules/promotions", "apps/api/src/modules/search", "apps/api/src/modules/budget"], { ruleSet: rulesFor(join(ROOT, "tsconfig.base.json")), validate: true, baseDir: ROOT, exclude: { path: "node_modules" } } as never, undefined);
    const out = r.output as { summary: { violations: { rule: { name: string }; from: string; to: string }[] } };
    expect(out.summary.violations.filter((v) => v.rule.name === RULE)).toEqual([]);
  }, 120_000);
});
