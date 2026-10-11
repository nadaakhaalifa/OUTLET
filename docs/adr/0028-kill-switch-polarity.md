# ADR-0028: Kill-switch polarity and operator wording

- Status: **Proposed** (safe default applied; owner may prefer a rename)
- Date: 2026-10-11
- Deciders: CTO, SRE, Product
- Spec refs: A2.12, T8, T9, s4 (search fallback kill switch)

## Context and problem statement

`packages/feature-flags` names its switches `kill.<area>.<name>` but they are boolean "capability allowed" flags: `true` allows the capability, `false` blocks it, default `false`, and every error path fails closed (see the header of `registry.ts`). The code is safe. The name is not: "kill switch ON" reads as "capability killed", and an operator under incident pressure can flip it the wrong way. The load/chaos review also found that search-down and courier-down fallbacks have no switch at all.

## Considered options

1. **Keep the keys, fix the wording everywhere operators look.** Admin console and runbooks say "Allowed / Blocked", never "on / off". Zero migration risk.
2. **Rename to `capability.<area>.<name>` with the same polarity.** Honest name, one mechanical rename across modules, tests and stored flag values.
3. **Invert polarity (true = killed).** Natural reading, but default-off then means everything allowed, which breaks the fail-closed default. Rejected.

## Decision

Option 1 now, option 2 as a tracked follow-up before launch. Concretely:

- Admin console and runbooks render a kill switch as **Allowed** or **Blocked** with the capability name, and the change dialog states the resulting state in words.
- `FlagClient` gains no new semantics; add a `describeState(key)` helper returning `allowed | blocked` for UI use.
- Add registry entries for the missing fallback switches (`kill.search_engine` meaning the primary engine is allowed, `kill.courier.<name>`), with Postgres FTS and queued-AWB behaviour as the blocked state.

## Consequences

- No behaviour change in services; the risk is reduced to wording, which tests can lint (UI and runbook strings must not use "kill switch on/off").
- If the owner prefers option 2, it is a mechanical rename gated by the existing registry tests.
