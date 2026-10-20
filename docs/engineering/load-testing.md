# Load and chaos testing (spec A2.10, T8, T9)

Everything lives in `tooling/load/`. k6 was **not installed** in the authoring environment, so the k6 scripts have only been syntax-checked (`node --check`), never executed. The in-process simulator and the chaos harness were executed for real.

## Layout

| Path | Purpose |
|---|---|
| `k6/lib.js` | Env-driven base URL, token/manifest loading, idempotency keys, shared SLO thresholds, production-host guard |
| `k6/drop-50k.js` | Scenario 1: 50k VUs on a 500-unit drop |
| `k6/checkout-mix.js` | Scenario 2: checkout success at 20x baseline mix |
| `k6/reserve-p95.js` | Scenario 3: reserve p95 on hot SKUs |
| `k6/search-p95.js` | Scenario 4: search p95 |
| `k6/webhook-replay.js` | Scenario 5: webhook replay storm |
| `seed.mjs` | Dry-run by default; `--apply` sets stock via `PUT /v1/seller/skus/{skuId}/stock` with idempotency keys |
| `simulate.mjs` | Deterministic simulator on the real `StockModel` |
| `chaos/degraded-modes.mjs` | T9 harness stub over the feature-flag registry |

## Thresholds (T8)

| Scenario | Threshold | Source |
|---|---|---|
| Drop | checkout success >= 99% (admitted, excl. sold-out); zero 5xx | spec 16 |
| Checkout mix | success >= 99.5% (excl. user-declined); search p95 < 150 ms; read p95 < 300 ms | T8 |
| Reserve | server-side `Server-Timing: reserve;dur` p95 < 150 ms; header must be present | T8 |
| Search | p95 < 150 ms; no-result rate < 8% | T8, spec 4 |
| Webhook | zero tampered bodies accepted; zero 5xx; p95 < 500 ms | spec 7 |

Run (staging only; the guard refuses production-looking hosts):

```
node tooling/load/seed.mjs                       # dry run
FIXTURES_FILE=... SELLER_TOKEN=... BASE_URL=https://staging... node tooling/load/seed.mjs --apply
cd tooling/load && k6 run -e BASE_URL=https://staging... k6/drop-50k.js
```

## Post-run end-state checks (not expressible as k6 thresholds)

Run against the staging database after the drop and webhook scenarios:

- Drop: `claimed units <= 500` and `committed <= on_hand` for the drop SKU; no `inventory.oversold` outbox events; count of `order_groups` in paid/confirmed for the drop <= 500; FIFO deviation = share of winners whose queue rank is outside the first 500 payers by rank (target <= 1%).
- Webhook: `count(payment_events_raw) == unique event ids`; each order group paid exactly once; ledger entries per event == 1; trial balance == 0.

## Simulator

`node tooling/load/simulate.mjs [--scenario all|drop|checkout|reserve|webhook] [--seed N] [--users N] [--units N] [--json]`

It re-executes itself with `--experimental-transform-types` (Node 24+) because the domain uses TS parameter properties and extensionless imports. It drives `StockModel`, `planReservation` and `DEFAULT_TTL_POLICIES` with a seeded PRNG and simulated clock.

Honest limits:
- No waiting-room domain module exists yet (`packages/domain/src/drops` is absent). The FIFO queue, `admit_per_sec` and waitlist-on-release in the simulator are a model of `docs/specs/phase2/07-drops-waiting-room.md`, not production code.
- The model is single-threaded: it proves allocation logic, not Postgres `SKIP LOCKED` behaviour (`tooling/db/inventory-concurrency.sh` does that).
- Latency figures are in-memory model cost (the model scans O(units) per op), not DB latency. Search is not simulated.
- Volumes are reduced for the model (5k checkout attempts at the "20x" shape, 10k attempts per run for contention) because of the O(units) scan. PSP failures are injected at 0.2% with 3 idempotent retries, so ~100% success there is a property of the injected rates, not a measurement of a real PSP.

### Results (seeds 42 and 7, all PASS)

| Scenario | Result (seed 42) |
|---|---|
| Drop: 50,000 users, 500 units | claimed 500, committed 500, oversold records 0, invariant violations 0, winners outside ideal FIFO set 0.0%, 27 holds released and re-sold via waitlist, 49,500 sold-out refusals |
| Checkout 20x shape | 5,000 attempts, 4,841 ok, 159 user-declined excluded, 0 failed, 28 mid-saga crashes recovered by idempotent replay, 0 oversell |
| Reserve contention | 50 runs x 10,000 attempts on 100 units: claimed exactly 100 in every run, 0 bad runs |
| Webhook storm | 5,000 events x 5 replays shuffled plus 1,471 tampered: 5,000 applied, 1,471 tampered rejected, 0 tampered accepted, 5,000 ledger postings, final state identical to single delivery, direct re-claim idempotent |

The adjacent-inversion figure (about 43%) is client jitter (0-80 ms) reordering reserve arrivals inside a 100 ms admission tick; it does not change who wins because the waitlist is ordered by queue rank.

## Chaos matrix (T9)

Harness: `node tooling/load/chaos/degraded-modes.mjs`. It asserts the kill switch exists, fails closed when the provider throws, and that a flip is observable. Behavioural probes are PENDING.

| Test | Gate | Expected degraded mode | Probe (to implement) | Status |
|---|---|---|---|---|
| PSP down | `kill.payment.*` | Failover (only if second PSP contracted, VERIFY) or hide method; COD stays | Quote excludes killed method | switches PASS, probe PENDING |
| Search down | none in registry | Postgres FTS fallback, no 5xx | Search 200 with fallback marker | GAP: no switch, no marker spec |
| Redis down | `kill.drops` | Waiting room fails closed; non-drop checkout continues | Queue join 503 paused; checkout 2xx | switch PASS, probe PENDING |
| Courier down | none in registry | Orders accepted, AWB queued in outbox | Shipment create 202 label_pending | GAP: no switch |
| LLM down | `kill.stylist_llm`, `kill.ml_ranking` | Rule-based stylist, keyword search parse | Stylist 200 source=rules | switches PASS, probe PENDING |

Game-day steps per row (block dependency at the network layer in staging, run `checkout-mix.js` at 1x, watch the SLO dashboard, restore, confirm reconciliation): see `docs/runbooks/degraded-mode-matrix.md` and `docs/runbooks/psp-outage.md`.

## Gaps

1. k6 scripts unexecuted (k6 absent); thresholds and request shapes unvalidated against a live API.
2. `/v1/drops/*` is specified but not in `docs/api/openapi.yaml`; drop quotes, tokens, addresses and drop creation need staging fixtures (`FIXTURES_FILE`).
3. The `Server-Timing: reserve` header and the `X-Admission-Token` header are assumptions to be added to the API contract.
4. Webhook signature scheme (`X-Signature`, HMAC-SHA256 hex, provider `sandbox`) is VERIFY BEFORE LAUNCH per adapter.
5. Registry has no switch for search engine or courier, and the kill-switch value semantics (true = killed vs enabled) are ambiguous in `FlagClient.isPaymentMethodEnabled`.
