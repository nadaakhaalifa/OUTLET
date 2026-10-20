#!/usr/bin/env node
// Usage: node tooling/copy-lint/cli.mjs [--root <repo>] [--json] [--no-fail] [paths...]
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintSource } from "./lint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const rootIdx = args.indexOf("--root");
const root = resolve(rootIdx >= 0 ? args[rootIdx + 1] : join(here, "..", ".."));
const explicit = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--root");

const DEFAULT_ROOTS = ["packages/i18n/src", "apps/mobile/src", "apps/seller-web/src", "apps/admin-web/src", "apps/shopper-web/src"];
const SKIP_DIR = new Set(["node_modules", ".next", ".expo", "dist", "build", "coverage", "__tests__", "test", "__mocks__", "fixtures"]);
const isSource = (f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f) && !/\.(test|spec|stories)\.(ts|tsx)$/.test(f);

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIR.has(name)) walk(p, acc); }
    else if (isSource(name)) acc.push(p);
  }
  return acc;
}

const allowPath = join(here, "allowlist.json");
const allowlist = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")).entries ?? [] : [];

const files = [];
for (const r of explicit.length ? explicit : DEFAULT_ROOTS) {
  const p = resolve(root, r);
  if (existsSync(p) && statSync(p).isFile()) files.push(p); else walk(p, files);
}

const t0 = Date.now();
const findings = [];
for (const f of files) {
  const rel = relative(root, f);
  findings.push(...lintSource(rel, readFileSync(f, "utf8"), { allowlist }));
}
const report = { scannedFiles: files.length, ms: Date.now() - t0, findings };
if (flag("--json")) console.log(JSON.stringify(report, null, 2));
else {
  for (const f of findings) console.log(`${f.file}:${f.line}  [${f.rule}] ${f.message}  -> ${JSON.stringify(f.match)}`);
  console.log(`copy-lint: ${files.length} files, ${findings.length} finding(s), ${report.ms} ms`);
}
process.exit(findings.length && !flag("--no-fail") ? 1 : 0);
