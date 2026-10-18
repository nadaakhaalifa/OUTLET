# Z-OUTLET (spec name: HAUL)

Egypt-first, multi-vendor outlet marketplace. iOS first (React Native/Expo), then Android, plus a Seller Center and an Admin Console on the web.

The single source of truth is the master prompt. Read it before every task and follow it exactly. Where it says HAUL, use Z-OUTLET.

@docs/haul-master-prompt-v3.md

## How to work
- Start every new session by stating which phase and feature we are on, and what the next step is.
- Spec first: flow, business rules, edge cases, data model, API contract and threat notes before any code.
- If something is unclear, check the spec. If still unclear, pick the safest professional default and record it as an ADR. Stop and ask only for irreversible decisions (money, legal, pricing, data hosting, provider contracts) and anything tagged VERIFY BEFORE LAUNCH.
- Compare at least 2 options before choosing an algorithm and explain the choice in 2-3 lines.
- Work in small, reviewable steps. After each step: what changed, how it was tested, what is next.
- Look up current docs (Expo, payment providers, Apple rules, OWASP) instead of relying on memory.
- UI work follows `docs/design-system/ux-principles.md`; the design lint and `tooling/design/check-debt.mjs` keep the design-debt baseline from growing.

## Non-negotiables
- TypeScript strict, no `any`, no ts-ignore, Zod at every boundary. Python ML: type hints, mypy strict, ruff.
- Hexagonal architecture with a pure domain layer. Money is integer piastres. Double-entry ledger for every money movement.
- Idempotency keys and explicit state machines. Domain coverage >= 90%, authorization tests on every endpoint.
- Never show fake stock, timers, reviews or discounts. Arabic-first with RTL. Comply with PDPL and Consumer Protection Law 181/2018.

## Current phase
Phases 0 to 2 are built and engineering-gate-green on synthetic data and fakes; Phase 3 is built behind kill switches (default blocked) with fakes, except the items the status doc lists as not built or not composed (creators and visual search are not composed in production; live shopping, photo measurement and trade-in are spec or partial only). Nothing runs against real money, real personal data or real providers: production adapters stay Unconfigured and fail closed (ADR-0029). Legal, residency and funds-flow decisions stay Proposed ADRs (0002, 0003, 0019) and gate real data and launch.

Honest per-feature status: `docs/plan/status-2026-10.md` (supersedes `docs/plan/resume-handoff.md`). Owner decisions: `docs/adr/README.md`, section "Owner decisions required". Open legal and provider assumptions: `docs/compliance/verify-register.md`.

Next: owner and counsel decisions (residency, wallet licensing, PSP split, age, Apple billing), provider contracts (Paymob, Bosta, BNPL, comms, LLM), then the launch checklist (`docs/plan/release-checklist.md`) and the Phase 0 exit items still open in `docs/plan/phase-0-exit-checklist.md`.
