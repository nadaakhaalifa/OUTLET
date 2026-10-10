# Mutation testing

> **Update 2026-10-10:** the 45.08% baseline below is historical. After targeted tests, per-file Stryker runs on Node 24 give 97.69% for the whole domain (re-measured by the independent re-audit) and 96-99% for idempotency, outbox, policy and feature-flags (agent-reported, not re-run). Policy: ADR-0019 (per-module floors, ratchet, 80% hard gate on critical modules). Per-package `break` values are ratchets at the measured baseline and should be raised to 80 for the critical modules. Stryker does not exit cleanly on Node 25; run on Node 24.

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

## Per-file results after targeted killing tests (2026-10-10, ignoreStatic=false, Node 24)

Run per file group with `cd packages/domain && stryker run ../../stryker.config.mjs --mutate <files>`
(the `pnpm mutation -- --mutate` form is rejected by the CLI wrapper; pass `--mutate` after the
config path, with paths relative to `packages/domain`). Scores are `total` (killed + timeout over all
mutants).

| File group | Before | After |
|---|---|---|
| `money.ts` | 73.97% | 94.52% |
| `ledger.ts` | 78.95% | 100% |
| `state-machine/machine.ts` | 72.73% (89.09% once import-time crashes are counted as kills) | 100% |
| `state-machine/errors.ts` | 0% | 100% |
| `state-machine/machines/*.ts` (13 files) | 23.01% | 100% |
| `chart-of-accounts/accounts.ts` | 60.87% | 97.63% |
| `chart-of-accounts/builders.ts` | 49.65% | 93.75% |
| `chart-of-accounts/spend.ts` | 43.08% | 90.77% |
| All of the above together | n/a | 97.75% (1642 killed, 7 timeout, 36 survived, 2 no coverage) |

New test files: `src/money.mutation.test.ts`, `src/ledger.mutation.test.ts`,
`src/state-machine/machines.table.test.ts`, `src/chart-of-accounts/mutation.test.ts`.

### Why the machine tables scored 23%

Transition tables are module-level object literals. A mutant that breaks one (for example
`initial: ""`) makes `defineMachine` throw while the module is imported. When the importing test
file loads that module statically, vitest reports a collection error with zero tests, and Stryker's
vitest runner records the mutant as **Survived**. The fix is in the tests, not the source:
`machines.table.test.ts` imports the registry dynamically inside `beforeAll`/`it`, so the same crash
becomes a failing test and the mutant is Killed. Keep it that way: do not add a top-level static
import of `registry` or any `machines/*.ts` module to that file, and do not build machines at
module level in it.

### Equivalent or engine-dependent survivors (not killable, listed honestly)

`money.ts` (8):
- `abs`: `n < 0n` to `n <= 0n` (-0n is 0n).
- `divideRoundHalfEven`: `remainder === 0n` to `false` (a zero remainder never rounds away anyway);
  `numerator < 0n` to `<= 0n` and `denominator < 0n` to `<= 0n` in `sign` (zero numerator returns
  earlier, zero denominator throws earlier).
- `allocate`: `total.amount < 0n` to `<= 0n` (negating zero); `ra > rb` to `>=` (guarded by
  `ra !== rb`); `index === undefined` break (leftover is always smaller than the number of positive
  weights, so the index exists).
- Sort comparator tie-break mutants `if (ra !== rb)` to `true` and `a - b` to `a + b` survive under
  V8's TimSort because it only ever calls the comparator with the later element first; they are
  engine-dependent, not covered by the language contract.

`accounts.ts` (4 survived, 2 no coverage), `describeAccount`: the `?? ""` and `?? "Stryker was here!"`
fallbacks are unreachable because `split` always yields index 0; `typeName === "store_credit" &&
rest.length >= 2` mutants (`||`, `true`, `> 2`) produce the same parameters or the same error
because no other type has two parameters.

`builders.ts` (18): 14 are `side: "credit"` to `side: ""` (the posting code treats any non-`"debit"`
side as credit, so the string is unobservable); `base * direction` to `base / direction`
(direction is always 1n or -1n); `shipping.amount > 0n` to `true` or `>= 0n` (zero components are
skipped by `toPostings`). Making `Side` a closed union and testing `toPostings` with an invalid
side would remove the first group; that is a source change outside this task.

