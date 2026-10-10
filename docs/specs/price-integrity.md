# Price Integrity v1 (master prompt section 9)

Status: implemented for the internal price ledger only. No crawler, no brand RRP, no document evidence
(Phase 2). External evidence enters through `ExternalEvidencePort`, which ships empty.

Code: `packages/domain/src/price-integrity/**` (pure), `apps/api/src/modules/price-integrity/**`,
migration `packages/db/migrations/0024_price_integrity.sql`.

## 1. Principle

Sellers never type a "was" price that is displayed. HAUL computes a Verified Reference Price (VRP) from
evidence. Without sufficient evidence the shopper sees a plain price and no human is asked (fail closed).
There is no "was price" column anywhere (catalog 0012 and 0024 both enforce this by shape).

## 2. Flow

1. A price change is appended to `price_events` (`recordPriceChange`): idempotent per `(sku, key)`, ordered
   per SKU, one store per SKU, never edited or deleted.
2. The change is scored: VRP computed, a `price_claims` snapshot stored, enforcement ladder evaluated.
3. Catalog reads `PriceBlockReader.blocks(skuIds)` at request time. Absent SKU means no evidence.
4. Order lines store `toSnapshot(result)`: price, VRP, pct, claim type, evidence ids.

## 3. Rules (computeVrp)

Notation: `now`, change points `e0..ek` (consecutive equal prices collapsed, future events ignored),
price `p = ek.price`, `W = 30 days`.

| Rule | Behaviour |
|---|---|
| Launch price | `now - e0.validFrom < 30d` gives badge `launch_price`, never a percentage |
| Run of reductions | the maximal suffix where every change is a decrease; `chainStart` = time of its first reduction |
| Reference window | prices in force during `[chainStart - 30d, chainStart)` |
| Internal low | minimum price over that window (anti-inflation: a raise inside the window is already part of it, so a raise then cut cannot lift the reference) |
| Coverage | `e0.validFrom <= chainStart - 30d`, else `insufficient_history` (no claim) |
| Expiry | claim lives while `now - chainStart <= 30d`, else `discount_expired` |
| External | used only if `matchConfBp >= 9200`, `historyDays >= 30`; `VRP = min(internal, external.low)` |
| Stale external | matched evidence older than 72h gives `stale_external_evidence`, no claim (fails closed, never ignored upward) |
| Percentage | `floor((VRP - p) * 100 / VRP)` on bigint piastres |
| claim_allowed | `VRP > p` and `pct >= 5` |
| Successive discounts | the run keeps its starting reference while the price never goes back up; any raise starts a new run |
| Lowest in 30 days | full 30 day coverage, current price is the window minimum, a higher price was in force, not beaten externally; badge only, no reference |

Decision on the algorithm (2 options considered): (a) reference = min over the trailing 30 days including
the current price, which can never exceed the price so no discount is ever possible; (b) reference = min
over the 30 days before the current run began, the EU prior-price model. (b) chosen. Equal prices are
collapsed so re-asserting a price cannot restart a run.

Cross-channel parity: a fresh matched external current price strictly below ours sets `crossChannelCheaper`.

## 4. Enforcement ladder (pure `decideEnforcement`)

| Event | Actions |
|---|---|
| insufficient_evidence | hide_discount |
| claim_exceeds_vrp | auto_correct_display |
| pre_drop_inflation (raise in the 30 days before a run) | remove_badge 30d + ranking penalty |
| cross_channel_cheaper | demote with 48h deadline; at or after 48h also auto_pause_sku |
| 3 violations in 90 days | additionally strip_verified_badge, commission surcharge, drops blocked 30d |
| severe_or_repeat | suspend_store, hold payouts, human review within 5 business days |

Price Trust Score: `100 - 10*min(violations90d,8) - 5*min(openCrossChannel,3) - floor(correctedPct/5)`,
clamped 0..100; bands excellent >= 90, good >= 70, at_risk >= 40, restricted.

## 5. Data (migration 0024, RLS)

| Table | Notes | PII |
|---|---|---|
| `price_events` | append-only (UPDATE/DELETE/TRUNCATE trigger), ordered per SKU, one store per SKU; select any authenticated role, insert own-store seller or system | actor_id P2 |
| `price_claims` | append-only; CHECK: percentage exists iff verified and VRP > price and evidence non-empty; select own store or ops, insert system | none |
| `price_enforcement_actions` | only `resolved_at` may change, once; unique open cross-channel finding per SKU; `dedupe_key` unique | none |

## 6. API

| Route | Auth | Idempotent | Rate limit |
|---|---|---|---|
| `GET /v1/products/{id}/price-evidence` | buyer_api, any signed-in shopper | n/a (read) | 120/min/user |
| `GET /v1/seller/price-trust` | seller_api, brand grant with `read`; `X-Store-Id` selects among staffed stores | n/a (read) | 60/min/user |

`price-evidence` returns per SKU: badge, price, reference_price and discount_pct only when verified,
claim_id, reason code when absent, lowest_30d, evidence ids, 30 day price history. It never returns actor
or store identifiers. Unknown and inactive products are indistinguishable 404s.

## 7. Events (not wired yet)

`price.changed`, `price_claim.scored`, `price_enforcement.applied`. v1 writes state only; the outbox
publisher lands with the catalog event relay (see needs).

## 8. Failure handling

External port failure or absence: internal evidence only. Stale external: claim degrades to a plain price.
No dependency on Redis or the crawler. Everything is recomputed from the ledger at read time, so a bad
deploy cannot leave a stale discount displayed.

## 9. Security and abuse

BOLA: seller route takes the store only from the actor's grants; naming another store is 403 and leaks
nothing; claims and enforcement reads are additionally RLS scoped. Writes of claims and enforcement run as
the system role, never as the seller. Mass assignment: no write route exists in v1. Seller-typed reference
prices are only ever reviewed (`reviewClaim`) and never displayed.

## 10. Metrics

Listings with verified claims (%), auto-corrections per store, pre-drop inflation findings, open
cross-channel findings, appeals upheld (target < 2%, Phase 2 appeals flow).

## 11. Acceptance (Gherkin, as tests)

- Given a price raised and cut within 30 days, then no claim exceeds the lowest price of the 30 days before the cut (property test, 500 runs).
- Given a history under 30 days, then badge is launch_price and no percentage (property test).
- Given any output with a percentage, then a verified claim with evidence and VRP > price exists (property test).
- Given a seller of store A calls price-trust with X-Store-Id of store B, then 403 and no data.
- Given external evidence older than 72h, then no percentage.

## 12. Verification

Domain: `cd packages/domain && npx vitest run --dir src/price-integrity`. API:
`cd apps/api && npx vitest run src/modules/price-integrity`. Mutation: `stryker.price-integrity.mjs`
(break 80). Privacy: `node tooling/privacy/check-inventory.mjs`.

## 13. Open items

- VERIFY: CPL 181/2018 Art. 9 text and whether 30 days is the right look-back and expiry for Egypt.
- Seller-facing explainer copy and Arabic strings for `reason` codes.
- Appeals flow, price-history chart endpoint, enforcement application (pausing SKUs, ranking penalty) are consumers of the actions this module emits; v1 records and returns them.
- Phase 2: crawler, matching waterfall, brand RRP, document evidence, anomaly model for the trust score.
