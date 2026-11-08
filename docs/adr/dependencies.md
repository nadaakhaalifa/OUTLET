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

## E-05 (auth-core, 2026-11-08)

| Package | Purpose | First published | Licence |
|---|---|---|---|
| jose | ES256 access JWT sign/verify (Web Crypto, zero dependencies, no native code); used only in packages/auth-core | 2018-07 | MIT |

Passkeys (WebAuthn) and Apple/Google OIDC are ports and Zod DTOs only in auth-core; `@simplewebauthn/server` will be proposed with the HTTP layer. OTP codes use `node:crypto` `randomInt`; refresh tokens use `randomBytes(32)` + SHA-256. No other new dependencies.

## E-09 (privacy, 2026-11-08)

| Package | Purpose | First published | Licence |
|---|---|---|---|
| yaml | Parses `data_inventory.yaml` to derive the DSAR export field list (P2/P3 columns) in packages/privacy; YAML 1.2, zero dependencies | 2013-01 | ISC |

packages/privacy otherwise uses workspace packages (`@outlet/db`, `ids`, `logger`, `outbox`) and `zod`.

## E-11 (flags and observability, 2026-11-08)

| Package | Purpose | First published | Licence |
|---|---|---|---|
| @openfeature/server-sdk | OpenFeature server API; we ship our own `Provider` over the Postgres flag store (about 280 KB, no heavy deps) | 2022-10 | Apache-2.0 |
| @opentelemetry/api | Tracing/metrics/baggage API | 2019-03 | Apache-2.0 |
| @opentelemetry/sdk-node | Node SDK bootstrap (`initTelemetry`) | 2020-08 | Apache-2.0 |
| @opentelemetry/sdk-trace | Span processors and in-memory exporter for tests (3.x name of sdk-trace-base) | 2025 line; sdk-trace-base 2019-03 | Apache-2.0 |
| @opentelemetry/sdk-metrics | MeterProvider, readers, in-memory metric exporter | 2021-01 | Apache-2.0 |
| @opentelemetry/exporter-trace-otlp-http | OTLP/HTTP trace exporter | 2020-08 | Apache-2.0 |
| @opentelemetry/exporter-metrics-otlp-http | OTLP/HTTP metric exporter | 2021-01 | Apache-2.0 |
| @opentelemetry/resources | Resource attributes | 2019-03 | Apache-2.0 |
| @opentelemetry/core, @opentelemetry/context-async-hooks, @opentelemetry/semantic-conventions | Propagators/baggage, async context, attribute names | 2019-03 / 2019-03 / 2019-03 | Apache-2.0 |

Note: `@opentelemetry/sdk-trace@3.0.0` is a recent major (rename of sdk-trace-base); the 3.x line was needed to match sdk-node 0.300. `pnpm add` reports `protobufjs` build script ignored; it stays blocked (not needed at runtime). Dates are first publish of the package name and were not re-verified online. Local stack images (docker, unpinned-by-digest): otel/opentelemetry-collector-contrib 0.136.0, grafana/tempo 2.8.2, prom/prometheus v3.5.0, grafana/grafana 12.2.0.

## E-07 (ledger core, 2026-11-08)

No new third-party packages. `packages/ledger` (`@outlet/ledger`) uses workspace packages only (`@outlet/db`, `idempotency`, `ids`, `money`, `outbox`) plus `zod`, `fast-check` and `vitest` already in the root table. Hashing uses `node:crypto` (SHA-256).

## E-10 (i18n, ui-tokens, ui-web, 2026-11-08)

| Package | Purpose | First published | Licence |
|---|---|---|---|
| intl-messageformat | ICU MessageFormat runtime for `@outlet/i18n` (plurals incl. Arabic one/two/few/many/other, number formatting). Chosen over `@formatjs/intl`: same formatjs engine, but no React or cache/provider layer, so one small dependency serves server, web and (later) Expo; plural and number handling comes from native `Intl` | 2014-09 | BSD-3-Clause |
| react, react-dom | UI runtime for `@outlet/ui-web` (React 19) | 2011-10 / 2013-06 | MIT |
| @types/react, @types/react-dom | React type definitions (dev) | 2016-05 | MIT |
| jsdom | DOM for component tests (dev) | 2011-12 | MIT |
| @testing-library/react, @testing-library/dom | Component rendering and queries in tests (dev; dom is its peer) | 2018-03 / 2018-07 | MIT |
| axe-core | Accessibility rules run on every component in both directions (dev). Used directly instead of the stale `vitest-axe` wrapper; colour contrast is checked on tokens instead because jsdom has no layout | 2015-07 | MPL-2.0 |

`@outlet/ui-web` uses plain CSS Modules over the generated CSS custom properties (`@outlet/ui-tokens/tokens.css`): no CSS-in-JS runtime, no build plugin, logical properties for RTL, and it works unchanged under Next.js SSR. vanilla-extract was rejected as it adds a compiler plugin to every consumer for no benefit at this size. Dates are first publish of the package name and were not re-verified online.
| minimatch (override to 11.0.1) | fixes GHSA-g3hv-75wg-m249 ReDoS in dev tooling transitive; pnpm override in pnpm-workspace.yaml | 2011-09 | ISC |
