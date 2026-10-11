// DORA metrics (A2 rule 14). Pure computation over normalised inputs; collectors live below.
import { execFileSync } from "node:child_process";

export const SCHEMA = "outlet.dora.report/v1";
const HOUR = 3600e3, DAY = 24 * HOUR;
export const REWORK_WINDOW_DAYS = 7;

const CC_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<desc>.*)$/;
export function parseSubject(subject) {
  const rev = /^Revert\s+"(.*)"/i.exec(subject);
  if (rev) return { type: "revert", scope: null, desc: subject, reverts: rev[1] };
  const m = CC_RE.exec(subject);
  if (!m) return { type: "other", scope: null, desc: subject };
  const o = { type: m.groups.type, scope: m.groups.scope ?? null, desc: m.groups.desc };
  if (o.type === "hotfix" || /\b(?:hotfix|rollback|roll back)\b/i.test(subject)) o.hotfix = true;
  if (o.type === "revert") o.reverts = m.groups.desc.replace(/^"|"$/g, "");
  return o;
}

const NON_CHANGE = new Set(["docs", "chore", "style", "ci", "build", "test", "revert"]);

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const round = (n, d = 2) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const hours = (ms) => round(ms / HOUR);

export function bandDeployFreq(perDay) {
  if (perDay >= 1) return "elite";
  if (perDay >= 1 / 7) return "high";
  if (perDay >= 1 / 30) return "medium";
  return "low";
}
export function bandLeadTime(h) { if (h === null) return null; return h < 24 ? "elite" : h < 168 ? "high" : h < 720 ? "medium" : "low"; }
export function bandCfr(r) { if (r === null) return null; return r <= 0.05 ? "elite" : r <= 0.10 ? "high" : r <= 0.15 ? "medium" : "low"; }
export function bandRecovery(h) { if (h === null) return null; return h < 1 ? "elite" : h < 24 ? "high" : h < 168 ? "medium" : "low"; }

/**
 * @param {object} input
 * @param {{sha:string, authoredAt:string, committedAt:string, subject:string, parents?:string[]}[]} input.commits  commits on the ref, any order
 * @param {{name:string, sha:string, at:string}[]} [input.tags]  release tags (deployment proxy)
 * @param {{id:string, sha:string, at:string, ok:boolean}[]} [input.deployments]  GitHub deployments (production)
 * @param {{openedAt:string, closedAt:string|null}[]} [input.incidents]  GitHub issues labelled incident
 * @param {string} input.now ISO
 * @param {number} [input.windowDays]
 */
