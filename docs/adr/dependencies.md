w2qp-rph6-63g4, 389g-gv7q-r4x8 |# Dependency notes (ADR-lite)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |One line per new dependency: name, purpose, package first published (all older than 90 days), licence. Added 2026-11-08 for E-01/E-14. Versions are pinned by `pnpm-lock.yaml`; installs honour `minimumReleaseAge` (7 days).
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || Package | Purpose | First published | Licence |
w2qp-rph6-63g4, 389g-gv7q-r4x8 ||---|---|---|---|
w2qp-rph6-63g4, 389g-gv7q-r4x8 || typescript | Compiler, strict typecheck | 2012-10 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || eslint, @eslint/js | Linter and base rules | 2013-07 / 2023-01 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || typescript-eslint | Strict type-checked lint rules | 2019-08 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || dependency-cruiser | Architecture fitness functions (A2.3) | 2016-11 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || turbo | Monorepo task runner and cache | 2013-05 (npm name) | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || vitest, @vitest/coverage-v8 | Unit tests and coverage thresholds | 2021-12 / 2023-06 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || fast-check | Property-based tests (money, ledger) | 2017-12 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || zod | Runtime validation at every boundary | 2020-03 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @types/node | Node type definitions | 2016-05 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @electric-sql/pglite | In-process Postgres (WASM) for integration tests in packages/db, outbox, idempotency; **tests only, never a runtime dependency** (E-08) | 2022-09 | Apache-2.0 / PostgreSQL |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |Note: majors resolved at install are turbo 2.x, typescript 6.0 (pinned `~6.0.3`; typescript-eslint does not support TS 7.0 yet) and vitest 5.x; first-published dates are for the package name. Build scripts stay blocked except esbuild. The SBOM uses pnpm's built-in `pnpm sbom --sbom-format cyclonedx`; `@cyclonedx/cyclonedx-npm` was tried and dropped because it cannot parse pnpm's `npm ls` output. packages/logger and packages/audit-log add no dependencies (zero-dep logger, node:crypto).
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## E-05 (auth-core, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || Package | Purpose | First published | Licence |
w2qp-rph6-63g4, 389g-gv7q-r4x8 ||---|---|---|---|
w2qp-rph6-63g4, 389g-gv7q-r4x8 || jose | ES256 access JWT sign/verify (Web Crypto, zero dependencies, no native code); used only in packages/auth-core | 2018-07 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |Passkeys (WebAuthn) and Apple/Google OIDC are ports and Zod DTOs only in auth-core; `@simplewebauthn/server` will be proposed with the HTTP layer. OTP codes use `node:crypto` `randomInt`; refresh tokens use `randomBytes(32)` + SHA-256. No other new dependencies.
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## E-09 (privacy, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || Package | Purpose | First published | Licence |
w2qp-rph6-63g4, 389g-gv7q-r4x8 ||---|---|---|---|
w2qp-rph6-63g4, 389g-gv7q-r4x8 || yaml | Parses `data_inventory.yaml` to derive the DSAR export field list (P2/P3 columns) in packages/privacy; YAML 1.2, zero dependencies | 2013-01 | ISC |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |packages/privacy otherwise uses workspace packages (`@outlet/db`, `ids`, `logger`, `outbox`) and `zod`.
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## E-11 (flags and observability, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || Package | Purpose | First published | Licence |
w2qp-rph6-63g4, 389g-gv7q-r4x8 ||---|---|---|---|
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @openfeature/server-sdk | OpenFeature server API; we ship our own `Provider` over the Postgres flag store (about 280 KB, no heavy deps) | 2022-10 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @opentelemetry/api | Tracing/metrics/baggage API | 2019-03 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @opentelemetry/sdk-node | Node SDK bootstrap (`initTelemetry`) | 2020-08 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @opentelemetry/sdk-trace | Span processors and in-memory exporter for tests (3.x name of sdk-trace-base) | 2025 line; sdk-trace-base 2019-03 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @opentelemetry/sdk-metrics | MeterProvider, readers, in-memory metric exporter | 2021-01 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @opentelemetry/exporter-trace-otlp-http | OTLP/HTTP trace exporter | 2020-08 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @opentelemetry/exporter-metrics-otlp-http | OTLP/HTTP metric exporter | 2021-01 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @opentelemetry/resources | Resource attributes | 2019-03 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @opentelemetry/core, @opentelemetry/context-async-hooks, @opentelemetry/semantic-conventions | Propagators/baggage, async context, attribute names | 2019-03 / 2019-03 / 2019-03 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |Note: `@opentelemetry/sdk-trace@3.0.0` is a recent major (rename of sdk-trace-base); the 3.x line was needed to match sdk-node 0.300. `pnpm add` reports `protobufjs` build script ignored; it stays blocked (not needed at runtime). Dates are first publish of the package name and were not re-verified online. Local stack images (docker, unpinned-by-digest): otel/opentelemetry-collector-contrib 0.136.0, grafana/tempo 2.8.2, prom/prometheus v3.5.0, grafana/grafana 12.2.0.
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## E-07 (ledger core, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |No new third-party packages. `packages/ledger` (`@outlet/ledger`) uses workspace packages only (`@outlet/db`, `idempotency`, `ids`, `money`, `outbox`) plus `zod`, `fast-check` and `vitest` already in the root table. Hashing uses `node:crypto` (SHA-256).
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## E-10 (i18n, ui-tokens, ui-web, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || Package | Purpose | First published | Licence |
w2qp-rph6-63g4, 389g-gv7q-r4x8 ||---|---|---|---|
w2qp-rph6-63g4, 389g-gv7q-r4x8 || intl-messageformat | ICU MessageFormat runtime for `@outlet/i18n` (plurals incl. Arabic one/two/few/many/other, number formatting). Chosen over `@formatjs/intl`: same formatjs engine, but no React or cache/provider layer, so one small dependency serves server, web and (later) Expo; plural and number handling comes from native `Intl` | 2014-09 | BSD-3-Clause |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || react, react-dom | UI runtime for `@outlet/ui-web` (React 19) | 2011-10 / 2013-06 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @types/react, @types/react-dom | React type definitions (dev) | 2016-05 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || jsdom | DOM for component tests (dev) | 2011-12 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @testing-library/react, @testing-library/dom | Component rendering and queries in tests (dev; dom is its peer) | 2018-03 / 2018-07 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || axe-core | Accessibility rules run on every component in both directions (dev). Used directly instead of the stale `vitest-axe` wrapper; colour contrast is checked on tokens instead because jsdom has no layout | 2015-07 | MPL-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |`@outlet/ui-web` uses plain CSS Modules over the generated CSS custom properties (`@outlet/ui-tokens/tokens.css`): no CSS-in-JS runtime, no build plugin, logical properties for RTL, and it works unchanged under Next.js SSR. vanilla-extract was rejected as it adds a compiler plugin to every consumer for no benefit at this size. Dates are first publish of the package name and were not re-verified online.
w2qp-rph6-63g4, 389g-gv7q-r4x8 || minimatch (override to 11.0.1) | fixes GHSA-g3hv-75wg-m249 ReDoS in dev tooling transitive; pnpm override in pnpm-workspace.yaml | 2011-09 | ISC |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## E-13 (apps/web shell, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || Package | Purpose | Version / first published | Licence |
w2qp-rph6-63g4, 389g-gv7q-r4x8 ||---|---|---|---|
w2qp-rph6-63g4, 389g-gv7q-r4x8 || next | Web framework for `apps/web` (App Router, SSR, tag revalidation). Pinned exactly: 16.4.3, released 2026-10-23 (16 days old at install; `minimumReleaseAge` enforced by pnpm). Built with `--webpack` because Turbopack cannot resolve the workspace packages' `./x.js` specifiers to `x.ts` | 16.4.3 / 2016-10 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @playwright/test | Smoke e2e for `apps/web` (dev). 1.64.1 (2026-10-14); 1.65.0 was rejected by `minimumReleaseAge` | 1.64.1 / 2020-01 | Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || IBM Plex Sans and IBM Plex Sans Arabic (4 woff2 files in `apps/web/src/fonts`, copied from `@fontsource` 5.3.0, not a dependency) | Self-hosted fonts through `next/font/local`; no Google Fonts request at build or runtime | 5.3.0 | OFL-1.1 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |react, react-dom, zod, jsdom, @testing-library/* are already in the table above. `@lhci/cli` is NOT added: `apps/web/lighthouserc.json` is config only; add the dependency when the CI job is wired.
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## P1-04 (search-bakeoff, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || Package | Purpose | First published | Licence |
w2qp-rph6-63g4, 389g-gv7q-r4x8 ||---|---|---|---|
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @electric-sql/pglite (devDependency of packages/search-bakeoff) | In-process Postgres for the Postgres FTS adapter tests and the offline bake-off run; contrib `unaccent` and `pg_trgm` used; **tests and the bake-off CLI only** | 2022-09 | Apache-2.0 / PostgreSQL |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |No other npm dependencies: the Typesense, Meilisearch and OpenSearch adapters use the built-in `fetch`. Engine images (docker-compose.search.yml, dev only): `typesense/typesense:27.1` (GPL-3.0), `getmeili/meilisearch:v1.12.0` (MIT, some BUSL parts), `opensearchproject/opensearch:2.18.0` (Apache-2.0); licences are verify-register V67, tags to be confirmed before the run.
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## P1-01c (packages/media, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || Package | Purpose | Version / first published | Licence |
w2qp-rph6-63g4, 389g-gv7q-r4x8 ||---|---|---|---|
w2qp-rph6-63g4, 389g-gv7q-r4x8 || sharp | Decode, strip metadata, resize and re-encode (AVIF, WebP, JPEG) in the upload pipeline. Pinned exactly. **Native binary**: ships prebuilt libvips through `@img/sharp-*` optionalDependencies (no install script); the deploy image must match the build platform/libc. Decoding untrusted images is a memory/CPU risk: pixel cap `limitInputPixels` is set in code | 0.35.5 / 2013-02 | Apache-2.0 (libvips LGPL-3.0, dynamically linked prebuilt) |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || file-type | Magic-byte content sniffing (declared MIME is never trusted). Pinned exactly | 22.0.0 / 2014-09 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## P1-03a (pricing-integrity, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |No new third-party packages. `@outlet/pricing-integrity` depends on workspace packages `@outlet/db`, `@outlet/ids`, `@outlet/money`, `@outlet/outbox` and the already listed `zod`; its tests use the already listed `fast-check` and `@electric-sql/pglite` (via `@outlet/db/testing`).
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## P1 HTTP layer (apps/api, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || Package | Purpose | Version / first published | Licence |
w2qp-rph6-63g4, 389g-gv7q-r4x8 ||---|---|---|---|
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @nestjs/common, @nestjs/core | Modular monolith HTTP framework (DI, guards, interceptors, filters). Pinned exactly; 11.2.8 released 2026-10-23 (16 days at install). Legacy decorators only, every injection via `@Inject(token)`, so no `emitDecoratorMetadata` and no SWC | 11.2.8 / 2017-05 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @nestjs/platform-fastify | Fastify adapter (`inject()` for tests, server `bodyLimit`/`requestTimeout`). Pins its own `fastify` 5.11.3 and `light-my-request` 6.6.0 | 11.2.8 / 2018-12 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || fastify | Direct dependency only for types and hooks; pinned to the adapter's exact version 5.11.3 so one copy is installed | 5.11.3 / 2016-10 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || reflect-metadata, rxjs | Required peers of NestJS | 0.2.2 / 2015-04 · 7.8.2 / 2012-03 | Apache-2.0 · Apache-2.0 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || ioredis | Redis client for the GCRA rate limiter (one `EVAL` per bucket, 50 ms timeout, circuit breaker). **6.0.0 is a new major (2026-10-12, 27 days)**; only `eval` is used. Not exercised against a live Redis yet | 6.0.0 / 2015-03 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || pg | node-postgres pool for the production `outlet_app` pool (`application_name` from `@outlet/observability`). Not exercised against a live database yet (tests use PGlite) | 8.23.1 / 2010-10 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @types/pg (dev) | Types for pg | 8.23.1 / 2016-05 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |Already in the table: zod, jose (also used directly by the test harness to mint ES256 tokens and by `SessionTokenVerifier.decodeJwt` for the market-mismatch code), yaml (OpenAPI generation), @electric-sql/pglite (dev). First-published dates were not re-verified online. Rejected: `nestjs-zod` and `@nestjs/swagger` (Zod 4 `toJSONSchema` + our route registry do both jobs; ADR draft `apps/api/docs/http-layer.md` H2/H3), `@fastify/helmet` (eight static headers set in one hook), `supertest` (Fastify `inject`).
w2qp-rph6-63g4, 389g-gv7q-r4x8 || fastify (override to 5.12.6) | fixes GHSA-3m5p-2c4r-xxw2, 4mh8-r7rc-xpvc, 667r-xxjv-c9mm, 9q9j-q6p8-xq58, hwr6-493r-vm6h, p68q-wchp-6fh7, w2qp-rph6-63g4 | 2016-10 | MIT |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |## P1-05b (cart, 2026-11-08)
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 || Package | Purpose | First published | Licence |
w2qp-rph6-63g4, 389g-gv7q-r4x8 ||---|---|---|---|
w2qp-rph6-63g4, 389g-gv7q-r4x8 || @outlet/cart (workspace) | Server-side bag: groups by store, free-delivery progress, limits | n/a (workspace) | private |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |
w2qp-rph6-63g4, 389g-gv7q-r4x8 |No third-party dependencies are added. packages/cart depends on workspace packages @outlet/db, @outlet/idempotency, @outlet/ids, @outlet/money, @outlet/outbox, @outlet/policy and zod (already present). Tests use fast-check and PGlite (already present).

