#!/usr/bin/env node
// Usage:
//   node tooling/observability/generate.mjs           write generated files
//   node tooling/observability/generate.mjs --check   exit 1 if committed files drift from the SLO file
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { parseSloFile } from './src/slo-schema.mjs';
import { generateRuleFiles } from './src/generate-rules.mjs';
import { generateDashboards } from './src/generate-dashboards.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sloPath = join(root, 'infra/observability/slos/slos.yaml');
const rulesDir = join(root, 'infra/observability/prometheus/rules');
const dashDir = join(root, 'infra/observability/grafana/dashboards');

const file = parseSloFile(parse(readFileSync(sloPath, 'utf8')));
const wanted = [
  ...Object.entries(generateRuleFiles(file)).map(([n, c]) => [join(rulesDir, n), c]),
  ...Object.entries(generateDashboards(file)).map(([n, c]) => [join(dashDir, n), c]),
];
const check = process.argv.includes('--check');
// Rule files written by hand, with their own promtool tests (not derived from slos.yaml). A rule file opts out of
// the stale-file check only by starting with the marker line `# HAND-WRITTEN`; anything else that is not generated
// is still flagged.
const isHandWritten = (path) => path.endsWith('.rules.yaml') && readFileSync(path, 'utf8').startsWith('# HAND-WRITTEN');
let drift = 0;
for (const [path, content] of wanted) {
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      console.error(`drift: ${path}`);
      drift += 1;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
if (check) {
  const known = new Set(wanted.map(([p]) => p));
  for (const dir of [rulesDir, dashDir]) {
    for (const n of existsSync(dir) ? readdirSync(dir) : []) {
      if (!known.has(join(dir, n)) && !isHandWritten(join(dir, n))) {
        console.error(`stale generated file: ${join(dir, n)}`);
        drift += 1;
      }
    }
  }
  if (drift > 0) process.exit(1);
  console.log(`ok: ${wanted.length} generated files match ${sloPath}`);
} else {
  console.log(`wrote ${wanted.length} files from ${file.slos.length} SLOs`);
}
