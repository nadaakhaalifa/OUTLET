# Outlet NK (spec name: HAUL)

Egypt-first, multi-vendor outlet marketplace. iOS first (React Native/Expo), then Android, plus a Seller Center and an Admin Console on the web.

The single source of truth is the master prompt. Read it before every task and follow it exactly. Where it says HAUL, use Outlet NK.

@docs/haul-master-prompt-v3.md

## How to work
- Start every new session by stating which phase and feature we are on, and what the next step is.
- Spec first: flow, business rules, edge cases, data model, API contract and threat notes before any code.
- If something is unclear, check the spec. If still unclear, pick the safest professional default and record it as an ADR. Stop and ask only for irreversible decisions (money, legal, pricing, data hosting, provider contracts) and anything tagged VERIFY BEFORE LAUNCH.
- Compare at least 2 options before choosing an algorithm and explain the choice in 2-3 lines.
- Work in small, reviewable steps. After each step: what changed, how it was tested, what is next.
- Look up current docs (Expo, payment providers, Apple rules, OWASP) instead of relying on memory.

## Non-negotiables
- TypeScript strict, no `any`, no ts-ignore, Zod at every boundary. Python ML: type hints, mypy strict, ruff.
- Hexagonal architecture with a pure domain layer. Money is integer piastres. Double-entry ledger for every money movement.
- Idempotency keys and explicit state machines. Domain coverage >= 90%, authorization tests on every endpoint.
- Never show fake stock, timers, reviews or discounts. Arabic-first with RTL. Comply with PDPL and Consumer Protection Law 181/2018.

## Current phase
Phase 0, Foundations. First task: the P5 list in the master prompt (open questions, ADRs 0001-0005, ERD, data inventory, verify register). Do not write application code until that is approved.