## apps/api shopper discovery routes (2026-11-08)
No new third-party packages. `apps/api` now depends on the workspace package `@outlet/pricing-integrity` (pure window, VRP and display functions for the verified-discount deals read).

## apps/seller and seller catalog routes (2026-11-08)

| Package | Purpose | First published | Licence |
|---|---|---|---|
| @fastify/multipart 10.1.6 (apps/api, pinned exact) | Multipart photo upload on `POST /v1/{market}/seller/products/{product_id}/media`: one file per request, 10 MB cap, `kind` field before the file. Chosen over base64-in-JSON (33 percent larger, buffers twice, blows the 1 MiB JSON body limit) and over a raw-body parser (no field/size/parts limits). Official Fastify plugin; 10.1.6 is older than the 7-day release age | 2018-10 | MIT |
| axe-core 4.14.0 (apps/seller, dev) | Accessibility assertions in the wizard component tests (already in the lockfile via the web toolchain) | 2015-06 | MPL-2.0 |

`apps/seller` otherwise reuses the dependencies of `apps/web` (next 16.4.3, react, zod, @playwright/test, @testing-library, jsdom) and the workspace packages `@outlet/ids` (UUIDv7 Idempotency-Key in the browser), `@outlet/i18n`, `@outlet/money`, `@outlet/ui-tokens`, `@outlet/ui-web`. `apps/api` now also depends on the workspace package `@outlet/media`.

