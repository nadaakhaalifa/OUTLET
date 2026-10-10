# ADR-0001: Architecture: hexagonal modular monolith on a pnpm/Turborepo monorepo

- Status: **Proposed** (draft, awaiting approval)
- Date: 2026-10-10
- Deciders: Founder, CTO
- Spec refs: §A2, §T1, §T3, §T11

## Context and problem statement

Outlet NK handles money, stock and personal data across about 30 backend modules (auth, catalog, inventory, checkout, ledger, payouts, tax-eta, returns and so on), three web/mobile clients and a few ML services. The priority order in the spec is correctness, then security and privacy, then compliance, reliability, performance and delight. The team is small. We need a structure that keeps money and stock transactional and keeps module boundaries honest, without the operational cost of distributed services.

## Decision drivers

- Checkout, reservation and ledger writes must be ACID in one database (see ADR-0005).
- A small team cannot afford to run dozens of services.
- Module boundaries must be enforceable in CI, so a later split is cheap.
- One language and one set of shared types across mobile, web and API.
- Python is acceptable only where the ML ecosystem requires it.

## Considered options

1. **Modular monolith (NestJS), hexagonal layering, extracted services only when justified by an ADR.**
2. Microservices from day one.
3. Serverless functions per endpoint.

## Decision

Option 1.

- **Monorepo:** pnpm workspaces + Turborepo with remote cache. Layout as in the README: `apps/`, `packages/`, `infra/`, `docs/`.
- **Backend:** NestJS on Node LTS, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Each module has `domain/` (pure) → `application/` (use cases) → `adapters/`.
- **Boundaries enforced by fitness functions:** dependency-cruiser in CI forbids cross-module imports except through a module's public `index.ts`, and forbids infra imports inside `domain/`.
- **Data:** PostgreSQL 16+ is the single source of truth for money, stock and orders. Redis is cache, rate limits, queues and waiting room only. It never holds authoritative state.
- **Consistency:** transactional outbox plus idempotent inbox, orchestrated sagas for checkout/refund/payout (spec §A2.7–8). Delivery is at-least-once, and consumers are idempotent.
- **API:** REST with OpenAPI generated from code and a generated typed client. Zod at every boundary.
- **Query layer:** Kysely (typed SQL) rather than Prisma, because the ledger, `SKIP LOCKED` reservation and deferred-constraint triggers need hand-written SQL, and one tool is simpler than two.
- **ML:** Python services (FastAPI, `mypy --strict`, `ruff`, pydantic v2) in `apps/ml-services`, reached only through gateway modules (`stylist-gateway`, `recommendations-gateway`) behind ports.
- **Splitting rule:** a module becomes its own service only when an ADR shows a measured load or team-ownership need.
- **Mobile pin:** latest stable Expo SDK at project start with the New Architecture. Hermes v1 stays off until stable (register row 14).

## Consequences

**Good**
- One deployable and one transaction boundary for the money path.
- Cheap local development and testing.
- Boundaries are checked mechanically, so extraction later is a refactor, not a rewrite.

**Bad / risks**
- A single deployable means one bad release affects everything. Mitigation: canary 5% → 25% → 100% with SLO gates, and feature flags with kill switches.
- Workers (webhooks, sweepers, crawlers) must scale independently of the API process. Mitigation: the same codebase runs in separate process types (`apps/api`, `apps/workers`).
- Discipline erodes without the CI fitness functions, so they are required from the first commit.

## Revisit when

A module's p95 latency or deploy cadence is being held back by the rest of the monolith, or when a separate team owns it.
