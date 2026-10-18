import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resources } from "@outlet/i18n";

/**
 * i18n-check only compares the two catalogs with each other. This scans every source file under apps/mobile/src for literal
 * translation keys (`t("a.b")`, `pluralKey("a.b", n)`) and fails when a key is missing in EN or AR, so a screen can never render a raw key.
 * Dynamic keys (template literals, variables) cannot be checked statically and are skipped.
 */
const root = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

function has(tree: unknown, key: string): boolean {
  let cur: unknown = tree;
  for (const part of key.split(".")) {
    if (typeof cur !== "object" || cur === null || !(part in cur)) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string";
}

describe("every literal i18n key used in apps/mobile/src exists in EN and AR", () => {
  const missing: string[] = [];
  let scanned = 0;
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    const keys = [...src.matchAll(/(?<![A-Za-z0-9_$.])t\(\s*"([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)"/g)].map((m) => m[1] as string);
    const plurals = [...src.matchAll(/pluralKey\(\s*"([A-Za-z0-9_.]+)"/g)].map((m) => `${m[1]}Other`);
    for (const key of new Set([...keys, ...plurals])) {
      scanned += 1;
      for (const [lang, tree] of [["en", resources.en], ["ar", resources.ar]] as const) {
        if (!has(tree, key)) missing.push(`${lang}: ${key}  (${file.slice(root.length + 1)})`);
      }
    }
  }
  it("scans a meaningful number of keys", () => { expect(scanned).toBeGreaterThan(100); });
  it("has no missing keys", () => { expect(missing).toEqual([]); });
});