export function computeReport(input) {
  const now = Date.parse(input.now);
  const windowDays = input.windowDays ?? 90;
  const from = now - windowDays * DAY;
  const notes = [];
  const commits = input.commits
    .map((c) => ({ ...c, t: Date.parse(c.committedAt), ta: Date.parse(c.authoredAt), p: parseSubject(c.subject) }))
    .sort((a, b) => a.t - b.t);
  const inWin = commits.filter((c) => c.t >= from && c.t <= now);

  // ---- deployments
  let mode, proxy, deploys;
  if (input.deployments?.length) {
    mode = "github"; proxy = "github-deployment";
    deploys = input.deployments.map((d) => ({ at: Date.parse(d.at), sha: d.sha, ok: d.ok }));
  } else if (input.tags?.length) {
    mode = input.deployments ? "github" : "offline"; proxy = "tag";
    deploys = input.tags.map((d) => ({ at: Date.parse(d.at), sha: d.sha, ok: true }));
    notes.push("Deployments are release tags; no GitHub deployment events were available.");
  } else {
    mode = input.deployments ? "github" : "offline"; proxy = "commit";
    deploys = inWin.map((c) => ({ at: c.t, sha: c.sha, ok: true }));
    notes.push("No deployment events or release tags exist: every commit on the ref is counted as one deployment unit (integration frequency, not production deploys).");
  }
  deploys = deploys.filter((d) => d.at >= from && d.at <= now).sort((a, b) => a.at - b.at);

  // ---- deployment frequency
  const perDay = deploys.length / windowDays;
  const deploymentFrequency = { count: deploys.length, perDay: round(perDay, 3), perWeek: round(perDay * 7, 2), band: bandDeployFreq(perDay) };

  // ---- lead time
  let leadTimeForChanges = null;
  if (proxy === "commit") {
    const d = inWin.filter((c) => c.t >= c.ta).map((c) => c.t - c.ta);
    if (d.length) leadTimeForChanges = { medianHours: hours(median(d)), p90Hours: hours(percentile(d, 90)), sampleSize: d.length, basis: "authored-to-committed (proxy: no deploy events)", band: bandLeadTime(hours(median(d))) };
  } else {
    const byTime = deploys;
    const lts = [];
    let prev = -Infinity;
    for (const d of byTime) {
      for (const c of commits) if (c.t > prev && c.t <= d.at && !NON_CHANGE.has(c.p.type)) lts.push(d.at - c.ta);
      prev = d.at;
    }
    if (lts.length) leadTimeForChanges = { medianHours: hours(median(lts)), p90Hours: hours(percentile(lts, 90)), sampleSize: lts.length, basis: `commit authored to ${proxy}`, band: bandLeadTime(hours(median(lts))) };
  }
  if (!leadTimeForChanges) notes.push("Lead time unavailable: no deployments or no change commits in the window.");

  // ---- failures, rework, recovery
  const changes = inWin.filter((c) => !NON_CHANGE.has(c.p.type));
  const features = commits.filter((c) => c.p.type === "feat");
  const reworkWindow = REWORK_WINDOW_DAYS * DAY;
  const fixes = inWin.filter((c) => c.p.type === "fix");
  const reworkPairs = [];
  for (const f of fixes) {
    let target = null;
    for (const feat of features) {
      if (feat.t >= f.t || f.t - feat.t > reworkWindow) continue;
      if (f.p.scope && feat.p.scope && f.p.scope !== feat.p.scope) continue;
      if (!target || feat.t > target.t) target = feat; // nearest preceding feat
    }
    if (target) reworkPairs.push({ fix: f, feat: target });
  }
  const reworkRate = {
    ratio: changes.length ? round(reworkPairs.length / changes.length, 3) : null,
    reworkCommits: reworkPairs.length,
    changeCommits: changes.length,
    windowDays: REWORK_WINDOW_DAYS,
    basis: "fix commits landing within 7 days after a feat (same scope when both have one) / feat+fix+refactor+perf commits",
  };

  // failures: github deployments with ok=false, else revert/hotfix commits
  const failureCommits = inWin.filter((c) => c.p.type === "revert" || c.p.hotfix);
  let failures, cfBasis;
  if (proxy === "github-deployment") {
    failures = deploys.filter((d) => !d.ok).length; cfBasis = "failed GitHub deployment statuses";
  } else {
    failures = failureCommits.length; cfBasis = "revert/hotfix/rollback commits per deployment unit (proxy)";
  }
  const cfr = deploys.length ? failures / deploys.length : null;
  const changeFailureRate = { ratio: round(cfr, 3), failures, deployments: deploys.length, basis: cfBasis, band: bandCfr(cfr) };

  // recovery
  let timeToRecover = null;
  if (input.incidents?.length) {
    const d = input.incidents.filter((i) => i.closedAt && Date.parse(i.openedAt) >= from).map((i) => Date.parse(i.closedAt) - Date.parse(i.openedAt));
    if (d.length) timeToRecover = { medianHours: hours(median(d)), sampleSize: d.length, basis: "GitHub incident issues, opened to closed", band: bandRecovery(hours(median(d))) };
  }
  if (!timeToRecover) {
    const d = [];
    for (const c of failureCommits) {
      let origin = null;
      if (c.p.reverts) origin = commits.find((o) => o.t < c.t && o.p.desc === c.p.reverts || (o.t < c.t && o.subject === c.p.reverts));
      if (!origin) origin = [...commits].reverse().find((o) => o.t < c.t && ["feat", "fix", "refactor", "perf"].includes(o.p.type));
      if (origin) d.push(c.t - origin.t);
    }
    for (const { fix, feat } of reworkPairs) d.push(fix.t - feat.t);
    if (d.length) timeToRecover = { medianHours: hours(median(d)), sampleSize: d.length, basis: "feat commit to the fix/revert that repaired it (proxy)", band: bandRecovery(hours(median(d))) };
    else notes.push("Time to recover unavailable: no incidents, reverts or rework pairs in the window.");
  }

  // ---- weekly series (Mon-aligned UTC weeks)
  const weekStart = (t) => { const d = new Date(t); const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow); };
  const weeks = new Map();
  const w = (t) => { const k = weekStart(t); if (!weeks.has(k)) weeks.set(k, { weekStart: new Date(k).toISOString().slice(0, 10), deployments: 0, failures: 0, rework: 0 }); return weeks.get(k); };
  for (const d of deploys) { w(d.at).deployments++; if (proxy === "github-deployment" && !d.ok) w(d.at).failures++; }
  if (proxy !== "github-deployment") for (const c of failureCommits) w(c.t).failures++;
  for (const p of reworkPairs) w(p.fix.t).rework++;
  const series = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

  return {
    schema: SCHEMA,
    generatedAt: input.now,
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days: windowDays },
    source: { mode, deploymentProxy: proxy, repo: input.repo ?? null, ref: input.ref ?? null, commitsInWindow: inWin.length },
    metrics: { deploymentFrequency, leadTimeForChanges, changeFailureRate, timeToRecover, reworkRate },
    series,
    notes,
  };
}

