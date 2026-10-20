# Z-OUTLET (spec name: HAUL)

Egypt-first, multi-vendor outlet marketplace: local and global brands sell clearance stock at real, machine-verified discounts. One bag, one payment, Arabic-first with RTL.

- **Platforms:** iOS (Expo / React Native) first, then Android; Seller Center, Admin Console and a read-only shopper web on Next.js.
- **Source of truth:** `docs/haul-master-prompt-v3.md`. Where it says HAUL, read Z-OUTLET.
- **Status:** Phases 0 to 2 are built and gate-green on synthetic data and fakes; Phase 3 is built dark behind kill switches. Nothing runs against real money, personal data or providers; legal and provider decisions are pending. See `docs/plan/status-2026-10.md`.

## Repository layout
```
apps/       api (NestJS modular monolith + worker), mobile (Expo), seller-web, admin-web, shopper-web (Next.js)
packages/   domain, validation, api-client, policy, db, outbox, idempotency, feature-flags, auth-core,
            privacy, analytics, i18n, ui-tokens, ui-native
infra/      terraform, observability
tooling/    api, db, privacy, copy-lint, coverage, dora, e2e, load, mutation, pact, observability, legal
docs/       adr, specs, plan, data-model, security, privacy, compliance, runbooks, engineering, design-system
```

## Run, test, gate
Requires Node 24 (`.nvmrc`; `engines` is `>=24.3.0`) and pnpm 11 (`packageManager` in `package.json`). Dependency boundaries (`pnpm depcruise`) are checked on Node 24.

| Task | Command |
|---|---|
| Typecheck, lint, tests | `pnpm typecheck`, `pnpm lint`, `pnpm test` |
| Architecture boundaries | `pnpm depcruise` |
| i18n parity (AR/EN) | `pnpm i18n-check` |
| Mutation testing (domain) | `pnpm mutation` |
| Privacy inventory | `node tooling/privacy/check-inventory.mjs` |
| OpenAPI validation | `node tooling/api/validate-openapi.mjs` |
| Copy lint (no fake social proof) | `node tooling/copy-lint/cli.mjs` |
| Postgres 16 checks | `tooling/db/run-on-postgres16.sh` (needs a local Postgres 16; see `docs/plan/postgres16-run.md`) |
| Web E2E | `tooling/e2e/run.sh seller\|admin\|shopper` |
| Mobile | `pnpm --filter @outlet/mobile start` (Expo) |
| Web apps | `pnpm --filter <package> dev` in `apps/seller-web` (3001), `apps/admin-web` (3002), `apps/shopper-web` (3003) |

CI definitions: `.github/workflows` (described in `docs/engineering/ci.md`). Workflows have not yet run on GitHub.

## Documentation
Start at `docs/README.md`. Key entry points: `docs/plan/status-2026-10.md` (honest status), `docs/adr/README.md` (decisions and owner questions), `docs/compliance/verify-register.md` (legal and provider assumptions), `CLAUDE.md` (working rules). Font and third-party licences: `THIRD_PARTY_NOTICES.md`.
