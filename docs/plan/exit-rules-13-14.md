# Exit rules 13 and 14: status

Closes the two MISSING rows in `phase-0-exit-checklist.md` (A2 rules 13 and 14).

## Rule 13: copy-lint (DONE, tooling and CI; wired to repo)
- `tooling/copy-lint/` (AST-based, offline, ~0.2 s), workflow `.github/workflows/copy-lint.yml`, docs `docs/engineering/copy-lint.md`.
- 13 node:test tests: positive and negative cases in EN and AR, Eastern Arabic digits, templated-number negatives, allowlist justification, fixtures.
- Real run over `packages/i18n/src`, `apps/mobile/src`, `apps/seller-web/src`, `apps/admin-web/src` (190 files): 0 findings after one rule fix (a first run flagged the truthful "no coins about to expire" AR string; the over-broad pattern was removed). No true positives in the current repo.
- Gap: pattern-based; cannot verify a templated number is truthful. Not yet added to the root `package.json` scripts or `ci.yml` (those files belong to other owners); the standalone workflow runs it.

## Rule 14: DORA (DONE as collector and contract; dashboard not built)
- `tooling/dora/`, workflow `.github/workflows/dora.yml` (weekly), docs `docs/engineering/dora.md` with schema `outlet.dora.report/v1`.
- Real run (git log, 90 days to 2026-10-11, repo has no deployments, tags or incidents): 22 commits, deployment frequency 22 units (1.71/week, proxy: commits), lead time proxy 0 h (authored-to-committed), change failure rate 0/22, time to recover 1.67 h (n=1), rework rate 7.1% (1/14). These describe integration cadence only.
- Gap: the Admin engineering dashboard page that renders the JSON does not exist; the deploy pipeline must emit GitHub Deployments (environment `production`) and `incident` labels for real numbers.
