# Dependency notes (ADR-lite)

One line per new dependency: name, purpose, package first published (all older than 90 days), licence. Added 2026-11-08 for E-01/E-14. Versions are pinned by `pnpm-lock.yaml`; installs honour `minimumReleaseAge` (7 days).

| Package | Purpose | First published | Licence |
|---|---|---|---|
| typescript | Compiler, strict typecheck | 2012-10 | Apache-2.0 |
| eslint, @eslint/js | Linter and base rules | 2013-07 / 2023-01 | MIT |
| typescript-eslint | Strict type-checked lint rules | 2019-08 | MIT |
| dependency-cruiser | Architecture fitness functions (A2.3) | 2016-11 | MIT |
| turbo | Monorepo task runner and cache | 2013-05 (npm name) | MIT |
| vitest, @vitest/coverage-v8 | Unit tests and coverage thresholds | 2021-12 / 2023-06 | MIT |
| fast-check | Property-based tests (money, ledger) | 2017-12 | MIT |
| zod | Runtime validation at every boundary | 2020-03 | MIT |
| @types/node | Node type definitions | 2016-05 | MIT |
| @electric-sql/pglite | In-process Postgres (WASM) for integration tests in packages/db, outbox, idempotency; **tests only, never a runtime dependency** (E-08) | 2022-09 | Apache-2.0 / PostgreSQL |

Note: majors resolved at install are turbo 2.x, typescript 6.0 (pinned `~6.0.3`; typescript-eslint does not support TS 7.0 yet) and vitest 5.x; first-published dates are for the package name. Build scripts stay blocked except esbuild. The SBOM uses pnpm's built-in `pnpm sbom --sbom-format cyclonedx`; `@cyclonedx/cyclonedx-npm` was tried and dropped because it cannot parse pnpm's `npm ls` output. packages/logger and packages/audit-log add no dependencies (zero-dep logger, node:crypto).
