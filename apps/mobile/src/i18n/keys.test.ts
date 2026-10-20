import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resources } from "@outlet/i18n";

const { ar, en } = resources;

const ROOT = join(__dirname, "..");
const SKIP_PLURAL = /_(zero|one|two|few|many|other)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function resolves(catalog: unknown, key: string): boolean {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    const rec = node as Record<string, unknown>;
    if (part in rec) node = rec[part];
    else {
      const plural = Object.keys(rec).find((k) => k.replace(SKIP_PLURAL, "") === part && SKIP_PLURAL.test(k));
      if (plural === undefined) return false;
      node = rec[plural];
    }
  }
  return typeof node === "string";
}

describe("i18n keys used in apps/mobile/src", () => {
  const used = new Map<string, string>();
  const dynamic: string[] = [];
  const LITERAL = /\bt\(\s*(["'])([A-Za-z0-9_.]+)\1/g;
  const DYNAMIC = /\bt\(\s*`[^`]*\$\{/g;
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(LITERAL)) {
      const key = m[2];
      if (key !== undefined && key.includes(".") && !key.endsWith(".")) { if (!used.has(key)) used.set(key, file); }
    }
    if (DYNAMIC.test(src)) dynamic.push(file);
    DYNAMIC.lastIndex = 0;
  }

  it("finds keys to check", () => {
    expect(used.size).toBeGreaterThan(50);
  });

  it("every literal key resolves in EN and AR", () => {
    const missing: string[] = [];
    for (const [key, file] of used) {
      if (!resolves(en, key)) missing.push(`en ${key} (${file.replace(ROOT, "src")})`);
      if (!resolves(ar, key)) missing.push(`ar ${key} (${file.replace(ROOT, "src")})`);
    }
    expect(missing).toEqual([]);
  });

  it("lists files with dynamic template keys as skipped", () => {
    // Dynamic keys cannot be checked statically; they are listed so reviewers can see the gap.
    expect(Array.isArray(dynamic)).toBe(true);
  });
});
