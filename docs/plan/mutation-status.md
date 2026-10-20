# Mutation status for the money-critical modules (2026-10-12)

Policy: ADR-0019 (per-module floors with a ratchet, spec A2.10 target 80%). Tool: StrykerJS 10 with the
Vitest runner, Node 24, `ignoreStatic: false`, `coverageAnalysis: perTest`. All scores below come from one
`bash tooling/mutation/run-all.sh` run on 2026-10-12 (`reports/mutation-summary.md`). Every config passes
its `break`.

## Scores

| Area | Config | Score | `break` | Baseline before this work |
|---|---|---:|---:|---:|
| Refunds domain: router, allocation, legs, plan, SLO schedule | `packages/domain/stryker.refunds.mjs` | 94.35 | 91 | 71.25 |
| Refunds application: ledger-first process, intake, provider callbacks, entry codec | `apps/api/stryker.refunds.mjs` | 92.62 | 89 | 61.67 |
| Promotions: stacking, funding, apply, evaluate | `packages/domain/stryker.promotions.mjs` | 90.29 | 87 | 90.29 (config existed but was not wired) |
| Auto-buy: decideCharge, trigger, attempt, terms | `packages/domain/stryker.auto-buy.mjs` | 100.00 | 97 | 95.29 |
| Creators: commission, clawback, attribution, eligibility, fraud, machine, payout glue | `packages/domain/stryker.creators.mjs` | 95.42 | 92 | 75.83 |
| Family and student seat accounting | `packages/domain/stryker.family-student.mjs` | 97.63 | 94 | 73.68 |
| Payouts: eligibility and netting, statement, cycle, approval, lifecycle | `packages/domain/stryker.payouts.mjs` | 93.46 | 90 | 76.18 |
| Gift cards: codes, pots, rules, redemption throttle | `packages/domain/stryker.gift-cards.mjs` | 97.65 | 94 | 75.88 |
| Store credit: lots, expiry, sales gate, spend order (`chart-of-accounts/spend.ts`) | `packages/domain/stryker.store-credit.mjs` | 91.98 | 88 | 66.55 (spend.ts was 43.08 on its own) |
| Calendar gap-fill budget guard | `packages/domain/stryker.calendar-gap.mjs` | 89.12 | 86 | 68.03 |

Every area reached the 80% target. `break` is the measured score rounded down minus 3 points (2 to 3 points
below measured, as ADR-0019 asks); raise it when a later run measures higher, never lower it.

## New tests (tests only, no production code changed)

- `packages/domain/src/refunds/refunds.mutation.test.ts`
- `packages/domain/src/store-credit/store-credit.mutation.test.ts`
- `packages/domain/src/calendar/gap.mutation.test.ts`
- `packages/domain/src/creators/creators.mutation.test.ts`, `machine.mutation.test.ts`
- `packages/domain/src/subscriptions/family-student.mutation.test.ts`
- `packages/domain/src/payouts/payouts.mutation.test.ts`
- `packages/domain/src/gift-cards/gift-cards.mutation.test.ts`
- `packages/domain/src/auto-buy/attempt.mutation.test.ts`
- `apps/api/src/modules/refunds/test/application.mutation.test.ts`

Support files: `apps/api/vitest.mutation-refunds.config.ts` (limits the mutation run to the in-memory refund
suites, so no PGlite or HTTP boot per mutant) and `packages/domain/stryker.promotions.mjs` (the existing
promotions config moved from `src/promotions/`, where `run-all.sh` could not find it, and given a `break`).

## Equivalent or unreachable survivors (not killable, listed honestly)

- Refunds domain: `attributeLegsToLines` "lines exhausted" guard is unreachable because the totals are
  checked equal first; `x.left >= 0n` in `routeRefund` (a zero-weight tender gets a zero part and is skipped).
- Creators: `targetCommission` and `planRefund` clamps whose negative or over-base branch yields the same
  result after the later `max`/`commissionOn` guard; `clawbackDelta` `delta <= 0n` and `delta > held`
  (target is never negative, so delta never exceeds held); `payoutLineAmount` `<=` variants (equal sides).
- Payouts: `applied.filter(a => a.applied > 0n)` in `planPayout`. A payable plan only exists when every
  clawback was applied in full, so a zero-applied entry never reaches that filter; the three mutants on it
  are equivalent. Sort tie-break comparators (`<` vs `<=`) on equal keys are engine-dependent.
- Gift cards: `bits < 5` to `bits <= 5` in `encodeCrockford` (same bit stream, byte fetched earlier);
  `.trim()` in `normalizeCode` (the next step already strips whitespace); `canVoid` context booleans (VOID
  has no guard).
- Store credit and spend order: sort tie-breaks on equal keys; `first === undefined` guard in `planLotSpend`
  (a group is never empty); `have <= need` and `take >= 0n` variants that yield the same takes.
- Calendar gap-fill: the ML-to-rules fallback (`!outfits.some(complete)` then `rulesOutfits`) could not be
  reached. 4,000 random catalogs and budgets never produced a case where the beam search found no complete
  outfit while the rules engine did, and a timed-out search still completes greedily. About 8 mutants sit on
  that branch and stay alive. It is defensive code; if the optimizer changes, add a deterministic case.
- Eligible-but-unreachable `note: "preference_ignored_original_credit_only"` in `RefundRoute` is typed but
  never produced by `decideRoute` (a store-credit or gift-card tender always returns to its own sub-balance,
  whatever the preference). Not a bug, but the union member is dead; report to the refunds owner.

## Method note: import-time crashes count as survivors

State-machine tables are module-level literals and `defineMachine` validates them while the module loads. A
mutant that breaks a table makes the import throw; when a test file imports the module statically, vitest
reports a collection error and Stryker's vitest runner records the mutant as Survived (see
`docs/engineering/mutation-testing.md`). The new machine tests (`creators/machine.mutation.test.ts`,
`family-student.mutation.test.ts`, the pot table in `gift-cards.mutation.test.ts`) load the module with a
dynamic `import()` inside each test, which turns the crash into a failing test and a kill. The same
technique should be applied to any other module that defines a machine at top level.

## Findings that need a decision

- No production bug was found, so no production file was edited.
- Not changed because other agents own these files: `apps/api/src/modules/refunds/application/intake.ts`
  was being modified while this work ran (it is mutated read-only here; the new tests passed against the
  working tree at the time of the run). If the intake rules change, `application.mutation.test.ts` pins the
  rejection reasons and the stored refund shape and will need the matching update.
- Not covered by any mutation config yet: orders producers, checkout producers, the Kysely adapters
  (PGlite suites are too slow per mutant), `creators/config.ts` validation, `state-machine/machines/*` for
  refund, payout and gift card (covered by the table tests from the 2026-10-10 pass).
