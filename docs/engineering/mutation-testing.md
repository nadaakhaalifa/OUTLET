# Mutation testing

Target (A2.10): mutation score >= 80% on ledger, pricing/VRP, promotions, reservation, refunds and
subscription billing. Tool: StrykerJS 10 with the Vitest runner. Scope today: `packages/domain`.

## Measured baseline (2026-10-10, Node 24.15, Stryker 10, domain tests: 195 passing)

| Run | Mutants | Score (total) | Notes |
|---|---:|---:|---|
| `ignoreStatic: true` | 798 scored of 1688 (890 ignored) | **67.67%** | killed 533, timeout 7, survived 206, no coverage 52 |
| `ignoreStatic: false` (committed config) | 1688 | **45.08%** | killed 754, timeout 7, survived 875, no coverage 52 |

The committed configuration uses `ignoreStatic: false` because static mutants live in module-level
tables: state-machine transition tables and the chart of accounts. Ignoring them hides exactly the
mutations that matter most (a changed transition or account code). So the honest number is 45.08%.

### Where it is weak (`ignoreStatic: false`)

| File | Score |
|---|---:|
| `src/errors.ts` (state-machine) | 0% (9 survivors: error classes' fields and messages never asserted) |
| `src/state-machine/machines/*.ts` | 16% to 30% per machine (542 survivors in total) |
| `src/chart-of-accounts/builders.ts` | 49.65% (127 survivors, 18 uncovered) |
| `src/chart-of-accounts/accounts.ts` | 60.87% |
| `src/chart-of-accounts/spend.ts` | 43.08% (27 survivors, 10 uncovered) |
| `src/state-machine/machine.ts` | 72.73% |
| `src/money.ts` | 73.97% (25 survivors, 13 uncovered) |
| `src/ledger.ts` | 78.95% (11 survivors) |
| `src/errors.ts` (domain) | 100% |

Reading the survivors:

* **Machines**: the tests exercise the engine in `machine.ts`, not each machine's table. A mutant
  that deletes or changes a transition in `refund.ts`, `payout.ts` etc. survives because no test
  asserts that specific table. Fix with table-driven tests per machine (every allowed and every
  forbidden transition).
* **Money**: survivors include `abs`, the half-up/half-even rounding branch conditions, and
  `allocate` input validation (negative weights, empty weights, error messages). These are real
  gaps, not equivalent mutants: for example, flipping `n < 0n ? -n : n` to `n <= 0n` is equivalent,
  but `if (false) throw ...` on the `weights must not be negative` guard is not.
* **StringLiteral** survivors (76 survived, 20 uncovered in the first run) are mostly error
  messages. Some are noise (tests rightly do not pin wording); asserting error `code` fields would
  kill most of them without freezing prose.
* Excluding all StringLiteral mutants would raise the first run to about 76%. That is not done
  in the config because it would be a score-shaping choice; revisit it with the domain owner.

## Gate

`thresholds.break` is **40**, a ratchet below the measured baseline so CI catches regressions
without being permanently red. It is not the A2.10 floor. Raise it as tests improve, and set it
to 80 for the money modules (`money.ts`, `ledger.ts`, `chart-of-accounts`) first. Writing those
tests belongs to the domain owners; this task only measures.

## Running it

```sh
pnpm mutation                                 # whole domain, ~4 min
pnpm mutation -- --mutate "src/money.ts"      # one file (paths relative to packages/domain)
```

Reports: `packages/domain/reports/mutation/index.html` and `mutation.json`. Both and
`.stryker-tmp/` should be git-ignored (root `.gitignore` is not owned by this task, see decisions).

### macOS caveat (Homebrew proctools)

If Stryker dies right after the initial test run with `Error: spawn pgrep EAGAIN`, the Homebrew
`pgrep` is shadowing `/usr/bin/pgrep`. Its `-P <pid>` flag returns **every process** when the
parent no longer exists, and Stryker's process-tree kill recurses on that output until the
process table is exhausted. Run with the system tool first on PATH:

```sh
PATH=/usr/bin:$PATH pnpm mutation
```

This does not affect Linux CI runners.