`spend.ts` (6): `.slice()` removal (`filter` already returns a copy); `compare(...) <= 0` to `< 0`
(equal balance and remaining produce the same take); four comparator tie mutants on equal keys,
engine-dependent as above.

### Known limits of this measurement

- Everything pinned in `machines.table.test.ts` and `ACCOUNT_TYPES` is a characterization of the
  current tables, reviewed against the spec only at the level of "is a plausible transition". They
  detect change, they do not prove the tables match spec A2.6 and T4. Domain review of the tables
  is still owed.
- `ACCOUNT_TYPES` prose (`purpose`, `lifecycle`, `verify`) is pinned verbatim so doc edits require a
  test edit. That is deliberate but noisy.
- Not run: the other `packages/domain/src` files (this task covered money, ledger, state machines
  and the chart of accounts only). `stryker.config.mjs` still has `break: 40`; it can be raised to
  80 for these files once the remaining domain files are covered. That file was not edited here.
- vitest's `related` mode does not need to change, but Stryker leaves `.stryker-tmp*` directories
  behind if a run is killed; delete them, because vitest then collects the stale copies.

## Wave 2: inventory and cart scopes (2026-10-10, Node 24.15, Stryker 10, ignoreStatic=false)

Two focused configs live next to the whole-domain one (`packages/domain/stryker.inventory.mjs`,
`packages/domain/stryker.cart.mjs`). Run from `packages/domain` with
`pnpm exec stryker run stryker.inventory.mjs` (or `stryker.cart.mjs`). The CI `mutation` job runs both
after the whole-domain run. `break` is a ratchet at the floor of the measured score (ADR-0019); the
80 target for reservation and pricing stays, and no threshold was lowered.

| Scope | Files | Score (total) | killed / timeout / survived / no cov | `break` |
|---|---|---:|---|---:|
| Inventory reservation, claim, pool, TTL | `src/inventory/{model,plan,pool,sync,ttl-policy,outcomes}.ts` | **71.91%** | 506 / 1 / 164 / 34 | 71 |
| Cart pricing and free-delivery | `src/cart/{pricing,bag-rules}.ts` | **92.31%** | 144 / 0 / 11 / 1 | 92 |

Per file (inventory): `model.ts` 68.35% (123 survived, 34 no coverage), `plan.ts` 92.31%, `pool.ts`
95.65%, `sync.ts` 86.79%, `ttl-policy.ts` 50.91% (27 survived). Cart: `bag-rules.ts` 97.83%,
`pricing.ts` 90.00%.

**Gap against ADR-0019:** inventory is a critical module (reservation) and is below the 80 hard
gate, so it runs at its measured floor with an open gap. Survivors seen in the output are mostly
`StringLiteral` mutants in `ttl-policy.ts` (policy ids and method names in the default table are not
asserted) and the `policy.version > best.version` tie rule; `model.ts` has 34 uncovered mutants. The
tests are owned by the inventory module, so killing tests were not written here. Raise `break` to the
new floor after each improvement and to 80 when reached.

Not measured: `src/catalog` and `src/sizing/*` other than `fit.ts` (sizing has its own config, not
re-run here). The `src/cart/stryker.config.mjs` and `src/sizing/stryker.config.mjs` files that
already exist were not changed.

## Inventory concurrency proof (not mutation, but the same gate family)

`tooling/db/inventory-concurrency.sh` runs the row-per-unit reserve/claim storm on a real, throw-away
PostgreSQL 16 cluster. CI job `inventory-concurrency` in `.github/workflows/ci.yml` runs it with
RUNS=25, ATTEMPTS=10000, CONNS=100 and is **blocking**. It starts its own cluster with `initdb`
rather than a `services:` container because it needs `pg_ctl` and the server log (to grep for
`deadlock detected`). Local run on 2026-10-10 with RUNS=5 on Postgres.app 16: 5/5 runs exact
(100 claimed, 0 lost, 0 deadlocks, 0 server ERROR lines, reserve p50 9.4 ms, p95 19.1 ms,
p99 35.8 ms). The CI job has never executed on GitHub. It is single-machine evidence, not a
production load test.
