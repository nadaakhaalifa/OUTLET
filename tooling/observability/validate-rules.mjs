#!/usr/bin/env node
// Structural validator for the committed Prometheus rule files, written independently of the
// generator so it can catch a generator bug. It is NOT a substitute for `promtool check rules`
// (it does not parse PromQL); it checks what can be checked without the binary:
//   * YAML shape (groups -> rules, record/expr, alert/expr/for/labels/annotations)
//   * duration syntax, balanced brackets, valid metric names
//   * burn-rate window pairs: fast = 1h and 5m, slow = 6h and 30m (SRE Workbook, spec T8)
//   * thresholds equal burn rate x (1 - objective) from slos.yaml
//   * every recorded series an alert reads is actually recorded
//   * runbooks, dashboards and rule files referenced by the SLO file exist
// Usage: node tooling/observability/validate-rules.mjs   (exit 1 on any error)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const slos = parse(readFileSync(join(root, 'infra/observability/slos/slos.yaml'), 'utf8'));
const rulesDir = join(root, 'infra/observability/prometheus/rules');
const dashDir = join(root, 'infra/observability/grafana/dashboards');

const TIERS = {
  fast: { long: '1h', short: '5m', burn: 13.44 },
  slow: { long: '6h', short: '30m', burn: 5.6 },
};
const DURATION = /^\d+(ms|s|m|h|d|w|y)$/;
const METRIC = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const errors = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const balanced = (s) => {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (const c of s) {
    if ('([{'.includes(c)) stack.push(c);
    else if (c in pairs && stack.pop() !== pairs[c]) return false;
  }
  return stack.length === 0;
};

const sloById = new Map(slos.slos.map((s) => [s.id, s]));
const files = readdirSync(rulesDir).filter((f) => f.endsWith('.yaml')).sort();
const groups = new Set();
const recorded = new Set();
const read = new Set();
let alerts = 0;
let records = 0;

for (const f of files) {
  const doc = parse(readFileSync(join(rulesDir, f), 'utf8'));
  if (!doc || typeof doc !== 'object' || Object.keys(doc).join() !== 'groups' || !Array.isArray(doc.groups)) {
    err(f, 'top level must be exactly { groups: [...] }');
    continue;
  }
  for (const g of doc.groups) {
    if (typeof g.name !== 'string' || !g.name) err(f, 'group without a name');
    if (groups.has(g.name)) err(f, `duplicate group name ${g.name}`);
    groups.add(g.name);
    if (g.interval !== undefined && !DURATION.test(g.interval)) err(f, `group ${g.name}: bad interval ${g.interval}`);
    if (!Array.isArray(g.rules) || g.rules.length === 0) err(f, `group ${g.name}: no rules`);
    for (const r of g.rules ?? []) {
      if (typeof r.expr !== 'string' || !balanced(r.expr)) err(f, `rule has an empty or unbalanced expr: ${r.record ?? r.alert}`);
      if (r.record !== undefined) {
        records += 1;
        if (!METRIC.test(r.record)) err(f, `invalid record name ${r.record}`);
        recorded.add(r.record);
        continue;
      }
      if (r.alert === undefined) {
        err(f, 'rule is neither record nor alert');
        continue;
      }
      alerts += 1;
      if (r.for !== undefined && !DURATION.test(r.for)) err(f, `${r.alert}: bad for ${r.for}`);
      if (!r.labels?.severity) err(f, `${r.alert}: no severity label`);
      for (const k of ['summary', 'description', 'runbook']) {
        if (!r.annotations?.[k]) err(f, `${r.alert}: missing annotation ${k}`);
      }
      const runbook = r.annotations?.runbook;
      if (runbook && !existsSync(join(root, runbook))) err(f, `${r.alert}: runbook not found: ${runbook}`);
      for (const m of r.expr.matchAll(/(slo:[A-Za-z0-9_:]+)\{/g)) read.add(m[1]);

      const tier = TIERS[r.labels?.tier];
      if (/^SLO(Fast|Slow)Burn/.test(r.alert)) {
        if (!tier) {
          err(f, `${r.alert}: unknown tier label ${r.labels?.tier}`);
          continue;
        }
        const wins = [...r.expr.matchAll(/ratio_rate(\w+?)\{/g)].map((m) => m[1]);
        if (wins.length !== 2 || wins[0] !== tier.long || wins[1] !== tier.short) {
          err(f, `${r.alert}: error-ratio windows ${JSON.stringify(wins)}, want [${tier.long}, ${tier.short}]`);
        }
        const slo = sloById.get(r.labels.slo);
        if (!slo) {
          err(f, `${r.alert}: unknown slo ${r.labels.slo}`);
          continue;
        }
        const want = tier.burn * (1 - slo.objective);
        const th = [...r.expr.matchAll(/\}\s*>\s*([0-9.]+)/g)].map((m) => Number(m[1]));
        if (th.length !== 2 || th.some((t) => Math.abs(t - want) > 1e-9)) {
          err(f, `${r.alert}: thresholds ${JSON.stringify(th)}, want ${want} (burn ${tier.burn} x budget ${1 - slo.objective})`);
        }
        if (want >= 1) err(f, `${r.alert}: threshold ${want} >= 1 can never fire`);
        if (Math.abs(Number(r.labels.burn_rate) - tier.burn) > 1e-9) err(f, `${r.alert}: burn_rate label ${r.labels.burn_rate}`);
      }
    }
  }
}
for (const name of read) if (!recorded.has(name)) err('rules', `alert reads series ${name} that no recording rule produces`);

const sloTiers = Object.fromEntries(slos.tiers.map((t) => [t.name, t]));
for (const [name, t] of Object.entries(TIERS)) {
  if (sloTiers[name]?.long !== t.long || sloTiers[name]?.short !== t.short) {
    err('slos.yaml', `tier ${name} must be ${t.long}/${t.short}, found ${sloTiers[name]?.long}/${sloTiers[name]?.short}`);
  }
}
for (const s of slos.slos) {
  if (!existsSync(join(root, s.runbook))) err(`slo ${s.id}`, `runbook not found: ${s.runbook}`);
  if (!existsSync(join(dashDir, `${s.dashboard}.json`))) err(`slo ${s.id}`, `dashboard not found: ${s.dashboard}.json`);
  if (!existsSync(join(rulesDir, `slo-${s.id}.rules.yaml`))) err(`slo ${s.id}`, 'rules file not found');
}

console.log(`rule files=${files.length} groups=${groups.size} recording rules=${records} alerts=${alerts} slos=${slos.slos.length}`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
console.log('prometheus rule structure: OK (promtool not run)');
