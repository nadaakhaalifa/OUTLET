# DORA metrics (A2 rule 14)

Run: `node tooling/dora/dora.mjs [--offline] [--days 90] [--ref HEAD] [--now <iso>] [--json out.json] [--md out.md]`. Without output flags it prints markdown (`--format json` for JSON). Tests (fixture git repos in a temp dir): `node --test tooling/dora/test/*.test.mjs`. CI: `.github/workflows/dora.yml` (weekly, uploads `dora-report.json` and `.md`).

## Sources
- **Online (default):** git log plus the GitHub API through `gh`: production deployments and their latest status, issues labelled `incident`. If `gh` fails, it falls back to git only and says so in `notes`.
- **`--offline`:** git log only. Conventional commits drive the proxies.

## Definitions
| Metric | Online | Offline proxy |
|---|---|---|
| Deployment frequency | production deployments in the window | release tags (`v*`/numeric) if any, else every commit on the ref (integration frequency, labelled) |
| Lead time for changes | commit authored to deployment, for change commits (not docs/chore/ci/build/test/style/revert) | same against tags; with no tags, authored-to-committed delta |
| Change failure rate | deployments whose status is not success / deployments | revert, hotfix and rollback commits / deployment units |
| Time to recover | incident issue opened to closed | feat commit to the revert or fix that repaired it |
| Rework rate | fix commits within 7 days after a feat (same scope when both have one) / change commits | same |

Bands (`elite|high|medium|low`) are indicative thresholds from the DORA four-keys guidance, not an assessment. Change commits = feat, fix, refactor, perf and unknown types.

## Dashboard contract: `outlet.dora.report/v1`
```jsonc
{
  "schema": "outlet.dora.report/v1",
  "generatedAt": "ISO-8601",
  "window": { "from": "ISO", "to": "ISO", "days": 90 },
  "source": { "mode": "offline|github", "deploymentProxy": "github-deployment|tag|commit", "repo": "owner/name|null", "ref": "HEAD", "commitsInWindow": 22 },
  "metrics": {
    "deploymentFrequency": { "count": 0, "perDay": 0, "perWeek": 0, "band": "elite|high|medium|low" },
    "leadTimeForChanges": null | { "medianHours": 0, "p90Hours": 0, "sampleSize": 0, "basis": "string", "band": "..." },
    "changeFailureRate": { "ratio": null | 0.0, "failures": 0, "deployments": 0, "basis": "string", "band": null | "..." },
    "timeToRecover": null | { "medianHours": 0, "sampleSize": 0, "basis": "string", "band": "..." },
    "reworkRate": { "ratio": null | 0.0, "reworkCommits": 0, "changeCommits": 0, "windowDays": 7, "basis": "string" }
  },
  "series": [ { "weekStart": "YYYY-MM-DD (Monday, UTC)", "deployments": 0, "failures": 0, "rework": 0 } ],
  "notes": [ "string" ]
}
```
Rules for the consumer: render `basis` and `source.deploymentProxy` next to every number (a proxy must never look like a production deploy metric); `null` means "not measurable", never zero. Breaking changes bump the `/vN` suffix.

## Honest limits
There is no deploy pipeline yet, so until real deployments exist the numbers describe integration cadence and commit hygiene. Wire `deploy` jobs to the GitHub Deployments API (environment `production`) and label incidents `incident` to make every metric real.
