#!/usr/bin/env node
// Usage: node tooling/dora/dora.mjs [--offline] [--repo <dir>] [--ref <ref>] [--days 90] [--now <iso>]
//        [--json <file>] [--md <file>] [--format json|md]
import { writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeReport, toMarkdown, collectGit, collectGithub } from "./lib.mjs";

const a = process.argv.slice(2);
const opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const repo = resolve(opt("--repo", join(dirname(fileURLToPath(import.meta.url)), "..", "..")));
const offline = a.includes("--offline");
const ref = opt("--ref", "HEAD");
const now = opt("--now", new Date().toISOString());
const days = Number(opt("--days", "90"));

const git = collectGit(repo, ref);
let gh = null;
const notes = [];
if (!offline) {
  try { gh = collectGithub(repo); } catch (e) { notes.push(`GitHub API unavailable (${String(e.message).split("\n")[0]}); fell back to git log only.`); }
}
const report = computeReport({
  commits: git.commits, tags: git.tags, now, windowDays: days, ref,
  deployments: gh ? gh.deployments : undefined, incidents: gh ? gh.incidents : undefined, repo: gh?.slug ?? null,
});
if (!gh && !offline) report.source.mode = "offline";
report.notes.push(...notes);

const jf = opt("--json"), mf = opt("--md");
if (jf) writeFileSync(jf, JSON.stringify(report, null, 2) + "\n");
if (mf) writeFileSync(mf, toMarkdown(report));
if (!jf && !mf) process.stdout.write(opt("--format", "md") === "json" ? JSON.stringify(report, null, 2) + "\n" : toMarkdown(report));
