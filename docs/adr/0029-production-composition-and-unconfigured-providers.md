# ADR-0029: Production composition root and Unconfigured providers

- Status: **Accepted** (engineering default; reversible)
- Date: 2026-10-11
- Deciders: CTO, SRE
- Spec refs: A2.3, A2.7, A2.12, T8, B2, B3 (nothing may pretend to work), docs/plan/production-boot-gap.md

## Context

With `NODE_ENV=production DEV_FIXTURES=false` the API threw `NoProductionAdaptersError` from 44 modules and nothing started. Kysely stores exist per module and are contract-tested, but no root assembled them, and no PSP, BNPL, courier, ETA, messaging, LLM, KMS, object store, attestation or flag provider has a contract yet.

## Options

1. **Boot-time refusal.** Refuse to start until every provider is configured. Safe, but the API, the worker and the readiness endpoint cannot run at all until every contract exists, so nothing real can be exercised.
2. **Call-time fail-closed with blocked capabilities.** Boot with real Postgres stores; bind every missing provider to an explicit `Unconfigured<Provider>` adapter that throws `ProviderNotConfiguredError` when called (503, Problem+JSON code `provider_not_configured`); keep every dependent capability Blocked through the flag registry default (`false`).
3. A "dev fake" in production. Rejected: it would look like success.

## Decision

Option 2. Boot-time refusal stays only for malformed or missing core config (Zod, `loadConfig`). The process starts, `/v1/ready` states exactly what is unconfigured, and an operator must both configure a provider and enable its switch before the capability can run. Two independent locks, not one.

## Design

- `apps/api/src/production/`: `unconfigured.ts` (provider catalog, `ProviderNotConfiguredError extends ProblemError`, proxy adapter), `flags.ts` (`UnconfiguredFlagProvider` returns `PROVIDER_NOT_READY` so `FlagClient` yields the registry default `false`), `ports.ts` (per-module option objects), `compose.ts` (the root), `bindings.ts` (one row per `src/modules/*` directory), `platform-adapters.ts`, `relay.ts`.
- `AppModule.register` delegates to `composeProduction` when `config.adapters === "production"`; the dev and test paths are unchanged.
- Platform adapters in production: idempotency store over `idempotency_keys` (no schema change; actor and key hashed to uuid, claim token in the jsonb meta), authorization audit into the hash-chained `audit_log` (chain `authz:YYYY-MM`), seller export audit (`seller-analytics:YYYY-MM`), rate limiter per process (shared limiter needs Redis, which is Unconfigured; documented degradation).
- Webhook source IPs: deny all until a PSP supplies a list (a real fail-closed policy, not a stand-in).
- `CHECKOUT_LOCK_SECRET` (optional, min 32) signs price locks; unset, a domain-separated HMAC of `OTP_PEPPER` is used so a second secret is not mandatory.
- Worker: one `outbox.relay` job drains `outbox_events` with the Postgres transaction store. `payment.*` goes to the checkout saga bridge through the inbox (dedupe by message id in the same transaction). Event types with no in-process consumer are acknowledged and counted, not left pending, so the lag signal stays meaningful; rows stay in `outbox_events` and can be replayed by clearing `published_at`. `payments.events-relay` is subsumed. Jobs owned by non-composed modules are skipped with a log line; `drops` capability is blocked by default in production.
- `/v1/ready`: HTTP 200 only when the database answers. Reports `providers` (configured|unconfigured, names only), `modules` (composed count, blocked ids) and `dependencies.outbox` (ok|lagging|unknown, pending, oldest age, dead letters). Outbox lag is reported but does not make the API unready (a stopped worker must not take API pods out of rotation); it is the alert signal.
- Modules that cannot be composed without changing the module are listed in `bindings.ts` with the reason and left out; a registry test fails when a module directory has no row. Authenticated routes answer 401 while `auth` is blocked.

## Consequences

- The API and worker boot on real Postgres today. Every external call fails with 503 `provider_not_configured`, never a success.
- Startup logs list unconfigured providers and non-composed modules by name only.
- `ProcessMetrics` and the module-default optional ports (listed in the gap report) remain; they do not pretend a provider call succeeded.
- Open: composing the seven blocked modules needs module-level changes by their owners (see the gap report).
