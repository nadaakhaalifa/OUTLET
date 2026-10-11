#!/usr/bin/env node
// Measures line/branch coverage for every workspace package and enforces gates.
// Usage: node tooling/coverage/check.mjs [--no-run] [--update-baseline]
//  - packages/domain: lines >= 90% (master prompt A2.10), hard fail.
//  - others: report-only, but may not drop below tooling/coverage/baseline.json (ratchet).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Set(process.argv.slice(2));
const DOMAIN = "packages/domain";
const DOMAIN_MIN = 90;
const TOLERANCE = 0.05; // pct points, absorbs float noise
const baselinePath = join(root, "tooling/coverage/baseline.json");

const dirs = [];
for (const group of ["packages", "apps"]) {
  for (const d of readdirSync(join(root, group))) {
    if (existsSync(join(root, group, d, "package.json"))) dirs.push(`${group}/${d}`);
  }
}

const results = {};
for (const dir of dirs.sort()) {
  const abs = join(root, dir);
  const summary = join(abs, "coverage", "coverage-summary.json");
  if (!args.has("--no-run")) {
    const r = spawnSync(
      "pnpm",
      ["exec", "vitest", "run", "--passWithNoTests", "--coverage.enabled=true",
        "--coverage.provider=v8", "--coverage.reporter=text-summary",
        "--coverage.reporter=json-summary", "--coverage.reporter=json",
        "--coverage.all=true", "--coverage.include=src/**/*.{ts,tsx}",
        "--coverage.exclude=**/*.test.*", "--coverage.exclude=**/*.d.ts",
        "--coverage.reportsDirectory=coverage"],
      { cwd: abs, encoding: "utf8" },
    );
    results[dir] = { testsExit: r.status };
    if (r.status !== 0) console.error(`[coverage] ${dir}: vitest exited ${r.status}`);
  } else results[dir] = { testsExit: null };
  if (existsSync(summary)) {
    const t = JSON.parse(readFileSync(summary, "utf8")).total;
    Object.assign(results[dir], {
      lines: t.lines.pct, branches: t.branches.pct,
      functions: t.functions.pct, statements: t.statements.pct,
      linesTotal: t.lines.total,
    });
  } else results[dir].lines = null;
}

// Per-directory breakdown of packages/domain (src/<dir>/**), derived from coverage-final.json.
// Lines are counted as distinct statement start lines with at least one hit; branches as hit
// branch arms. This is an approximation of the v8 summary (the package total can differ by a few
// tenths), so these rows ratchet against their own baseline entries, never against the gate.
const domainFinal = join(root, DOMAIN, "coverage", "coverage-final.json");
if (existsSync(domainFinal)) {
  const final = JSON.parse(readFileSync(domainFinal, "utf8"));
  const prefix = join(root, DOMAIN, "src") + "/";
  const agg = {};
  for (const [file, c] of Object.entries(final)) {
    if (!file.startsWith(prefix)) continue;
    const rel = file.slice(prefix.length);
    const key = rel.includes("/") ? rel.split("/")[0] : null;
    if (key === null) continue;
    const a = (agg[key] ??= { lh: 0, lt: 0, bh: 0, bt: 0 });
    const lines = new Map();
    for (const [id, loc] of Object.entries(c.statementMap)) {
      const line = loc.start.line;
      lines.set(line, (lines.get(line) ?? 0) + (c.s[id] ?? 0));
    }
    for (const hits of lines.values()) { a.lt += 1; if (hits > 0) a.lh += 1; }
    for (const arms of Object.values(c.b)) for (const h of arms) { a.bt += 1; if (h > 0) a.bh += 1; }
  }
  const pct = (h, t) => (t === 0 ? 100 : Math.round((10000 * h) / t) / 100);
  for (const [key, a] of Object.entries(agg).sort()) {
    results[`${DOMAIN}/src/${key}`] = { testsExit: null, lines: pct(a.lh, a.lt), branches: pct(a.bh, a.bt), linesTotal: a.lt };
  }
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
let failed = false;
console.log("\npackage".padEnd(24) + "lines".padStart(8) + "branch".padStart(8) + "  status");
for (const [dir, r] of Object.entries(results)) {
  let status = "ok";
  if (r.lines === null || r.lines === undefined) status = r.testsExit ? "NO DATA (tests failed)" : "no data/no tests";
  else if (dir === DOMAIN && r.lines < DOMAIN_MIN) { status = `FAIL < ${DOMAIN_MIN}%`; failed = true; }
  else if (baseline[dir] && r.lines + TOLERANCE < baseline[dir].lines) {
    status = `FAIL ratchet (was ${baseline[dir].lines})`; failed = true;
  }
  if (r.testsExit) { status += " [tests failing]"; }
  console.log(dir.padEnd(24) + String(r.lines ?? "-").padStart(8) + String(r.branches ?? "-").padStart(8) + "  " + status);
}
if (args.has("--update-baseline")) {
  const next = {};
  for (const [dir, r] of Object.entries(results)) {
    if (typeof r.lines === "number" && dir !== DOMAIN) next[dir] = { lines: r.lines, branches: r.branches };
  }
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
  console.log("baseline updated");
}
process.exit(failed ? 1 : 0);
