# ADR-0060: Admin home summary, honest overview band, and role-scoped ID lookup

- Status: **Proposed** (nothing built; safe defaults below; owner decisions O-1..O-10 in the spec, section 12; VR-ADMIN-01..03 in the verify register). Revised 2026-10-20 for the chief-reviewer's GO WITH CHANGES (spec section 13).
- Date: 2026-10-20
- Deciders: Owner, Finance, Ops lead, Security, DPO
- Spec: [`docs/specs/admin-home-summary-and-overview.md`](../specs/admin-home-summary-and-overview.md)
- Master prompt refs: §23, §25, §26, A2.4, A2.10, A2.12, A2.13, §B1, §T3, §T5, §T8
- Related: ADR-0028 (kill-switch polarity), ADR-0029 (Unconfigured fails closed), ADR-0045 (dashboard read path), ADR-0047 (Cairo buckets), ADR-0048 (admin identity and the `me` capability map), ADR-0049 (dashboard role permissions), ADR-0002 (residency: no real data yet)

## Context
The console home (commit 9d81868) makes about 15 list reads, shows "50+" when a list is capped, has no oldest-item age, and decides tile visibility from the nav role table. That table disagrees with the API's capability predicates for reconciliation and brand review. The owner wants a single home read, an ops and finance overview (GMV, orders, AOV, funnel, top stores and products against the previous period), a command palette, and sparklines, with no fake numbers.

Reading the code also showed the following:
- `platform.orders.placed`, `platform.seller_orders.placed`, `platform.orders.purchased` and therefore `platform.aov` have **no producer** (`PLATFORM_FACT_METRICS` covers only units and GMV). Once the watermark moves, the series route would serve them as zeros. That is an A2.13 defect in an existing route, and this ADR fixes it first.
- The per-store `checkouts` rollup also has no producer. No consumer maps checkout events (`seller-analytics/application/consume.ts:23-24`), `seller_order.placed` is only a watermark routed type (`kysely-rollups.ts:81`), and the registry tags it client and consent-sampled (`series-registry.ts:40`).
- Seller orders are created only after payment or COD confirmation, in the same transaction as the purchase facts (`orders/application/intake.ts:23`, `orders/adapters/kysely-store.ts:288-324`). "Placed" and "paid" are the same moment.
- No `EventSourcePort` over `outbox_events` exists (`production/bindings.ts:63, 108`), so no rollup is fed in any environment.
- Attention's `capabilityPredicates` disagree with `me`'s `computeCapabilities` (`attention.ts:21` vs `me.ts:49-51, 74`).
- The moderation route gate checks neither passkey nor expiry (`reviews.controller.ts:408-413`).
- The platform rollup reader hard-codes `held: 0n` (`platform-metrics/adapters/kysely-source.ts:38`).

## Decisions

### D1. One summary read that shares the attention registry, source port and cache
| Criterion | (a) Extend `/v1/admin/attention` | **(b) New `/v1/admin/home/summary`, shared registry and cache** | (c) Keep client list reads |
|---|---|---|---|
| Complexity | Low code, but changes a released contract (cap, snapshot) | Medium: one route, one shared service | None |
| Accuracy | Exact counts would break the 1,000 cap contract | Exact counts or `unavailable`; ages on the server clock | Capped "N+", no ages, nav-table visibility drift |
| Cost | 1 call | 1 call; sources read at most once per 30 s across both routes | ~15 calls per render |
| Scalability | Fine | Fine; per-source timeout of 2 s, cache of 30 s | Grows with every tile |

Choice: **(b)**. The attention contract stays stable and the home gets exact counts and ages. One registry with a `surfaces` field and one cache mean the two routes cannot drift or double the load.

Visibility rule: summary items are filtered by `computeCapabilities` (the `me` map, ADR-0048), never by attention's `CAPABILITY_ROLES`. The two disagree today (finance by elevation passes attention's `ledger.integrity.read`, but not `me` or the ledger route). Attention keeps its predicates in this wave. Aligning it is a role change (spec WP B1a, chief reviewer). The new `moderation.read` key is `adminGateDenial(access, MODERATOR_ROLES)`: passkey plus effective role. That is stricter than the moderation route's own gate, and the tightening is recorded. Aligning that route is spec WP B2a, also a role change.

### D2. Overview numbers come from the existing metrics registry, not a new store
| Criterion | **(a) Series route per metric, plus an additive `/top` sub-route** | (b) A new bundled overview endpoint with its own aggregates | (c) Warehouse view |
|---|---|---|---|
| Complexity | Low: registry entries plus one sub-route | Medium: a second definition of every metric | High |
| Accuracy | One definition per metric; ETag; reconciled rollups | Risk of two GMVs that disagree | Exact |
| Cost | About 8 cached calls per render | 1 call | New infrastructure |
| Scalability | Good (rollups) | Good | Best, but blocked by ADR-0002 |

Choice: **(a)**. There is one source of truth per number, and revalidation through ETag is already built. Sparklines reuse the same points, so they cost nothing extra.

