# Dependency audit exceptions

CI runs `pnpm audit --audit-level high --prod` and an OSV scan. The threshold is unchanged. Two high advisories are accepted, owner-approved on 2026-10-20, revisit by 2026-12-31.

| Advisory | Package | Vulnerable | Patched on npm | Why accepted |
|---|---|---|---|---|
| GHSA-86w9-cpqp-85rv | node-forge | <=1.4.0 | none (latest 1.4.0) | Only reachable through `apps/mobile > expo > @expo/cli` (build-time code signing). Never bundled into the app or run in the API. |
| GHSA-vfj7-8cjw-p6xm | braces | <=3.0.3 | none (latest 3.0.3) | Only reachable through Metro (`micromatch`) in the mobile build tooling. Input is repo file globs, not user input. |

A pnpm override was checked first and is impossible: no version >= the patched one is published.

Mechanism: `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` and `osv-scanner.toml` (`ignoreUntil = 2026-12-31`, so OSV fails again after the date). On revisit: run `npm view node-forge version` and `npm view braces version`, add an override if fixed, and delete the entries.

Any other advisory is not covered and must fail the job.