export function toMarkdown(r) {
  const m = r.metrics;
  const f = (v, s = "") => (v === null || v === undefined ? "n/a" : `${v}${s}`);
  const lines = [
    `# DORA report`,
    ``,
    `Window: ${r.window.from.slice(0, 10)} to ${r.window.to.slice(0, 10)} (${r.window.days} days). Source: ${r.source.mode}, deployment proxy \`${r.source.deploymentProxy}\`, ${r.source.commitsInWindow} commits.`,
    ``,
    `| Metric | Value | Band | Basis |`,
    `|---|---|---|---|`,
    `| Deployment frequency | ${m.deploymentFrequency.count} (${m.deploymentFrequency.perWeek}/week) | ${m.deploymentFrequency.band} | ${r.source.deploymentProxy} |`,
    `| Lead time for changes | ${m.leadTimeForChanges ? `median ${f(m.leadTimeForChanges.medianHours, " h")}, p90 ${f(m.leadTimeForChanges.p90Hours, " h")} (n=${m.leadTimeForChanges.sampleSize})` : "n/a"} | ${f(m.leadTimeForChanges?.band)} | ${m.leadTimeForChanges?.basis ?? "-"} |`,
    `| Change failure rate | ${m.changeFailureRate.ratio === null ? "n/a" : `${(m.changeFailureRate.ratio * 100).toFixed(1)}% (${m.changeFailureRate.failures}/${m.changeFailureRate.deployments})`} | ${f(m.changeFailureRate.band)} | ${m.changeFailureRate.basis} |`,
    `| Time to recover | ${m.timeToRecover ? `median ${f(m.timeToRecover.medianHours, " h")} (n=${m.timeToRecover.sampleSize})` : "n/a"} | ${f(m.timeToRecover?.band)} | ${m.timeToRecover?.basis ?? "-"} |`,
    `| Rework rate | ${m.reworkRate.ratio === null ? "n/a" : `${(m.reworkRate.ratio * 100).toFixed(1)}% (${m.reworkRate.reworkCommits}/${m.reworkRate.changeCommits})`} | - | ${m.reworkRate.basis} |`,
    ``,
    `## Weekly`,
    ``,
    `| Week | Deployments | Failures | Rework |`,
    `|---|---|---|---|`,
    ...r.series.map((s) => `| ${s.weekStart} | ${s.deployments} | ${s.failures} | ${s.rework} |`),
  ];
  if (r.notes.length) lines.push(``, `## Notes`, ``, ...r.notes.map((n) => `- ${n}`));
  return lines.join("\n") + "\n";
}

// ---------- collectors
export function collectGit(repoDir, ref = "HEAD", exec = execFileSync) {
  const out = exec("git", ["-C", repoDir, "log", ref, "--format=%H%x1f%aI%x1f%cI%x1f%P%x1f%s%x1e"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const commits = out.split("\x1e").map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [sha, authoredAt, committedAt, parents, subject] = rec.split("\x1f");
    return { sha, authoredAt, committedAt, parents: parents ? parents.split(" ") : [], subject };
  });
  let tags = [];
  try {
    const t = exec("git", ["-C", repoDir, "for-each-ref", "refs/tags", "--format=%(refname:short)|%(*objectname)%(objectname)|%(creatordate:iso-strict)"], { encoding: "utf8" });
    tags = t.split("\n").filter(Boolean).map((l) => { const [name, sha, at] = l.split("|"); return { name, sha: sha.slice(0, 40), at }; }).filter((x) => /^v?\d/.test(x.name));
  } catch { /* no tags */ }
  return { commits, tags };
}

export function collectGithub(repoDir, run = (args) => execFileSync("gh", args, { cwd: repoDir, encoding: "utf8", maxBuffer: 64 << 20 })) {
  const api = (p) => {
    const raw = run(["api", p, "--paginate"]);
    // --paginate concatenates JSON arrays: "][" boundaries
    return JSON.parse("[" + raw.replace(/\]\s*\[/g, "],[").replace(/^\[|\]$/g, "") + "]").flat();
  };
  const repo = JSON.parse(run(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]));
  const slug = repo.nameWithOwner;
  const deployments = [];
  for (const d of api(`repos/${slug}/deployments?environment=production&per_page=100`)) {
    const st = api(`repos/${slug}/deployments/${d.id}/statuses?per_page=1`)[0];
    if (!st || ["queued", "in_progress", "pending"].includes(st.state)) continue;
    deployments.push({ id: String(d.id), sha: d.sha, at: d.created_at, ok: st.state === "success" });
  }
  const incidents = api(`repos/${slug}/issues?labels=incident&state=all&per_page=100`).filter((i) => !i.pull_request).map((i) => ({ openedAt: i.created_at, closedAt: i.closed_at }));
  return { slug, defaultBranch: repo.defaultBranchRef?.name ?? null, deployments, incidents };
}
