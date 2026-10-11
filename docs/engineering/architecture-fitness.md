# Architecture fitness functions

Config: `/.dependency-cruiser.cjs`. Run: `pnpm depcruise` (Node 22, 24 or >= 26).

Result on 2026-10-10 against the working tree: **no dependency violations found (160 modules, 381
dependencies cruised)**.

## Rules (all `error` unless noted)

| Rule | Spec | Meaning |
|---|---|---|
| no-deep-import-into-shared-package | A2.3 | import another package only through `packages/<x>/src/index.ts` |
| no-deep-import-into-api-module, no-api-module-deep-import-from-outside | A2.3 | API modules expose only `modules/<m>/index.ts` |
| domain-must-not-import-application-or-adapters, application-must-not-import-adapters | A2.3 | dependencies point inward |
| domain-no-infra-packages, domain-no-io-core-modules | A2.3 | pure domain: no DB, HTTP, SDKs, fs, net, crypto |
| domain-no-workspace-imports | A2.3 | `packages/domain` is the base of the graph |
| packages-must-not-import-apps, apps-must-not-import-each-other | A2.2 | apps talk through the API contract |
| mobile-must-not-import-server-packages | A2.3 | no db, outbox or idempotency in the mobile bundle |
| production-code-must-not-import-tests | hygiene | |
| no-circular, not-to-unresolvable, not-to-dev-dep, no-non-package-json | hygiene | |
| no-orphans (warn), not-to-deprecated-core (warn) | hygiene | |

## What the rules cannot see

* `apps/api` has no `modules/` yet, so the hexagonal layer rules are untested against real code.
  They match paths that do not exist today and will start applying as modules appear.
* Rules operate on imports only. Purity of side effects (clock, randomness) is enforced separately
  by ESLint `no-restricted-properties` for `packages/domain/src` and `modules/*/domain`.
* `crypto` is banned from domain code as an I/O-capable core module. If hashing is needed in the
  domain, inject it through a port.

## Not implemented yet

Bundle-size budget for the mobile app and an API latency budget in CI perf tests (T11) need a built
app and a running API respectively.
