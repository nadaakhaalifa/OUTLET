import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeReport, parseSubject, collectGit, collectGithub, toMarkdown, SCHEMA } from "../lib.mjs";

function fixtureRepo(entries, tags = []) {
  const dir = mkdtempSync(join(tmpdir(), "dora-"));
  const git = (args, date) => execFileSync("git", ["-C", dir, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...(date ? { GIT_AUTHOR_DATE: date.author, GIT_COMMITTER_DATE: date.commit } : {}) },
    encoding: "utf8",
  });
  git(["init", "-q", "-b", "main"]);
  entries.forEach(([subject, commit, author], i) => {
    writeFileSync(join(dir, "f.txt"), String(i));
    git(["add", "."]);
    git(["commit", "-q", "-m", subject], { author: author ?? commit, commit });
  });
  for (const [name, at] of tags) git(["tag", "-a", name, "-m", name], { author: at, commit: at });
  return dir;
}

test("parseSubject", () => {
  assert.deepEqual(parseSubject("feat(api): add x"), { type: "feat", scope: "api", desc: "add x" });
  assert.equal(parseSubject("fix!: y").type, "fix");
  assert.equal(parseSubject('Revert "feat: x"').type, "revert");
  assert.equal(parseSubject("hotfix: nope").hotfix, true);
  assert.equal(parseSubject("fix: hotfix for prod").hotfix, true);
});

test("offline fixture repo: frequency, rework, failure, recovery", () => {
  const repo = fixtureRepo([
    ["feat(api): a", "2026-10-01T10:00:00Z"],
    ["feat(api): b", "2026-10-02T10:00:00Z", "2026-10-02T08:00:00Z"],
    ["fix(api): b broke", "2026-10-02T12:00:00Z"],
    ["fix(ui): unrelated scope", "2026-10-03T12:00:00Z"],
    ["docs: x", "2026-10-04T12:00:00Z"],
    ['Revert "feat(api): a"', "2026-10-05T10:00:00Z"],
    ["fix(api): late", "2026-10-20T10:00:00Z"],
  ]);
  const { commits, tags } = collectGit(repo);
  assert.equal(commits.length, 7);
  const r = computeReport({ commits, tags, now: "2026-10-22T00:00:00Z", windowDays: 30 });
  assert.equal(r.schema, SCHEMA);
  assert.equal(r.source.deploymentProxy, "commit");
  assert.equal(r.metrics.deploymentFrequency.count, 7);
  assert.equal(r.metrics.deploymentFrequency.perWeek, 1.63);
  // change commits = feat a, feat b, fix b, fix ui, fix late = 5 (docs/revert excluded)
  assert.equal(r.metrics.reworkRate.changeCommits, 5);
  // fix(api) b within 2h of feat(api) b -> rework. fix(ui) has a different scope than every feat -> no. late fix is >7d -> no.
  assert.equal(r.metrics.reworkRate.reworkCommits, 1);
  assert.equal(r.metrics.changeFailureRate.failures, 1);
  assert.equal(r.metrics.changeFailureRate.deployments, 7);
  assert.ok(Math.abs(r.metrics.changeFailureRate.ratio - 0.143) < 1e-9);
  // recovery: revert of feat a = 4 days (96h), rework pair = 2h -> median 49h
  assert.equal(r.metrics.timeToRecover.sampleSize, 2);
  assert.equal(r.metrics.timeToRecover.medianHours, 49);
  // lead time proxy: one commit authored 2h before commit time
  assert.equal(r.metrics.leadTimeForChanges.p90Hours, 2);
  assert.ok(r.series.length >= 3);
  assert.match(toMarkdown(r), /\| Deployment frequency \| 7 /);
});

test("tags are the deployment proxy and drive lead time", () => {
  const repo = fixtureRepo(
    [["feat: a", "2026-10-01T00:00:00Z"], ["feat: b", "2026-10-03T00:00:00Z"], ["fix: c", "2026-10-03T06:00:00Z"]],
    [["v0.1.0", "2026-10-04T00:00:00Z"]],
  );
  const { commits, tags } = collectGit(repo);
  assert.equal(tags.length, 1);
  const r = computeReport({ commits, tags, now: "2026-10-10T00:00:00Z", windowDays: 30 });
  assert.equal(r.source.deploymentProxy, "tag");
  assert.equal(r.metrics.deploymentFrequency.count, 1);
  // lead times: 72h, 24h, 18h -> median 24
  assert.equal(r.metrics.leadTimeForChanges.medianHours, 24);
  assert.equal(r.metrics.leadTimeForChanges.sampleSize, 3);
});

test("github mode: failed deployments and incidents", () => {
  const commits = [{ sha: "a", authoredAt: "2026-10-01T00:00:00Z", committedAt: "2026-10-01T00:00:00Z", subject: "feat: a" }];
  const r = computeReport({
    commits, now: "2026-10-10T00:00:00Z", windowDays: 10,
    deployments: [
      { id: "1", sha: "a", at: "2026-10-02T00:00:00Z", ok: true },
      { id: "2", sha: "a", at: "2026-10-03T00:00:00Z", ok: false },
      { id: "3", sha: "a", at: "2026-10-04T00:00:00Z", ok: true },
      { id: "4", sha: "a", at: "2026-10-05T00:00:00Z", ok: true },
    ],
    incidents: [{ openedAt: "2026-10-03T00:00:00Z", closedAt: "2026-10-03T00:30:00Z" }],
  });
  assert.equal(r.source.mode, "github");
  assert.equal(r.metrics.changeFailureRate.ratio, 0.25);
  assert.equal(r.metrics.changeFailureRate.band, "low");
  assert.equal(r.metrics.timeToRecover.medianHours, 0.5);
  assert.equal(r.metrics.timeToRecover.band, "elite");
  assert.equal(r.metrics.deploymentFrequency.band, "high");
  assert.equal(r.metrics.leadTimeForChanges.medianHours, 24);
});

test("collectGithub with injected gh runner", () => {
  const run = (args) => {
    const p = args.join(" ");
    if (p.startsWith("repo view")) return JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } });
    if (p.includes("/statuses")) return JSON.stringify([{ state: "success" }]);
    if (p.includes("/deployments?")) return JSON.stringify([{ id: 9, sha: "abc", created_at: "2026-10-02T00:00:00Z" }]);
    if (p.includes("/issues?")) return JSON.stringify([{ created_at: "2026-10-01T00:00:00Z", closed_at: "2026-10-01T01:00:00Z" }, { pull_request: {}, created_at: "x", closed_at: null }]);
    throw new Error("unexpected " + p);
  };
  const g = collectGithub(".", run);
  assert.equal(g.slug, "o/r");
  assert.deepEqual(g.deployments, [{ id: "9", sha: "abc", at: "2026-10-02T00:00:00Z", ok: true }]);
  assert.equal(g.incidents.length, 1);
});

test("empty history does not throw", () => {
  const r = computeReport({ commits: [], now: "2026-10-10T00:00:00Z" });
  assert.equal(r.metrics.deploymentFrequency.count, 0);
  assert.equal(r.metrics.changeFailureRate.ratio, null);
  assert.equal(r.metrics.reworkRate.ratio, null);
  assert.equal(r.metrics.leadTimeForChanges, null);
});
