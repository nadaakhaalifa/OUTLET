# Dependency audit exceptions

CI runs `pnpm audit --audit-level high --prod` and an OSV scan. The threshold is unchanged. Two high advisories are accepted, owner-approved on 2026-10-20, revisit by 2026-12-31.

| Advisory | Package | Vulnerable | Patched on npm | Why accepted |
|---|---|---|---|---|
| GHSA-86w9-cpqp-85rv | node-forge | <=1.4.0 | none (latest 1.4.0) | Only reachable through `apps/mobile > expo > @expo/cli` (build-time code signing). Never bundled into the app or run in the API. |
| GHSA-vfj7-8cjw-p6xm | braces | <=3.0.3 | none (latest 3.0.3) | Only reachable through Metro (`micromatch`) in the mobile build tooling. Input is repo file globs, not user input. |

A pnpm override was checked first and is impossible: no version >= the patched one is published.

Mechanism: `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` and `osv-scanner.toml` (`ignoreUntil = 2026-12-31`, so OSV fails again after the date). On revisit: run `npm view node-forge version` and `npm view braces version`, add an override if fixed, and delete the entries.

Any other advisory is not covered and must fail the job.

## Dev/test-only exceptions added 2026-10-20 (OSV only; `pnpm audit --prod` does not see them)

| Advisory | Package | Path | Why accepted | Revisit |
|---|---|---|---|---|
| GHSA-82fw-gwwq-j7x9 | vitest, @vitest/mocker 3.2.7 | devDependency of every workspace package, Stryker runner | Test runner only, never shipped. Needs attacker-controlled test code. Fix is vitest 4.1.11 (major). | Plan a repo-wide vitest 4 upgrade (check @stryker-mutator/vitest-runner and @vitest/coverage-v8 support), then delete the entry. |
| GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | tinypool 1.1.1 | vitest 3 workers | Test workers only. Fix is tinypool 2.1.2, which vitest 3 does not accept. | Resolved by the vitest 4 upgrade. |
| GHSA-hp3w-g68c-fv3c | sprintf-js 1.1.3 | ioredis-mock > fengari (api tests) | Test double only. No patched release. | `npm view sprintf-js version`; drop ioredis-mock or add an override once fixed. |

## Fixed by override or patch (no exception)

- qs 6.15.1 (stryker > typed-rest-client) and uuid 7.0.3 (expo config-plugins > xcode, build time): overrides in `pnpm-workspace.yaml` to qs 6.16.0 and uuid 11.1.1.
- decode-uri-component 0.2.2 (runtime: expo-router > query-string 7.1.3): override to 0.5.0, which is ESM-only with a default export, so `patches/query-string@7.1.3.patch` unwraps `.default`. Remove both when expo-router moves to a query-string release that supports decode-uri-component 0.5.
