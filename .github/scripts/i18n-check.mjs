// Arabic/English key parity check (spec A2.15, ADR-0006 decision 6). Run with: pnpm i18n-check
//
// The catalogs are TypeScript objects, so each file is transpiled with the repo's own `typescript`
// package and evaluated in a temp directory. Checks, per catalog pair:
//   1. every key path in `en` exists in `ar`, and the reverse;
//   2. no leaf is an empty string, and Arabic leaves must differ from nothing but may equal English
//      only when they are on the allow list of brand names (reported as a warning, not an error);
//   3. interpolation placeholders ({{name}}) are identical in both languages.
// Exit code 1 on any error. Pure Node, no new dependencies.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Catalog pairs to check. Add a row when a new package or app ships translated strings. */
const PAIRS = [
  {
    name: "packages/i18n",
    en: { file: "packages/i18n/src/en.ts", exportName: "en" },
    ar: { file: "packages/i18n/src/ar.ts", exportName: "ar" },
  },
];

/** Leaves that may legitimately be identical in both languages (brand names, symbols). */
const SAME_VALUE_ALLOWED = new Set(["Z-OUTLET"]);

async function loadExport(file, exportName, workDir) {
  const abs = join(root, file);
  const source = readFileSync(abs, "utf8");
  // Strip type-only imports so the transpiled module has no relative imports left.
  const stripped = source.replace(/^import\s+type\s+[^;]+;\s*$/gm, "");
  const js = ts.transpileModule(stripped, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const out = join(workDir, `${exportName}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(out, js);
  const mod = await import(pathToFileURL(out).href);
  if (!(exportName in mod)) throw new Error(`${file} does not export "${exportName}"`);
  return mod[exportName];
}

/** Flattens a nested catalog to { "a.b.c": "text" }. Non-string leaves are reported by the caller. */
export function flatten(obj, prefix = "") {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flatten(value, path));
    } else {
      result[path] = value;
    }
  }
  return result;
}

function placeholders(text) {
  return [...String(text).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort();
}

/** Pure comparison, exported for tests. Returns { errors, warnings }. */
export function compareCatalogs(enFlat, arFlat) {
  const errors = [];
  const warnings = [];
  for (const key of Object.keys(enFlat)) {
    if (!(key in arFlat)) errors.push(`missing in ar: ${key}`);
  }
  for (const key of Object.keys(arFlat)) {
    if (!(key in enFlat)) errors.push(`missing in en: ${key}`);
  }
  for (const [lang, flat] of [["en", enFlat], ["ar", arFlat]]) {
    for (const [key, value] of Object.entries(flat)) {
      if (typeof value !== "string") errors.push(`${lang}.${key}: leaf is not a string`);
      else if (value.trim() === "") errors.push(`${lang}.${key}: empty string`);
    }
  }
  for (const key of Object.keys(enFlat)) {
    if (!(key in arFlat)) continue;
    const a = placeholders(enFlat[key]).join(",");
    const b = placeholders(arFlat[key]).join(",");
    if (a !== b) errors.push(`${key}: placeholder mismatch (en {${a}} vs ar {${b}})`);
    if (enFlat[key] === arFlat[key] && !SAME_VALUE_ALLOWED.has(String(enFlat[key]))) {
      warnings.push(`${key}: Arabic text is identical to English ("${enFlat[key]}"), likely untranslated`);
    }
  }
  return { errors, warnings };
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "i18n-check-"));
  let failed = false;
  try {
    for (const pair of PAIRS) {
      if (!existsSync(join(root, pair.en.file)) || !existsSync(join(root, pair.ar.file))) {
        console.error(`i18n-check: ${pair.name}: catalog file missing`);
        failed = true;
        continue;
      }
      const en = await loadExport(pair.en.file, pair.en.exportName, workDir);
      const ar = await loadExport(pair.ar.file, pair.ar.exportName, workDir);
      const { errors, warnings } = compareCatalogs(flatten(en), flatten(ar));
      for (const w of warnings) console.warn(`i18n-check: ${pair.name}: warning: ${w}`);
      for (const e of errors) console.error(`i18n-check: ${pair.name}: ERROR: ${e}`);
      if (errors.length > 0) failed = true;
      else console.log(`i18n-check: ${pair.name}: ${Object.keys(flatten(en)).length} keys, parity OK`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
