#!/usr/bin/env node
// Offline lint for .github/workflows/*.yml. It is not `actionlint` and not `act`; it checks the
// things that can be checked without network or a runner:
//   * every file parses as YAML and has name, on, jobs
//   * every job has runs-on (or uses a reusable workflow) and a timeout-minutes where it runs steps
//   * permissions are declared at workflow level, and every elevated permission is job-scoped
//   * `needs` points at real jobs; `if: needs.<job>.outputs` refers to a declared output
//   * `uses:` refs: local paths exist; remote refs are a full 40-hex SHA, or a version tag, and
//     never a branch name (main, master, HEAD). `--require-sha` makes a tag an error.
//   * `pnpm <script>` and `pnpm --filter ... <script>` in run steps exist in the root package.json
//   * `node <path>` and `./<path>` in run steps point at files that exist
// Usage: node .github/scripts/validate-workflows.mjs [--require-sha]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = join(root, '.github/workflows');
const requireSha = process.argv.includes('--require-sha');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scripts = new Set(Object.keys(pkg.scripts ?? {}));
// pnpm built-ins and subcommands that are not package scripts.
const PNPM_BUILTIN = new Set(['install', 'i', 'audit', 'dlx', 'exec', 'run', 'add', 'update', 'store', 'config', 'fetch', 'deploy']);
const ELEVATED = new Set(['write']);
const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);
const tally = { sha: 0, tag: 0, local: 0, reusable: 0 };

for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const at = `.github/workflows/${file}`;
  let doc;
  try {
    doc = parse(readFileSync(join(dir, file), 'utf8'));
  } catch (e) {
    err(at, `YAML parse error: ${e.message}`);
    continue;
  }
  for (const k of ['name', 'on', 'jobs']) {
    // YAML 1.1 parsers turn a bare `on` into true; the yaml package keeps the string.
    if (doc?.[k] === undefined && !(k === 'on' && doc?.[true] !== undefined)) err(at, `missing top-level ${k}`);
  }
  if (doc?.permissions === undefined) err(at, 'no workflow-level permissions block (default token would be broad)');
  else if (typeof doc.permissions === 'string' && doc.permissions.startsWith('write')) err(at, 'workflow-level write-all');
  else if (Object.values(doc.permissions ?? {}).some((v) => ELEVATED.has(v))) err(at, 'workflow-level write permission; scope it to the job');

  const jobs = doc?.jobs ?? {};
  for (const [id, job] of Object.entries(jobs)) {
    const w = `${at} job ${id}`;
    const isReusable = typeof job.uses === 'string';
    if (!isReusable && !job['runs-on']) err(w, 'no runs-on');
    if (!isReusable && job['timeout-minutes'] === undefined) err(w, 'no timeout-minutes');
    for (const n of [].concat(job.needs ?? [])) if (!(n in jobs)) err(w, `needs unknown job ${n}`);
    for (const m of String(job.if ?? '').matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)) {
      if (!jobs[m[1]]) err(w, `if refers to unknown job ${m[1]}`);
      else if (!(m[2] in (jobs[m[1]].outputs ?? {}))) err(w, `if refers to undeclared output ${m[1]}.${m[2]}`);
    }
    if (job.permissions && typeof job.permissions === 'object') {
      for (const [k, v] of Object.entries(job.permissions)) {
        if (ELEVATED.has(v)) warn(w, `elevated permission ${k}: ${v} (confirm it is needed)`);
      }
    }
    const uses = [];
    if (isReusable) uses.push(job.uses);
    for (const [i, step] of (job.steps ?? []).entries()) {
      if (step.uses) uses.push(step.uses);
      if (!step.uses && !step.run) err(`${w} step ${i}`, 'step has neither uses nor run');
      for (const line of String(step.run ?? '').split('\n')) {
        const l = line.trim();
        let m = l.match(/^pnpm\s+(?:--filter\s+\S+\s+)?([\w:-]+)/);
        if (m && !PNPM_BUILTIN.has(m[1]) && !m[1].startsWith('-') && !scripts.has(m[1])) {
          err(`${w} step ${i}`, `pnpm ${m[1]} is not a root script`);
        }
        m = l.match(/^node\s+(?:--[\w-]+\s+)*(\.?[\w./-]+\.(?:mjs|js|cjs))/);
        if (m && !existsSync(join(root, m[1]))) err(`${w} step ${i}`, `script not found: ${m[1]}`);
      }
      for (const key of ['working-directory']) {
        if (step[key] && !existsSync(join(root, step[key]))) err(`${w} step ${i}`, `${key} not found: ${step[key]}`);
      }
      const p = step.with?.file ?? step.with?.['config_file'];
      if (typeof p === 'string' && !p.includes('${{')) {
        // `file:` of docker/build-push-action may legitimately not exist yet (release is guarded).
        if (!existsSync(join(root, p))) warn(`${w} step ${i}`, `referenced file not found: ${p}`);
      }
    }
    for (const u of uses) {
      if (u.startsWith('./')) {
        tally.local += 1;
        if (!existsSync(join(root, u.replace(/@.*/, '')))) err(w, `local action/workflow not found: ${u}`);
        continue;
      }
      const m = u.match(/^([\w.-]+\/[\w./-]+)@(.+)$/);
      if (!m) {
        err(w, `cannot parse uses: ${u}`);
        continue;
      }
      const ref = m[2];
      if (/^[0-9a-f]{40}$/.test(ref)) tally.sha += 1;
      else if (/^(main|master|HEAD|develop|latest)$/.test(ref)) err(w, `branch reference is mutable: ${u}`);
      else if (/^v?\d+(\.\d+){0,2}$/.test(ref)) {
        tally.tag += 1;
        // The SLSA generator must be called by tag: its builder identity check rejects a SHA ref.
        const tagRequired = m[1].startsWith('slsa-framework/slsa-github-generator/');
        if (requireSha && !tagRequired) err(w, `not SHA-pinned: ${u}`);
      } else warn(w, `unusual ref: ${u}`);
      if (isReusable && u === job.uses) tally.reusable += 1;
    }
  }
}

console.log(`workflows checked; actions: ${tally.sha} SHA-pinned, ${tally.tag} version-tag, ${tally.local} local`);
for (const x of warnings) console.warn(`warn: ${x}`);
if (errors.length) {
  for (const x of errors) console.error(`error: ${x}`);
  process.exit(1);
}
console.log('workflow lint: OK');