Honest-data rules in this decision:
1. Registry entries without a producer answer `503 metric_source_unconfigured` (a new `needsProducer` flag, the same as `needsFacts`), never zeros. This covers all four of `platform.orders.placed`, `platform.seller_orders.placed`, `platform.orders.purchased` and `platform.aov`. Nothing is re-sourced from `checkouts`.
2. Paid seller orders come from the per-store `orders` rollup, which is derived from purchase facts. AOV is per seller order, with numerator and denominator both from `seller_analytics_hourly`, and labelled so.
3. Cross-store sums carry `SUM(held_value)` as `held`. A partial sum is never published as `ok`.
4. A ratio is published only when both steps share a population and a unit. View to bag (two device steps, both consent-sampled) is the only funnel ratio defined. It stays `needsProducer` until an outbox event source and client ingest exist. Placed to paid is not published, because it is 100% by construction. Mixed ratios such as bag to paid are not published, because they would overstate conversion.
5. **The band ships with GMV (gross, before refunds), paid seller orders, units and AOV only.** Funnel tiles show "Not measured yet".
6. Windows are whole Cairo days, so the current and previous windows are both complete.
7. Money is shown exact to the piastre with no compact notation. It is gross, VAT-inclusive and before refunds, and labelled so. "Net" never appears on the band. Whether `gross_minor` also nets order-level voucher shares is unverified (VR-ADMIN-03) and must be closed before the band UI ships.

### D3. The overview renders only on server-declared real data
| Criterion | (a) Client loopback heuristic (today) | **(b) Server config `OUTLET_DATA_PROVENANCE`, fail-closed `synthetic`** | (c) Infer from data |
|---|---|---|---|
| Accuracy | Misses staging on a real host | Explicit | Guesswork |
| Complexity | None | Low | Medium |
| Risk | Synthetic numbers shown as real | Hidden by default | False positives |

Choice: **(b)**. The overview is shown only when provenance is `real`, the flags are allowed, producers are allowed, a watermark exists, and the caller has a metrics capability. Otherwise it is hidden entirely, with the reasons in the response. `real` is refused at boot outside `OUTLET_ENV=production`. Today the band is hidden everywhere, which is the intended state while ADR-0002 is Proposed. Until an `EventSourcePort` over `outbox_events` exists, the watermark never moves, so `no_data_yet` hides the band whatever the provenance. The provenance setting has no effect until then, but it is built so that it is already in place, fail-closed, when the port lands.

### D4. ID lookup probes only the kinds the caller may read, with a uniform 404
| Criterion | **(a) Probe the caller's authorised kinds in parallel, no short-circuit** | (b) Require `kind=` | (c) Global ID index table |
|---|---|---|---|
| Complexity | Low: a resolver per kind through the owning module's `index.ts` | Low | High: a new table, RLS per kind, write fan-out |
| Accuracy | Same object rules as the detail routes | Same | Drift risk |
| Security | Unauthorised kinds never touched, so no status or timing oracle | Same, but `kind` reveals intent | A central table of everything |
| UX | Paste any ID | Users must know the kind | Paste any ID |

Choice: **(a)**. Controls: UUID-only input, never echoed or logged on 4xx; 20 per minute and 300 per day; a not-found budget of 10 per 10 min with a 15 min cooldown and a Security alert, all held in shared state through the `RATE_LIMITER` port (Redis in production), never in process memory, and failing closed if the limiter is down; not-found is always `Problems.notFound()`, whose body (apart from `request_id`) equals an unknown route's 404 through the global `ProblemFilter`; audit before respond, fail closed; results carry kind and href only, with no labels. v1 kinds have existing admin read routes: approval, brand application, seller, payout, reconciliation ticket, ledger entry. Shoppers stay behind `pii-views` with a reason code.

### D5. Command palette is navigation-only and local
Items come from the same visibility function as the sidebar. Matching is client-side with no request per keystroke. A client PII guard never sends phone, email, national-ID or card-like input. Nothing typed is persisted. The sidebar and palette move to one shared gate table (WP-B9), an **explicit hybrid**. `me` has 23 capability keys and the nav has 26 items. 12 items map to existing keys (`moderation` uses the new `moderation.read`). The other 14 keep an interim role list, each pinned by a parity test to the role set of its API read gate. Options compared in spec section 4.4: one new key per area (about 15 keys at once, a large role change) vs the hybrid vs today's table. The hybrid removes the drift without changing authorisation. Each later new key is a role change, reviewed one area at a time by the Architect and the chief reviewer.

### D6. Sparklines are inline SVG
They are drawn from the series points already fetched. Gaps are used for `held`, `not_measured` and `no_bucket` points. Pixel scaling uses integer arithmetic on bigint. A text alternative is provided. No chart library is needed for 7 to 30 points.

## Flags (default blocked, ADR-0028)
`release.admin.home_summary`, `release.admin.home_overview`, `release.admin.metrics_top`, `release.admin.palette`, `release.admin.lookup`; existing `release.admin.metrics` and `kill.analytics.producers` also gate the overview.

## Consequences
- Positive: one home read; exact counts and ages; the existing zero-instead-of-unknown defect is closed; numbers are defined once; lookup cannot be used to learn about objects outside the caller's role.
- Negative: two admin read routes share a registry until attention is sunset (O-8), and they use different predicate sets until B1a. The overview is invisible until an outbox event source exists, the owner sets provenance and producers are allowed. The order-group metrics (per-checkout AOV) wait for the track-5 producer. Funnel tiles show "Not measured yet" until client ingest exists.
- Checkpoints: chief reviewer on lookup and summary authorisation (B7-CR), on the role changes B1a, B2a and each B9-next key, and a milestone review before any flag is allowed with `real` provenance (M-CR).

## Owner decisions required
O-1 overview audience; O-2 who sets `real` provenance and its tie to ADR-0002; O-3 headline GMV definition (gross before refunds, COD at confirmation, vouchers); O-4 "today so far"; O-5 store GMV ranking for ops; O-6 lookup kinds beyond v1 and shopper lookup; O-7 staff telemetry under PDPL (VR-ADMIN-01); O-8 attention sunset; O-9 lookup thresholds; O-10 exact vs banded legal-clock counts. Until answered, the defaults in the spec section 12 stay in code.