## Web shopper surface (login, bag, checkout)

| Package | Purpose | First published | Licence |
|---|---|---|---|
| @simplewebauthn/browser 14.0.0 (apps/web, exact pin) | Browser half of passkey sign-in (`startAuthentication`) for `/login`; the server half stays in apps/api. Lazy-loaded only when the shopper taps the passkey button | 2021-04 | MIT |
| axe-core 4.14.0 (apps/web, dev, exact pin) | Accessibility assertions (AR and EN) in the shopper component tests; already in the lockfile via packages/ui-web | 2015-06 | MPL-2.0 |

## Auth, cart and checkout routes (apps/api, 2026-11-08)

| Package | Purpose | First published | Licence |
|---|---|---|---|
| @simplewebauthn/server 14.0.3 | WebAuthn registration and assertion ceremonies behind the `PasskeyVerifier` port (apps/api only); pinned, 14.0.3 is older than the 7-day release age | 2020-06 | MIT |

Workspace-only additions to apps/api: `@outlet/cart`, `@outlet/checkout`, `@outlet/inventory`, `@outlet/money`, `@outlet/tax`, `@outlet/seller-accounts`.


## Mutation testing (root, dev, 2026-11-08)
| Package | Purpose | First published | Licence |
|---|---|---|---|
| @stryker-mutator/core 9.6.1 (root, dev, exact pin) | StrykerJS mutation testing, score >= 80 on money modules (A2.10); `pnpm mutation`, config `stryker.config.mjs` | 2016-02 | Apache-2.0 |
| @stryker-mutator/vitest-runner 9.6.1 (root, dev, exact pin) | Vitest runner plugin for StrykerJS (peer of core 9.6.1) | 2019-12 | Apache-2.0 |

9.6.1 (2026-04-10) is pinned instead of 10.x (10.0.0 is from 2026-08-14, under the 90-day rule). Both are dev-only and add no runtime dependency.
| qs (override to 6.16.1) | fixes GHSA-4mjr-xmp4-gh2g, 6pq8-jhm2-2vcw, q8mj-m7cp-5q26, x5fp-wj9c-mxmx (transitive) | 2014-01 | BSD-3-Clause |
