# Admin console Wave B: home summary, ops and finance overview, command palette and ID lookup, sparklines

Status: **Draft design, not built.** ADR-0060 (Proposed). Revised 2026-10-20 for the chief-reviewer's GO WITH CHANGES (B0, B1, B2, B5, B7, B9, definitions sheet, band scope). Each change was checked against the cited code first. Section 0.1 lists the findings, and section 13 lists the changes. Template: master prompt A3. Spec refs: 23 (Admin Console and admin security), 26 (analytics foundation), 25 (UI, accessibility, localisation), A2.4 (money), A2.10 (tests), A2.12 (flags), A2.13 (no fake data), B1 (PDPL), T3 (API rules, deny by default), T5 (ASVS, API Top 10), T8 (SLOs).

Builds on (read in the repo on 2026-10-20):
- `GET /v1/admin/attention`: `apps/api/src/modules/admin-attention` (`domain/attention.ts` `ATTENTION_ITEMS`, `CAPABILITY_ROLES`, `capabilityPredicates`; `adapters/admin-attention.controller.ts`, 2 s source timeout, 30 s cache, count cap 1,000, `state: ok | unavailable`). Spec: `docs/specs/dashboard-foundations.md` section 7.2.
- `GET /v1/admin/metrics/{metricId}`: `apps/api/src/modules/platform-metrics` (registry `domain/registry.ts`, wire `domain/series.ts` `SeriesWire`, gate `ROUTE_ROLES.metricsCounts` = ops, finance and `metricsMoney` = finance, flag `release.admin.metrics`). Spec: `dashboard-foundations.md` track 4. Rollups: `packages/domain/src/seller-analytics/rollup.ts`, `apps/api/src/modules/seller-analytics/adapters/kysely-rollups.ts` (track 6).
- `GET /v1/admin/me` capability map: `apps/api/src/modules/admin/application/me.ts` `computeCapabilities` (ADR-0048). This closed set of 23 keys (`admin/domain/me.ts` `CAPABILITY_KEYS`) is the **only** source of summary visibility (F7). `CAPABILITY_ROLES` in attention is not.
- Seller dashboard summary (commit 06ff88f): `apps/api/src/modules/seller-analytics/application/dashboard.ts`. Pattern reused: one read, previous period of the same length, growth in half-even basis points, null growth when the previous value is 0, unsourced KPIs listed as unavailable and never filled with zero.
- Admin console home (commit 9d81868): `apps/admin-web/src/app/(console)/page.tsx`, `view-models/dashboard.ts` (14 tiles, about 15 list reads, "N+" when a list is capped), `view-models/nav.ts` (`isSyntheticEnvironment` loopback check).
- Role decisions: ADR-0049 (Proposed). Kill-switch polarity: ADR-0028. Unconfigured adapters fail closed: ADR-0029. Cairo buckets: ADR-0047.

Nothing here is a legal position. Every product choice that is not a safe default is an owner decision (section 12).

---

## 0. What exists and what this changes

### 0.1 Findings from reading the code (each one shapes a rule below)
| # | Finding | Effect on this spec |
|---|---|---|
| F1 | **Order counts with no producer would read as zero.** `PLATFORM_FACT_METRICS` (`rollup.ts:36`) is only `units_purchased` and `gmv_purchased_minor`. Nothing writes `orders_placed`, `seller_orders_placed` or `orders_purchased` ("need order-group ids, track 5"). The registry still serves `platform.orders.placed`, `platform.seller_orders.placed` and `platform.orders.purchased` from those rows. When producers run and the watermark moves, these ids return `as_of` set and every point `0`. `platform.aov` returns `null` because its denominator is 0, which is honest but useless. | **WP-B0 (bug fix, first):** all four ids (`platform.orders.placed`, `platform.seller_orders.placed`, `platform.orders.purchased`, `platform.aov`) are marked `needsProducer` and answer `503 metric_source_unconfigured`, the same as `needsFacts`. Nothing is re-sourced in B0. A new `platform.seller_orders.purchased` comes from the per-store `orders` rollup in B5 (section 3.3). |
| F2 | The home decides which tiles to show from the **nav role table** (`navAllowsPath`), but the API decides from **capability predicates**. They disagree. Ops can read reconciliation (`recon.read` = finance, ops), yet the nav gives `/finance` to finance only. The nav gives brand applications to `super_admin`, yet `brand_review.read` is ops and trust_safety only. | The summary is filtered on the server by `computeCapabilities` (F7). The client draws only what the server returns. Moving the nav to the capability map is WP-B9 (section 4.4). |
| F3 | Home tiles are list reads capped at 50 or 100 and shown as "50+". There is no oldest-item age. One home render makes about 15 requests. | One summary read with exact counts and an oldest-item age for each source (section 2). |
| F4 | In production every attention source is Unconfigured (`compose.ts:283`), so every item reports `unavailable`. | Correct and kept. The summary inherits it. Production count adapters are WP-B4. |
| F5 | The only "synthetic" signal is in the client: an API base URL on loopback. Staging on a real hostname with synthetic data would look real. | A server-declared, fail-closed `data_provenance` (section 3.2) decides whether the overview band may render at all. |
| F6 | **Corrected.** The per-store `purchases` rollup counts **purchase line facts**, not orders. Seller `orders` counts each seller order once, in the hour of its earliest purchase fact (`rollup.ts:125-132`). **`checkouts` has no producer.** `mapAnalyticsEnvelope` maps only `store_viewed`, `product_viewed`, `add_to_bag` and `wishlist_added`, and says checkout events "are NOT mapped here" (`seller-analytics/application/consume.ts:23-24`). `seller_order.placed` appears only in the watermark's routed-type list (`kysely-rollups.ts:81`), and no consumer turns it into a `checkout` fact. The seller registry tags `checkouts` as a client, consent-sampled metric (`series-registry.ts:40`, `CLIENT = ["consent_sampled"]`). The earlier text ("`checkouts` counts one per seller order placed", "checkouts come from the server") was wrong. | `checkouts` is never used as a platform source. A ratio may only divide two steps measured on the same population, at the same unit (section 3.5). |
| F7 | **Two predicate sets disagree.** `capabilityPredicates` in attention (`admin-attention/domain/attention.ts:20-38`) evaluates `adminGateDenial` over **effective** roles. `computeCapabilities` (`admin/application/me.ts:54-89`) calls each route's own gate. Example: `ledger.integrity.read` is `["finance"]` effective in attention (`attention.ts:21`), but `me` needs an unexpired **standing** finance grant plus passkey (`me.ts:49-51`, `74`). So a user elevated to finance sees the attention item, yet the ledger route refuses them. `privacy.read`, `recon.read`, `tax.read` and `brand_review.read` also use module-owned predicates in `me`. | Summary visibility comes from `computeCapabilities` only (section 2, Rules). Attention keeps its current predicates and snapshot in this wave. The divergence is pinned by a test and listed for correction (section 2, attention divergence). |
| F8 | **Placed and paid are the same moment.** Orders intake runs "after payment or COD confirmation" (`orders/application/intake.ts:17-23`, `paidAtMs`). `KyselyOrdersStore` writes `seller_order.placed` and the `order_line.purchased` drafts in the **same transaction** (`orders/adapters/kysely-store.ts:288-324`). No unpaid seller order exists. | There are no placed-to-paid ratios. "Placed seller orders" is not a separate tile or funnel step (sections 3.3, 3.5, 3.7). |
| F9 | **The moderation gate is looser than the admin gate.** `ReviewsController.requireModerator` (`reviews/adapters/reviews.controller.ts:408-413`) accepts any admin grant whose role is in `MODERATOR_ROLES` (`:103`, module-private: trust_safety, ops, super_admin). It does not check passkey, grant expiry or break-glass. | `moderation.read` is defined as `adminGateDenial(access, MODERATOR_ROLES) === null`, which is stricter. The tightening is recorded (section 2). |
| F10 | **The platform reader drops held values.** `KyselyPlatformRollupSource.read` returns `held: 0n` for every row (`platform-metrics/adapters/kysely-source.ts:38`). `platform_metrics_hourly` has no held column, while `seller_analytics_hourly.held_value` does. The series builder already turns any `held > 0n` in a bucket into a `held` point with `v: null` (`platform-metrics/domain/series.ts:55, 89-93`). | Any cross-store read must carry `SUM(held_value)` through (section 3.3, B5). |
| F11 | **Nothing real can feed the rollups yet.** The only `EventSourcePort` in the repo is `InMemoryEventSource`. No port reads `outbox_events` (`production/bindings.ts:63` platform-metrics, `:108` seller-analytics). `platform_metrics_hourly` and `seller_analytics_hourly` stay empty, and the watermark never moves. | The band shows `no_data_yet` in every environment until that port exists. `OUTLET_DATA_PROVENANCE` has no effect until then (section 3.2). |

### 0.2 Scope
1. `GET /v1/admin/home/summary`: one role-filtered read. It returns, for each attention source, an exact count, the oldest item's age, `as_of`, and a state of `ok` or `unavailable` (never 0 on failure).
2. An overview band for ops and finance. **It ships with four numbers only:** GMV (gross, before refunds), paid seller orders, units purchased and AOV per seller order, plus top stores, each against the previous period. Funnel tiles are drawn as "Not measured yet" until an outbox `EventSourcePort` exists and client ingest is allowed (F11). It is built on `GET /v1/admin/metrics/{metricId}` plus one additive sub-route, `/top`. There is no new store of numbers. The band is hidden entirely when the data is synthetic or unconfigured. It has a definitions sheet and a freshness label.
3. A command palette. It is navigation-only now, plus ID lookup through `GET /v1/admin/lookup?id=`. The lookup is role-scoped, answers 404 when the caller is not authorised, and is rate-limited.
4. Sparklines drawn from the series the overview already fetched.

Out of scope: net revenue, take rate, contribution margin, refunds total, COD refusal rate and cohort metrics. These are ledger-backed or not yet produced. They appear in the definitions sheet as "not measured here", never as zero. Also out of scope: any change to the attention route's contract, and any write.

---

## 1. Options compared (full tables in ADR-0060)

| Decision | Options | Choice and why (2-3 lines) |
|---|---|---|
| D1 Summary read | (a) Extend `/v1/admin/attention` with exact counts and new items. (b) New `/v1/admin/home/summary` that shares the item registry, the source port and one cache with attention. (c) Keep about 15 client list reads. | **(b).** Attention keeps its contract (cap 1,000, role-leakage snapshot) while the summary adds exact counts, age and the overview gate. Sharing the registry and cache means sources are not read twice and the two routes cannot drift. (c) cannot give exact counts or ages. |
| D2 Overview numbers | (a) Client calls the existing series route once per metric and reuses its points for sparklines. (b) A new bundled overview endpoint with its own aggregates. (c) A ClickHouse/warehouse view. | **(a)** plus one additive `/top` sub-route under the same module, gate and registry. There is no second definition of GMV, ETags are already in place, and about 8 calls fit the 60/min limit. (b) duplicates numbers. (c) is blocked by ADR-0002. |
| D3 Synthetic gate | (a) Client loopback heuristic (today). (b) Server config `OUTLET_DATA_PROVENANCE`, fail-closed to `synthetic`, returned in the summary. (c) Infer from data (for example seed markers). | **(b).** It is explicit, auditable, and defaults to hiding. (a) misses staging. (c) is guesswork. |
| D4 Lookup resolution | (a) Probe every kind the caller may read, in parallel, with no short-circuit. (b) Require `kind=` in the request. (c) A global ID index table. | **(a).** IDs are unprefixed UUIDs (`IdGenerator.uuidV7`). Probing only authorised kinds means an unauthorised kind is never touched, so neither timing nor status can reveal it. (c) is a new store that would need RLS for every kind. (b) is clumsy for people pasting IDs from tickets. |
| D5 Sparklines | (a) Inline SVG from the series points. (b) The chart library from the spike. | **(a).** It needs no bundle cost, can be server-rendered, and is about 40 lines. A chart library is overkill for 7 to 30 points. |

---

## 2. Feature 1: `GET /v1/admin/home/summary`

### Flow
1. Admin-web's home server component calls the summary once per render, plus `me`, which it already calls.
2. The API gates the request (any effective admin role plus passkey, the same gate as attention). It picks the sources whose capability predicate the caller passes, reads them in parallel through the shared `AttentionReadService` (2 s timeout each, 30 s cache for sources that are not per-user), and computes the overview gate (section 3.2).
3. Admin-web draws the attention strip and the tile sections from `sources`, and draws the overview band only when `overview.state = "available"`.

### Rules
- **Role filtering.** Sources are visible only through `computeCapabilities({actor, access, rules, nowMs})[item.capability]` (`admin/application/me.ts`). That is the same function and the same inputs `GET /v1/admin/me` uses (M7, ADR-0048 decision 2), computed once per request after the gate. The summary does **not** use `CAPABILITY_ROLES` or `capabilityPredicates` from attention, because they disagree with `me` (F7). Each registry item's `capability` is typed as `CapabilityKey` from `admin/domain/me.ts`. A source the caller may not see is **omitted**, never zeroed. An item never uses a role list or a nav table.
- **Attention divergence (recorded, not fixed here).** `GET /v1/admin/attention` keeps `capabilityPredicates` in this wave, so its contract and role-leakage snapshot do not change. Known effect: an actor holding finance only through elevation sees `ledger.integrity` on attention but not on the summary or `me`, and the ledger route refuses them. That is an over-show on attention: a count, not the data. Moving attention to `computeCapabilities` is a role change, because it changes the attention snapshot. It is follow-up WP **B1a** (Architect plus chief-reviewer, see section 11). A test pins today's divergence so it cannot widen unnoticed (section 7.3, test 5b).
- **Exact or unavailable.** `count` is the full count (`COUNT(*)` over the source's indexed predicate). It is never a page length and never capped. A source that cannot give an exact count within the timeout reports `unavailable` with `count: null`. A count above `Number.MAX_SAFE_INTEGER` also reports `unavailable`. That cannot happen for queues, but it is a guard.
- **Oldest-item age.** `oldest_at` comes from the source (each item states its age basis in the registry, table below). `oldest_age_seconds` is `floor((server_now - oldest_at) / 1000)`, computed on the server so device clock skew cannot distort it. It is `null` when the count is 0 or the source has no age concept. `deadline_at` is unchanged from attention.
- **`as_of`.** The response carries `as_of`, the server time of assembly. Each source also carries `read_at`, the time the reading was taken (it differs from `as_of` when the reading came from the 30 s cache).
- **Shared registry.** `ATTENTION_ITEMS` gains a field `surfaces: readonly ("attention" | "summary")[]`. The 11 existing items have both. The new items below are `summary` only, so the attention role-leakage snapshot does not change. All 9 capability names used by the existing items are also `me` keys, so one name resolves through `capabilityPredicates` on attention and through `computeCapabilities` on the summary (F7). Attention keeps its cap of 1,000. The summary never caps.
- **Shared cache.** The per-source cache moves out of `AdminAttentionController` into an `AttentionReadService` in the same module. Both routes use it, so a home render plus the strip read each source at most once per 30 s. Per-user sources are never cached.
- **Severity mapping for the UI.** `critical` maps to breach, `warning` to action, `info` to info. The client keeps its "visible word, never colour alone" rule.

### Source registry (v2)
Existing items (unchanged, `surfaces: [attention, summary]`):

| id | group | capability | severity | age basis (`oldest_at`) |
|---|---|---|---|---|
| `ledger.integrity` | page | `ledger.integrity.read` | critical | started_at of the failing or stale run |
| `outbox.dead_lettered` | page | `flags.read` | critical | oldest dead-lettered `created_at` |
| `privacy.breaches_open` | legal_clock | `privacy.read` | critical | detected_at of the oldest open breach (`deadline_at` = 72 h clock) |
| `privacy.requests_near_sla` | legal_clock | `privacy.read` | warning | received_at of the oldest request past 23 days |
| `kyc.suspension_reviews_overdue` | legal_clock | `kyc_review.read` | critical | opened_at of the oldest overdue review |
| `recon.tickets_aged` | money | `recon.read` | warning | opened_at of the oldest aged ticket |
| `payouts.on_hold_or_failed` | money | `payout.read` | warning | updated_at of the oldest payout in ON_HOLD or FAILED |
| `tax.rejected` | money | `tax.read` | warning | rejected_at of the oldest rejection |
| `approvals.waiting_on_me` | approvals | `console.access` (per user) | info | created_at of the oldest approval the caller may decide |
| `elevations.expiring` | approvals | `console.access` (per user) | info | none (`deadline_at` = soonest expiry) |
| `brand_applications.sla_late` | trust | `brand_review.read` | warning | submitted_at of the oldest late application |

New items (`surfaces: [summary]`). They replace the list reads the home makes today:

| id | group | capability | severity | count | age basis |
|---|---|---|---|---|---|
| `approvals.refund_waiting_on_me` | approvals | `console.access` (per user) | info | subset of `approvals.waiting_on_me` with kind `refund` | created_at |
| `brand_applications.unassigned` | trust | `brand_review.read` | warning | IN_REVIEW with no assignee | submitted_at |
| `brand_applications.assigned_to_me` | trust | `brand_review.read` (per user) | info | open and assigned to the caller | assigned_at |
| `kyc.queue_open` | trust | **`kyc.read`** (existing `me` key: `canPassAdminGate(access, ROUTE_ROLES.kycRead)`, `me.ts:69`; no new key) | warning | stores in KYC states awaiting a decision (SUBMITTED, AUTO_CHECKS, NEEDS_INFO resubmitted) | submitted_at |
| `moderation.held` | trust | **`moderation.read`** (new `me` key, specified below) | warning | moderation items in HELD | held_at |
| `privacy.requests_open` | legal_clock | `privacy.read` | info | open DSARs | received_at |
| `flags.kill_switches_engaged` | anomaly | `flags.read` | info | registry kill switches currently blocked | `updated_at` of the oldest engaged switch if the flag store records it, else `null` |

**`moderation.read` (new capability key, WP-B2).**
- Definition: `"moderation.read": adminGateDenial(access, MODERATOR_ROLES) === null`, the same as `canPassAdminGate(access, MODERATOR_ROLES)`. The caller needs a standing admin grant, a **passkey session** and an **effective** role in `MODERATOR_ROLES` (trust_safety, ops, super_admin; standing super_admin counts only with break-glass live, per `computeAccess`).
- `MODERATOR_ROLES` moves from a module-private constant (`reviews.controller.ts:103`) to an export of the reviews module's public `index.ts`. Both the controller and `computeCapabilities` import that one constant, so the role list cannot drift.
- Added to `CAPABILITY_KEYS` and `computeCapabilities` in the same change. The `me` OpenAPI schema and the admin-web `me` Zod schema gain the key in the same PR. Admin-web parses `me` strictly, so a stale client fails closed and shows nothing privileged. The builder checks the `me` contract test to decide whether an added key needs `ADMIN_ME_VERSION` 2. Default: the closed set changes, so bump to 2.
- **Tightening, recorded.** The existing route gate `requireModerator` (`reviews.controller.ts:408-413`) is looser. It accepts any admin grant in `MODERATOR_ROLES` with no passkey check, no expiry check, and standing super_admin without break-glass. The capability is stricter, so the summary may hide `moderation.held` from someone the moderation queue route still admits. That is an under-show, which is safe. Aligning `requireModerator` to `adminGateDenial(access, MODERATOR_ROLES)` is a **separate role change** (WP **B2a**: Architect plus chief-reviewer, its own negative tests). It is not done silently in B2.

A new capability is a role change if it grants a role a page that role cannot already open. `kyc.read` already exists. `moderation.read` is narrower than the existing moderation gate, so it grants nothing new. The `me`-consistency property test (section 7.3, test 5) proves the summary follows `me`.

### Edge cases
- Caller has an effective role but no capability that any source needs (marketing): `sources` holds only the approvals and elevations items. The overview is hidden with reason `no_capability`.
- Standing `super_admin` without break-glass has no effective role: 403, as on attention.
- A source that returns a negative count or a non-integer means an adapter bug. It reports `unavailable`, and the counter `outlet.admin.home.source_invalid{source}` increments.
- Count 0: `oldest_at` and `oldest_age_seconds` are `null`.
- Clock: `oldest_at` in the future (clock skew between DB and API) clamps age to 0.
- A per-user source and an elevation that lapses mid-request: access is computed once at the gate. The next request re-evaluates.

### Data
No new table. New count queries are exposed by the owning modules through their public `index.ts` (A2.3): brand review, KYC, reviews moderation, privacy, feature flags, approvals. Each query must be served by an index. Builders add a partial index where the predicate is a state, for example `WHERE status = 'HELD'`, using expand-only migrations. PII class of the response: P1 (counts and timestamps only).

New config: `OUTLET_DATA_PROVENANCE` with values `synthetic | real`. If it is missing or invalid, the value is `synthetic` and a boot log line names it. `real` is refused at boot unless `OUTLET_ENV=production`. Setting `real` is a release-checklist item tied to ADR-0002 (owner decision O-2).

### API
`GET /v1/admin/home/summary` · audience `admin_api` · any effective admin role plus passkey (same gate and audit as `/v1/admin/attention`, `ruleId: admin_home.summary`) · not idempotent-keyed (read) · rate limit 30/60 s per user · `Cache-Control: private, no-store` · flag `release.admin.home_summary` (blocked: 404 before anything is read or audited).

```yaml
AdminHomeSummary:
  type: object
  additionalProperties: false
  required: [version, as_of, server_time, data_provenance, sources, overview, ui]
  properties:
    version: { type: integer, enum: [1] }
    as_of: { type: string, format: date-time }
    server_time: { type: string, format: date-time }      # for freshness and age labels; never the device clock
    data_provenance: { type: string, enum: [synthetic, real] }
    sources:
      type: array
      maxItems: 32
      items:
        type: object
        additionalProperties: false
        required: [id, group, severity, href, state, count, oldest_at, oldest_age_seconds, deadline_at, read_at]
        properties:
          id: { type: string }                                # closed enum = summary surface of ATTENTION_ITEMS
          group: { type: string, enum: [page, legal_clock, money, approvals, trust, anomaly] }
          severity: { type: string, enum: [info, warning, critical] }
          href: { type: string, pattern: "^/[a-z0-9/_?=&-]*$" }
          state: { type: string, enum: [ok, unavailable] }
          count: { type: [integer, "null"], minimum: 0 }      # exact; null iff unavailable
          oldest_at: { type: [string, "null"], format: date-time }
          oldest_age_seconds: { type: [integer, "null"], minimum: 0 }
          deadline_at: { type: [string, "null"], format: date-time }
          read_at: { type: [string, "null"], format: date-time }   # null iff unavailable
    overview:
      type: object
      additionalProperties: false
      required: [state, hidden_reasons, metric_ids, top]
      properties:
        state: { type: string, enum: [available, hidden] }
        hidden_reasons:                                       # empty iff available; all that apply, in this order
          type: array
          items: { type: string, enum: [overview_disabled, metrics_disabled, synthetic_data, no_capability, producers_blocked, no_data_yet, metrics_unavailable] }
        metric_ids:                                           # registry ids the caller may read; empty when hidden
          type: array
          items: { type: string }
        top:                                                  # (metricId, dimension) pairs the caller may read
          type: array
          items:
            type: object
            additionalProperties: false
            required: [metric_id, dimension]
            properties:
              metric_id: { type: string }
              dimension: { type: string, enum: [store, product] }
    ui:
      type: object
      additionalProperties: false
      required: [palette, lookup]
      properties:
        palette: { type: boolean }   # release.admin.palette, derived; flag states themselves are not exposed (flags.read is restricted)
        lookup: { type: boolean }    # release.admin.lookup AND the caller has at least one lookup kind
```

### Events
No outbox events (read-only). Server metrics: `outlet.admin.home.summary.reads`, `outlet.admin.home.source_state{source, state}`, `outlet.admin.home.source_latency_ms{source}` (histogram), `outlet.admin.home.source_invalid{source}`. Client analytics: section 9.

### Failure handling
- Each source has a 2 s timeout. A failure or timeout gives `unavailable` for that source only. The route still answers 200.
- Elevation store down: 503 `elevations_unavailable`. Audit append failure on allow: 503 `audit_unavailable` (fail closed, as on attention).
- Overview gate inputs: the flag read fails, so the overview is `hidden` with `overview_disabled`. The rollup watermark read fails, so it is `hidden` with `metrics_unavailable`. The UI shows the band's error state, never zeros.

### Security and abuse
- AuthZ: deny by default. Items are filtered by named predicates. Omitted, never zeroed, so the response does not reveal that a queue exists (API1, API5). Counts only, so no PII (API3). Explicit serializer.
- Abuse: 30/min per user. Sources are cached 30 s, so polling cannot load the DB. Each source has a statement timeout of 2 s.
- Disclosure: `privacy.*` counts are visible to the DPO only (`privacy.read`). Breach counts are sensitive, which is why they stay behind that one predicate.

### Metrics (SLO)
Summary p95 under 600 ms with every source configured, which is bounded by the 2 s source timeout. Home render: one summary request instead of about 15 list requests. Guardrail: the `unavailable` rate per source, alerting above 5% over 1 h.

### Acceptance (section 10 lists the Gherkin)

---

## 3. Feature 2: ops and finance overview band

### 3.1 Flow
1. The home renders the band only if `summary.overview.state = "available"`. Otherwise nothing is rendered: no card, no skeleton, no "0". Only users who can read the engineering page see the hidden reasons, there.
2. The period selector offers **Last 7 days** and **Last 30 days**. Both are complete Africa/Cairo days ending at the last Cairo midnight, compared with the immediately preceding window of the same length. The default is 7 days. "Today so far" is owner decision O-4 and is not built by default (section 3.6).
3. For each `metric_id` in `overview.metric_ids`, the server component calls `GET /v1/admin/metrics/{id}?from&to&grain=day&compare=previous_period` in parallel (about 8 calls; ETag revalidation). It calls `/top` for each pair in `overview.top`.
4. Each tile shows: value, absolute delta, percentage delta, sparkline, and a freshness label. A "Definitions" button opens the sheet (3.7).

### 3.2 Overview gate (the honest-data rule)
`overview.state = available` only when **all** of the following hold. Otherwise the state is `hidden`, with every failing reason listed:

| Check | Reason when it fails |
|---|---|
| `release.admin.home_overview` allowed | `overview_disabled` |
| `release.admin.metrics` allowed | `metrics_disabled` |
| `OUTLET_DATA_PROVENANCE = real` | `synthetic_data` |
| Caller passes `metrics.read.counts` or `metrics.read.money` | `no_capability` |
| `kill.analytics.producers` allowed (no producer means no number) | `producers_blocked` |
| Platform rollup watermark `as_of` is not null | `no_data_yet` |
| Watermark read succeeded | `metrics_unavailable` |

Today every environment is `synthetic` (ADR-0002 is Proposed) and producers are blocked, so **the band is hidden everywhere until the owner decisions land**. There is also a more basic block (F11). No `EventSourcePort` reads `outbox_events` (`production/bindings.ts:63, 108`), so the rollup watermark never moves, and `no_data_yet` fails in every environment whatever the other checks say. **`OUTLET_DATA_PROVENANCE` has no effect until an outbox event source exists.** It is still built in B3, so it is already in place, fail-closed, when that port lands. This is intended. Development and tests exercise the band through the API test harness and a Playwright fixture that set provenance and flags explicitly. There is no "demo numbers" mode on the real home.

`metric_ids` holds only ids that are (a) in the overview set (3.4), (b) readable by the caller (counts for ops and finance, money for finance), and (c) not `needsFacts` or `needsProducer`. Any id excluded under (c) is shown as an "unavailable" tile with a "not measured yet" label. It is never dropped silently, because the definitions sheet still lists it.

### 3.3 Registry v2 changes (platform-metrics, closed set)
| id | change | source | unit | access | additive | notes |
|---|---|---|---|---|---|---|
| `platform.orders.placed`, `platform.seller_orders.placed`, `platform.orders.purchased`, `platform.aov` | **mark `needsProducer: true`** (F1): 503 `metric_source_unconfigured`. The order-group ids wait for the track-5 order-group producer. `platform.seller_orders.placed` is **not** re-sourced from `checkouts`, which has no producer and is client-tagged (F6). It stays `needsProducer` until a real `seller_order.placed` to fact mapping exists in the rollup consumer. Even then it would equal paid seller orders (F8), so it is not an overview tile. | none | | | | Bug fix WP-B0 |
| `platform.seller_orders.purchased` | **new** | seller rollup `orders` summed across stores (`platform_from_seller`) | count | counts | yes | counted once per seller order, in the hour of its earliest purchase fact. "Paid" and "placed" are the same event (F8). |
| `platform.aov.seller_order` | **new** ratio `SUM(gmv_minor) / SUM(orders)`, **both** read through `platform_from_seller` from `seller_analytics_hourly`, so numerator and denominator come from one table with one held state; banker's rounding (`bankersDiv`) | seller rollups | piastres | money | no | per seller order, not per checkout |
| `platform.funnel.product_views`, `platform.funnel.bags`, `platform.funnel.view_to_bag_bps` | **new, `needsProducer: true`** until an outbox `EventSourcePort` is bound **and** client ingest is allowed (F11). Then: seller rollups `product_views` and `bags` summed, ratio bags / product_views | seller rollups | count, count, bps | counts | yes, yes, no | `consent_sampled`; both steps from the device. Shown as "Not measured yet" until then. |
| ~~`platform.funnel.checkout_to_paid_bps`~~ | **dropped.** Its denominator has no producer (F6), and placed equals paid (F8). It is not re-added until a real `seller_order.placed` to fact mapping exists **and** an unpaid placed state exists. Neither is planned. | | | | | |
| `platform.gmv.purchased`, `platform.units.purchased`, `platform.stores.with_purchase` | unchanged | | | | | `stores.with_purchase` stays `needsFacts` |

Implementation note for the builder: the `Calc` union already supports `sum`, `aov` and `bps`. Cross-store sums need a `scope: "platform_from_seller"` source on `PlatformRollupReader.read`. It adds no new table and runs one query:
`SELECT hour_utc, SUM(value) AS value, SUM(held_value) AS held FROM seller_analytics_hourly WHERE metric = $1 AND hour_utc >= $2 AND hour_utc < $3 GROUP BY hour_utc`, under the system role inside the platform adapter.

**Held must propagate (F10).** The adapter returns `held = SUM(held_value)` per hour, never the hard-coded `0n` that `kysely-source.ts:38` uses for platform rows. The existing builder (`series.ts:55, 89-93`) then marks any hour where some store has `held_value > 0` as a `held` point with `v: null`. A sum that leaves out one store's held part is a partial number, and it is **never published as `ok`**. For `aov` and ratio calcs, a held hour in either numerator or denominator makes the point held. Required tests: one store held and another clean in the same hour gives a `held` point, not the clean store's value. Window totals follow the existing series rules for held points, unchanged.

`needsProducer` is a registry field checked before any read, exactly like `needsFacts`. The OpenAPI enum must equal the registry (existing contract test).

### 3.4 Overview tiles (default set; owner decision O-1 on audience)
**Ships with (v1 band):**

| Tile | metric id | ops | finance |
|---|---|---|---|
| GMV, gross, purchased, before refunds | `platform.gmv.purchased` | no | yes |
| Paid seller orders | `platform.seller_orders.purchased` | yes | yes |
| Units purchased | `platform.units.purchased` | yes | yes |
| AOV per seller order | `platform.aov.seller_order` | no | yes |

**Drawn as "Not measured yet" (never 0, never hidden silently):**

| Tile | metric id | ops | finance |
|---|---|---|---|
| Stores with a sale | `platform.stores.with_purchase` | yes | yes (needs facts) |
| Funnel: product views, bag adds, view to bag | `platform.funnel.product_views`, `.bags`, `.view_to_bag_bps` | yes | yes (`needsProducer` until an outbox `EventSourcePort` exists and client ingest is allowed) |

**Top lists:**

| Tile | metric id | ops | finance |
|---|---|---|---|
| Top 5 stores by paid seller orders | `/top` `platform.seller_orders.purchased` × store | yes | yes |
| Top 5 stores by GMV | `/top` `platform.gmv.purchased` × store | no | yes |
| Top 5 products by units | `/top` `platform.units.purchased` × product | yes | yes (unavailable until a facts source is wired) |

### 3.5 Funnel rule: no mixed-population ratios
A ratio is published only when its numerator and denominator are measured on the same population and at the same unit:
- **View to bag**: both steps come from the device and both are consent-sampled. The unit is events. Allowed, and labelled "consenting shoppers only".
- **Placed to paid**: **not published.** A seller order is created only after payment or COD confirmation, and `seller_order.placed` and the purchase facts are written in one transaction (F8). The ratio would be 100% by construction, and its denominator has no producer (F6). It comes back only if an unpaid placed state and a real producer ever exist.
- **Bag to paid and view to purchase**: these would divide a server-complete count (paid seller orders or purchase facts) by a consent-sampled one and **overstate conversion**. They are **not published**. The definitions sheet says why. Bag to checkout is also not published, because `checkouts` has no producer (F6).
- The step counts are shown side by side. The client never computes a ratio. Ratios come only from the registry.
- Until an outbox `EventSourcePort` is bound and client ingest is allowed (`flag` and App Attest gate, track 5), the device steps have no producer. `product_views`, `bags` and `view_to_bag_bps` are `needsProducer` and answer `metric_source_unconfigured`. The funnel tiles show "Not measured yet", and the only server count shown is paid seller orders, as its own tile.

### 3.6 Windows and comparison
- Windows are whole Cairo days: `from` = Cairo midnight N days before the last Cairo midnight, `to` = the last Cairo midnight, `grain=day`, `compare=previous_period`. Complete days only, so the current and previous windows are both whole. This avoids comparing a partial current bucket with a full previous one, which `snapWindow` would otherwise produce for a window ending now.
- "Today so far" (O-4) is not built by default. If the owner wants it, the safe form is the value only, with a "partial" label and no delta. A same-elapsed-span comparison (like the seller dashboard's `periodWindows`) would need a new `compare=same_span_previous_day` mode on the series route, which is an additive contract change.
- Delta: `totals.delta` and `totals.delta_bps` from the series. `delta_bps = null` with `previous = 0` is shown as "New" next to the absolute value. `previous = null` (no released points) is shown as "No comparison". Infinity and invented 100% are never shown.
- Point states `partial`, `held`, `not_measured` and `no_bucket` are gaps, never zeros (3.9).

### 3.7 Definitions sheet (static, versioned with the registry)
A dialog opened from the band. Each row has: name (AR/EN), formula, includes, excludes, unit, source and basis, time basis, who can see it, freshness SLO. A CI test asserts that every id in `overview.metric_ids` and every `/top` pair has an AR and an EN entry, and that the sheet's registry version equals the API's.

| Metric | Formula | Includes | Excludes |
|---|---|---|---|
| GMV, gross, purchased | Σ line `gross_minor` of purchase facts in the window, by `purchased_at` (PAID or CONFIRMED_COD). The producer computes `gross_minor = unitPriceMinor × qty − discountAllocMinor`, floored at 0, VAT-inclusive (`analytics-ingest/domain/producers.ts:88-90`). **Whether that is "after item-level discounts" only, or also net of order-level vouchers, is UNVERIFIED until B10 (VR-ADMIN-03).** `discountAllocMinor` is the order line's `discount_alloc`, and the master prompt allocates voucher shares there (spec 7, 15.6). Until VR-ADMIN-03 is closed, the sheet says "after discounts allocated to the line (which discounts are included is being verified)". It does not say "after item-level discounts". | Card, wallet, BNPL and COD-confirmed orders. Store credit and gift-card tender count, because they are tender, not discounts. | Delivery fees, **refunds, returns, cancellations and COD refusals (not deducted)**. Order-level vouchers: unverified (VR-ADMIN-03). |
| Paid seller orders | Seller orders created by orders intake, which runs only after payment or COD confirmation (F8). Each is counted once, in the hour of its earliest purchase fact. "Placed" and "paid" are the same moment here. | One checkout with 3 stores counts 3 | Order groups (not produced yet) |
| AOV per seller order | Σ seller-rollup `gmv_minor` / Σ seller-rollup `orders`, both from `seller_analytics_hourly`, banker's rounding once over the window | | Per-checkout AOV (not produced yet) |
| Units purchased | Σ `qty` of purchase facts | | Returned units (not deducted) |
| Product views, bag adds | Device events from shoppers with `analytics` consent. **Not measured yet**: no outbox event source exists (F11). | | Shoppers without consent (under-counted by design) |
| View to bag | bag adds / product views. **Not measured yet**, as above. | Consenting shoppers only | |
| Not published | Placed to paid (100% by construction, F8), bag to checkout (no checkout producer, F6), bag to paid and view to purchase (mixed populations) | | |
| Not measured here | Net revenue, take rate, contribution margin, refunds total, COD refusal rate, cohorts | Shown as "Not measured here. See Finance" when the page exists, else "Not built yet" | Never shown as 0 |

**Gross vs net.** Everything on this band is **gross and commercial**. Ledger truth (commission, net payable, refunds) lives on the Finance pages and is labelled differently, the same rule as the seller "Reconciliation rule" in `seller-teams-availability-alerts.md` section 4.1. The word "net" does not appear on the band.

### 3.8 Money display rules
- On the wire, money is a decimal string of piastres (`SeriesWire` `unit: piastres`, `currency: EGP`). The client parses with `parseMinor` to `bigint`. `Number()` and floats are never used on money. A lint rule and test cover the overview view-model.
- Formatting uses `formatMoney(minor, locale)`: exact to the piastre, EGP, the user's numeral preference (Western or Eastern Arabic), RTL-safe inside `<bdi>`. **No compact notation in v1** (no "1.2M"), because compacting is a rounding decision. If tiles overflow, the font steps down. The number is never truncated.
- Absolute delta is shown in money with an explicit sign, followed by the percentage. The percentage is `delta_bps / 100` rendered with two decimals using integer arithmetic (1234 bps gives "12.34%"). Rounding happens only on the server (floor in `deltaOf`).
- Direction is shown by an arrow **and** a word ("up" or "down"). Colour is never the only signal. Green is never used for "up" on metrics where up is bad, though none are in v1.
- Every money tile carries the caption "VAT-inclusive, before refunds".

### 3.9 Freshness
- `as_of` per series. The band shows the oldest `as_of` across its tiles: "Updated 14:05 Cairo, 6 min ago". Age is computed against `summary.server_time`, not the device clock.
- Older than 15 min (the spec 19.1 SLO): an amber "Delayed" label with its word. Older than 24 h: values are greyed with "Data more than a day old". The values are still real and are not hidden.
- A series with `as_of: null` gives that tile "No data yet", never 0.
- A 503 `metric_source_unconfigured` gives "Not measured yet". A 503 `platform_metrics_unavailable` or a timeout gives the tile error state with retry.

### 3.10 `/top` sub-route (additive, same module, same gate)
`GET /v1/admin/metrics/{metricId}/top?from&to&dimension=store|product&limit&compare` · `admin_api` · gate as the series route (allowed pair counts → `metrics.read.counts`, money → `metrics.read.money`; an unknown pair is gated as money so ops cannot tell the two apart) · 60/60 s per user (shared bucket with the series route) · `Cache-Control: private, no-cache` plus strong ETag (series ETag key plus `dimension` and `limit`) · flag `release.admin.metrics_top` (and `release.admin.metrics`).

- Allowed pairs (closed): `(platform.seller_orders.purchased, store)` counts, `(platform.gmv.purchased, store)` money, `(platform.units.purchased, product)` counts with `needsFacts` (503 `metric_source_unconfigured` until a facts source is wired). Any other pair is 404 `unknown_metric` after the gate.
- Window: whole Cairo days only (`from` and `to` must be Cairo midnights; otherwise 400 `window_not_on_day_grid`), at most 92 days. `limit` is 1 to 10, default 5. `compare` is `previous_period | none`.
- Store sources: the per-store rollups (`orders`, `gmv_minor`) summed over the window under the system role inside the adapter, together with `SUM(held_value)`. Statement timeout 2 s. Ordering: value descending, then `store_id` ascending. Zero-value stores are excluded.
- **Held (F10).** If any store has `held_value > 0` for the metric anywhere in the current or previous window, the response is `state: held` with `rows: []` and every total `null`. A ranking or total computed without the held part is never returned as `ok`. The tile shows "Held for review". Per-row held is not used, because the platform total would still be partial.

```yaml
MetricTop:
  type: object
  additionalProperties: false
  required: [id, version, state, dimension, window, unit, currency, rows, total_current, total_previous, as_of, basis]
  properties:
    id: { type: string }
    version: { type: integer, enum: [1] }
    state: { type: string, enum: [ok, held] }            # held: rows empty, totals null (F10)
    dimension: { type: string, enum: [store, product] }
    window: { $ref: "#/components/schemas/MetricSeries/properties/window" }
    unit: { type: string, enum: [piastres, count] }
    currency: { type: [string, "null"], enum: [EGP, null] }
    rows:
      type: array
      maxItems: 10
      items:
        type: object
        additionalProperties: false
        required: [rank, key, label, status, current, previous, delta, delta_bps, previous_rank]
        properties:
          rank: { type: integer, minimum: 1 }
          key: { type: string, format: uuid }              # store_id or product_id
          label: { type: object, required: [ar, en], properties: { ar: { type: [string, "null"] }, en: { type: [string, "null"] } } }  # store display name / product title: P0 catalogue text
          status: { type: string, enum: [active, paused, suspended, closed, delisted] }
          current: { type: [string, integer] }             # piastres string or integer count
          previous: { type: [string, integer, "null"] }
          delta: { type: [string, integer, "null"] }
          delta_bps: { type: [integer, "null"] }
          previous_rank: { type: [integer, "null"] }       # null when not in the previous top `limit`
    total_current: { type: [string, integer, "null"] }     # platform total in the window (to show share honestly); null iff state = held
    total_previous: { type: [string, integer, "null"] }
    as_of: { type: [string, "null"], format: date-time }
    basis: { type: string, enum: [rollup, exact_facts] }
```
Labels are public catalogue names (P0). A seller's legal name or signatory is never used, because a sole proprietor's legal name is personal data. A suspended or closed store keeps its row, with a status chip, so numbers are not hidden by later actions.

### 3.11 Edge cases
A window before launch (`notes: launch_period`). A DST day of 23 or 25 hours (the label carries `hours`). Every point `held` (the tile shows "Held for review", total `null`). A store renamed in the window (current name shown). Ops opening a money `/top` directly gets 403. A finance user with a lapsed passkey session gets 403 `passkey_required`, and the band is shown only after re-auth.

---

## 4. Feature 3: command palette and ID lookup

### 4.1 Palette flow (navigation only)
1. It opens with Ctrl+K or Cmd+K **and** a visible "Search" button in the top bar, so it is not shortcut-only (WCAG 2.1.1). It uses the ARIA combobox and listbox pattern, has focus trap and return, works in RTL, and moves with arrow keys in reading order.
2. Items are the sidebar's visible nav items: the **same function** as the sidebar, so they can never disagree. Matching is local, over the AR and EN labels plus a short alias list in i18n (for example "payouts" finds Finance). There is **no network request per keystroke**.
3. Selecting an item navigates. The palette closes and clears its input.
4. When `summary.ui.palette` is false, the palette and its button are not rendered.

### 4.2 ID mode
- If the trimmed input matches the UUID shape `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` and `summary.ui.lookup` is true, the first row is "Look up this ID". It is submitted **only on Enter or click**, once per input value, never while typing.
- One result navigates directly. Several results (a UUID collision across kinds, which is extremely unlikely) show a list of kind plus short ID. 404 shows "Nothing you can open has this ID". The message is the same whether the ID does not exist or exists elsewhere. 429 shows "Too many lookups, try again in N minutes". 503 shows "Lookup unavailable".
- **PII guard (client).** If the input looks like a phone number (E.164, or Egyptian `01` followed by 9 digits), an email, a 14-digit national ID or a card-like digit run (13 to 19 digits), it is **never sent** and never logged. The palette shows "This looks like personal data. Use PII lookup, which needs a reason." That links to `/pii` when the caller has `pii.view`, and is plain text otherwise.
- **Nothing typed is persisted.** There is no recent-search history. An optional "recent pages" list stores nav item ids only (localStorage wrapped in try/catch, never IDs or text).

### 4.3 `GET /v1/admin/lookup?id=`
`admin_api` · any effective admin role plus passkey (`ruleId: admin.lookup`) · rate limits per user: **20/60 s and 300/24 h**, plus a **not-found budget of 10 per 10 min**. Exceeding the budget gives 429 `lookup_cooldown` for 15 min, increments `outlet.admin.lookup.cooldown` and alerts Security when more than 3 users hit it within 1 h · `Cache-Control: private, no-store` · flag `release.admin.lookup` (blocked: 404).

- **Shared state, not in-process.** The 20/60 s and 300/24 h limits, the not-found budget, the 15 min cooldown and the "more than 3 users in 1 h" alert window are all kept in **shared state**, through the existing `RATE_LIMITER` port (`platform/ports.ts` `RateLimiter`; production binding `production/adapters/redis/rate-limiter.ts` `RedisRateLimiter`). Keys:
  - `admin.lookup:{userId}` for the request limits.
  - `admin.lookup.nf:{userId}` for the not-found budget, consumed only on a 404 outcome.
  - `admin.lookup.cd:{userId}` for the cooldown: a rule with limit 0 for 15 min, set when the budget is exhausted and checked before any probe.
  - `admin.lookup.cd_users` for the alert window.

  No `Map`, module variable or per-instance cache holds any of these, because with several API replicas an in-process counter would multiply the budget by the replica count. If the limiter is unavailable, the route answers 503 `lookup_unavailable` (fail closed). A test runs two app instances over one limiter and asserts that the 11th not-found across both gives `lookup_cooldown`.
- **Uniform 404, testable.** A not-found lookup throws `Problems.notFound()` (`platform/problem.ts:54`: status 404, slug `not-found`, title "Resource not found", code `not_found`) and nothing else. No `detail`, no extensions, no echo of `id`. The global `ProblemFilter` (`platform/problem.filter.ts`, bound as `APP_FILTER` in `platform.module.ts:112`) renders it through `problemBody`. Checked in the code: an unknown route raises Nest's `NotFoundException`, which the same filter maps to the same status, slug, title and code (`toProblem`, `HttpException` branch). Both bodies are therefore `{type:"/problems/not-found", title:"Resource not found", status:404, code:"not_found", request_id}`.
  - Test 14 compares the JSON body with `request_id` removed against an unknown route's 404, such as `GET /v1/admin/does-not-exist`. Both requests carry the same valid admin token, and the bytes must be equal after that removal.
  - Headers are compared between two **lookup** 404s (an ID that exists in an unauthorised kind vs a random UUID), excluding `X-Request-Id` and the `RateLimit-*` headers that `rate-limit.guard.ts:71-73` sets. They are not compared against the unknown route's headers, because unknown routes do not pass the rate-limit guard.
  - A guard test fails if `ProblemFilter`'s 404 mapping or `Problems.notFound()` diverge.

- **Validation.** `id` must be a UUID (the strict regex above), normalised to lowercase. Anything else is 400 `invalid_id`. The value is **never echoed** in the problem body or logs (the request logger redacts the `id` query value on 4xx).
- **Resolution.** A closed registry `LOOKUP_KINDS`. Each entry is `{kind, capability, resolve(id, actor) → visible: boolean, href(id)}`, and `resolve` calls the owning module's public `index.ts` with the **same object-level rule as its detail route**, for example approval visibility per kind. For each request:
  1. The kinds probed are exactly those whose capability the caller passes. Kinds the caller cannot read are **never probed**.
  2. All of those kinds are probed in parallel, each with a 1 s timeout, and all are awaited (no short-circuit), so response time depends on the caller's kind set, not on where the ID lives.
  3. At least one visible match gives 200. No match with every probe ok gives 404 `not_found`, with a body byte-identical to an unknown route's 404. No match with any probe failed gives 503 `lookup_unavailable` (honest: "we could not check", not "it does not exist").
- **Audit.** Before responding, an admin audit row is appended: `action: admin.lookup`, `diff: {id, kinds_probed, result_kinds}`. The ID is P1 and not personal. If the audit append fails, the response is 503 `audit_unavailable`. Denies are audited by the gate.

Kinds v1. Each needs an existing admin read route, so a match is something the caller can already open:

| kind | capability | visibility rule reused | href |
|---|---|---|---|
| `approval` | `console.access` | `GET /v1/admin/approvals/:id` visibility (requester, or approver role for that kind) | `/approvals?focus={id}` |
| `brand_application` | `brand_review.read` | brand review gate | `/brand-applications/{id}` |
| `seller` | `kyc.read` | `GET /v1/admin/kyc/sellers/:sellerId` | `/sellers?focus={id}` |
| `payout` | `payout.read` | `GET /v1/admin/finance/payouts/:id` | `/finance?payout={id}` |
| `recon_ticket` | `recon.read` | `GET /v1/admin/finance/reconciliation/tickets/:id` | `/finance?ticket={id}` |
| `ledger_entry` | `ledger.read` | `GET /v1/admin/ledger/entries/:id` | `/finance?entry={id}` |

Excluded on purpose:
- Shoppers and users (personal data: only through `POST /v1/admin/pii-views` with a reason code).
- Orders, order groups, refunds and returns (there is no admin read route yet; add them when one exists, owner decision O-6).
- Gift-card codes (secret, stored as HMAC; never looked up).
- Phone, email, national ID, IBAN.
- Prefix or partial search (that would be enumeration).

```yaml
AdminLookupResult:
  type: object
  additionalProperties: false
  required: [id, results]
  properties:
    id: { type: string, format: uuid }
    results:
      type: array
      minItems: 1
      maxItems: 6
      items:
        type: object
        additionalProperties: false
        required: [kind, href]
        properties:
          kind: { type: string, enum: [approval, brand_application, seller, payout, recon_ticket, ledger_entry] }
          href: { type: string }
```
The result carries **no label**: no store name, no brand name, no amount. The destination page renders details under its own gate. A palette screenshot therefore never holds PII or money.

Destination builder note: the list pages must accept `?focus=` (or `payout`, `ticket`, `entry`) and scroll to the item or open its drawer. An unknown or unauthorised focus is ignored silently, because the page's own read decides.

---
### 4.4 WP-B9: sidebar and palette visibility (explicit hybrid)
**The problem, checked in the code.** `computeCapabilities` returns a closed set of **23** keys (`admin/domain/me.ts` `CAPABILITY_KEYS`). The nav role table has **26** items (`apps/admin-web/src/view-models/nav.ts:31-56`). The reviewer's figures were about 25 and 27; the actual counts are 23 and 26. Most nav areas have no capability key, so "move the nav to the capability map" is not achievable as first written.

| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (a) Add one new `me` key per unmapped area (about 15 keys) | High: 15 gates mirrored at once, `me` v2, a 15-row role review | Exact once done | Large single review | Best long-term |
| **(b) Explicit hybrid: map the 12 items that already have a key; keep a role list only for the other 14, each pinned to its API gate by a parity test** | Medium | Exact for the 12; checked equality for the 14 | No role change in B9 | New keys can be added area by area later |
| (c) Keep the role table (today) | None | Drifts (F2) | None | Poor |

**Choice: (b).** It removes the F2 drift without a large authorisation change, and makes every remaining role list provably equal to its API gate. Each new key is still a role change and goes through review one area at a time.

Mapping (`ADMIN_NAV_GATES`, one table that both the sidebar and the palette read):

| Nav item | Gate source | Gate |
|---|---|---|
| home, approvals, elevation | capability | `console.access` |
| sellers | capability | `kyc.read` |
| brand-applications | capability | `brand_review.read` (drops `super_admin`, which the API never allowed: F2) |
| suspensions | capability | `kyc_review.read` |
| flags | capability | `flags.read` |
| privacy | capability | `privacy.read` |
| tax | capability | `tax.read` |
| finance | capability, any of | `payout.read`, `recon.read`, `ledger.read` (the page renders each section under its own key) |
| moderation | capability | `moderation.read` (from B2; depends on B2) |
| pii | capability | `pii.view` |
| price-integrity, returns, promotions, plus, gift-cards, rewards, calendar, drops, price-matching, ads, resale-hub, engineering, creators, ranking | roles (interim) | the role set of that area's API read gate |

Rules:
1. `ADMIN_NAV_GATES` lives in a workspace package that both apps can import (default `packages/policy`, export `adminNavGates`). Each entry is `{ kind: "capability", keys, mode: "all" | "any" }` or `{ kind: "roles", roles }`. Admin-web's `navFor` takes the parsed `me` (`capabilities` and effective `roles`) and fails closed when `me` is missing, as today.
2. **Parity test (apps/api, `admin-nav-parity.test.ts`).** For each `capability` entry, every key must be in `CAPABILITY_KEYS` (a type error otherwise). For each `roles` entry, the test asserts set equality with the API gate of that area's primary read route. That gate is either an exported role constant from the owning module's `index.ts` (exported in B9 where it is private today, as `MODERATOR_ROLES` is in B2), or, for rule-based gates, the set of roles for which `adminRuleGate(rules, ruleId, actorWithRole, now)` is true. The test lists the route it pinned for each item, so a reviewer can see the mapping. A nav item with no identifiable API read route fails the test until one is named.
3. **Role-change flag.** Replacing a `roles` entry with a new capability key is a role change, because it adds a key to `me` and may change who sees the area. Each such change needs Architect plus chief-reviewer review and is out of B9's scope. B9 adds **no** new keys except `moderation.read`, which B2 adds.
4. Visible effect of B9: ops gains the Finance link (the API already allows `payout.read` and `recon.read` for ops), and super_admin loses Brand applications (the API already refuses it). Both are UI corrections, not authorisation changes. They are listed in the PR for review.

---

## 5. Feature 4: sparklines
- Source: the `current` series points of the same response the tile already fetched (`grain=day`, 7 or 30 points). There is no extra call. The previous series is not drawn, to avoid clutter; the delta already states the comparison.
- Rendering: inline SVG, server-rendered, `aria-hidden="true"` on the drawing, with a text alternative next to it: "Lowest 1,204 on 14 Oct, highest 1,980 on 18 Oct, last 1,733". The text uses the same formatter as the tile.
- Point states: `ok` is plotted. `partial` cannot occur on complete-day windows; if it does, it is a dashed final segment. `held`, `not_measured` and `no_bucket` **break the line** (a gap), never drop to zero. A ratio point with `v: null` is a gap.
- Money points: `bigint` scaled to the drawing height with integer arithmetic: `y = H - (v - min) * H / (max - min)`, then rounded to an integer pixel. The only `Number` conversion is the final pixel value. A flat series is drawn at mid-height.
- RTL: time runs right to left in Arabic, pending the ADR-0047 axis decision (VR-DASH-01). The sparkline follows the same one setting as the charts. Default: mirror in RTL.
- Tokens: a single stroke colour token, dark and light. There is no area fill on ratio metrics. Reduce Motion means no draw animation.

---

## 6. Flags and kill switches (all default blocked, ADR-0028 polarity, registry `packages/feature-flags/src/registry.ts`)
| Key | Blocks | Blocked behaviour |
|---|---|---|
| `release.admin.home_summary` | `GET /v1/admin/home/summary` | 404. Admin-web keeps the current tile reads as a fallback until removal (WP-B8). |
| `release.admin.home_overview` | Overview band | `overview.state = hidden`, `overview_disabled` |
| `release.admin.metrics` (existing) | Series route | 404, and the overview is hidden with `metrics_disabled` |
| `release.admin.metrics_top` | `/top` sub-route | 404. The top-5 blocks are not rendered. |
| `release.admin.palette` | Palette UI | `ui.palette = false` |
| `release.admin.lookup` | `GET /v1/admin/lookup` | 404. `ui.lookup = false`. The ID row is not shown. |
| `kill.analytics.producers` (existing) | Analytics producers | The overview is hidden with `producers_blocked` |

---

## 7. Authorization

### 7.1 Matrix rows (`docs/security/authz-matrix.md` and `apps/api/test/authz-matrix.test.ts`)
| Route | authz | suite |
|---|---|---|
| `GET /v1/admin/home/summary` | self | `apps/api/src/modules/admin-attention/test/home-summary.http.test.ts` |
| `GET /v1/admin/metrics/:metricId/top` | self | `apps/api/src/modules/platform-metrics/test/top.http.test.ts` |
| `GET /v1/admin/lookup` | self | `apps/api/src/modules/admin-lookup/test/lookup.http.test.ts` (new module `admin-lookup`; it imports owning modules only through `index.ts`) |

### 7.2 Role by surface (safe defaults; O-1 may widen)
| Role (effective) | Summary sources | Overview | `/top` stores by orders | `/top` stores by GMV | Lookup kinds |
|---|---|---|---|---|---|
| ops | flags, kyc review, recon, payouts, tax, brand, kyc queue, moderation (if the moderator rule includes ops), approvals | counts | yes | 403 | approval, brand_application, seller, payout, recon_ticket |
| finance | ledger integrity (standing finance grant only, `me.ts:49-51`), recon, payouts, tax, approvals | counts and money | yes | yes | approval, payout, recon_ticket, ledger_entry (standing grant only, per the ledger gate) |
| trust_safety | kyc review, brand, kyc queue, moderation, approvals | hidden (`no_capability`) | 403 | 403 | approval, brand_application, seller |
| support | kyc queue, approvals | hidden | 403 | 403 | approval, seller |
| marketing | approvals only | hidden | 403 | 403 | approval |
| dpo | privacy (3 items), approvals | hidden | 403 | 403 | approval |
| security | flags, kyc review, approvals | hidden | 403 | 403 | approval |
| super_admin (break-glass live) | as its effective capabilities | as metrics roles (none by default) | 403 | 403 | as capabilities |

Builder rule: this table is **generated in the test from `computeCapabilities`**, not hand-maintained and not from `CAPABILITY_ROLES`. The committed snapshot is the review artefact. Where the hand-written rows above differ from the generated snapshot, the snapshot wins, and the difference is raised in review. Example: ops moderation follows `MODERATOR_ROLES`, which includes ops.

### 7.3 Negative authorization tests (each a named test; A2.10)
Summary:
1. No token: 401. Buyer token or seller token (wrong audience): 401.
2. Standing admin without a passkey session: 403 `passkey_required`.
3. Standing `super_admin` without break-glass: 403 `missing_role`.
4. Role leakage: for every role and every combination of two roles, the source id set equals the snapshot. **finance never sees `privacy.*`**. **support never sees `brand_applications.*`**. **marketing sees only `approvals.*` and `elevations.expiring`**. ops sees `recon.tickets_aged`. **dpo never sees money items**.
5. Consistency with `me` (property, 1,000 runs). For random actors (standing grants, elevations live and lapsed, break-glass, passkey or not, expired grants), `{source.id}` equals `{item | buildAdminMe(sameInputs).capabilities[item.capability] and "summary" in item.surfaces}`. The oracle is `computeCapabilities`/`buildAdminMe` over the same `actor`, `access`, `rules` and `nowMs`. It is **never** `capabilityPredicates` or `CAPABILITY_ROLES` (F7). The generator must include an actor with finance only by elevation, and a moderator without passkey, so the two known divergences are exercised.
5b. Attention divergence pin. An actor with finance only by live elevation and passkey gets `ledger.integrity` from `/v1/admin/attention`, but not from the summary, and `me.capabilities["ledger.integrity.read"]` is false. This test documents F7. It is updated, not deleted, when B1a aligns attention.
5c. Moderation tightening pin. A standing trust_safety grant without a passkey session gets 403 `passkey_required` on the summary, the same as on every admin gate. With a passkey session it gets `moderation.held`. An actor whose only `MODERATOR_ROLES` grant is expired does not get `moderation.held`. `requireModerator` does not check expiry itself (F9). Whether the principal builder already drops expired grants upstream is checked by the builder in B2, and the test records the answer until B2a.
6. Omitted, not zero: a caller without `privacy.read` gets no `privacy.*` element at all, and the response size does not depend on the privacy queue's size (fixture with 0 and with 500 breaches).
7. Per-user sources: actor A's `approvals.waiting_on_me` never includes A's own requests and never equals B's count when the fixtures differ, and is never served from another user's cache entry.
8. Flag blocked: 404 before audit and before any source read (spy asserts zero calls).

Overview and `/top`:

9. ops on `/top` money pair: 403. ops on `platform.aov.seller_order`: 403. marketing on any count metric: 403.
10. Unknown pair from ops: 403 (gated as money). Unknown pair from finance: 404 `unknown_metric`.
11. `needsProducer` metric from finance: 503 `metric_source_unconfigured` and **never** a 200 with zeros (regression test for F1).
12. Summary with provenance `synthetic`: `overview.state = hidden`, `synthetic_data` in reasons, `metric_ids` empty, for every role.

Lookup:

13. No token: 401. Wrong audience: 401. Flag blocked: 404.
14. **404 uniformity:** for an ID that exists as a `ledger_entry`, an ops caller (no `ledger.read`) gets a 404 whose status, headers (except `X-Request-Id` and `RateLimit-*`) and body (except `request_id`) are byte-identical to a random non-existent UUID's lookup 404. The body (except `request_id`) is also byte-identical to an unknown route's 404 (section 4.3).
14b. **Shared budget:** two app instances over one `RateLimiter`. Six not-founds on instance A and five on instance B give `429 lookup_cooldown` on the 11th. The cooldown is still in force on instance A.
15. **No probe of unauthorised kinds:** spy resolvers assert that the `ledger_entry` resolver is never called for ops, and the `brand_application` resolver never for support or finance.
16. **Object-level rule:** an approval the caller can neither request nor decide gives 404, even though `console.access` passes.
17. Invalid ID (`abc`, an email, a phone): 400 `invalid_id`, and the raw value appears in neither the body nor the captured log line.
18. Rate limits: the 21st request in 60 s gives 429. The 11th not-found in 10 min gives 429 `lookup_cooldown` for 15 min, even for a valid existing ID.
19. A resolver timing out with no other match: 503 `lookup_unavailable`, not 404.
20. Audit failure: 503, and no result is returned.

---

## 8. Threat notes (STRIDE; OWASP API Top 10 2023; ASVS 5.0 L2, L3 for money views)
| Threat | Surface | Control |
|---|---|---|
| **Enumeration via lookup** (I) | `/lookup` | UUIDv7 carries about 74 random bits, so blind guessing is infeasible. The real risk is IDs leaked through tickets and screenshots. Defences: capability scoping, object-level rules, byte-identical 404, unauthorised kinds never probed (no timing oracle), the not-found budget, a daily cap, audit of every lookup, and a Security alert on cooldown clusters. API1, API5, ASVS V8 (authorisation). |
| **Timing side channel** (I) | `/lookup` | Every authorised probe is awaited. Latency depends only on the caller's kind set. A test asserts that the probe set is a function of capabilities only. |
| **PII in the palette** (I) | Palette, logs | Client PII guard (phone, email, national ID, card digits never sent). The server accepts UUIDs only. `id` is redacted in 4xx logs. No typed text is persisted. The lookup result has no labels. Analytics events carry no input (section 9). PDPL B1 minimisation. |
| **Role leakage through counts** (I) | Summary | Items omitted, not zeroed. Named predicates shared with `me`. Snapshot and property tests. DPO-only breach counts. |
| **Misleading numbers** (T, integrity of display) | Overview | Provenance gate, fail-closed. `needsProducer` and `needsFacts` give 503, never zero. No mixed-population ratios. Gross label. Freshness label. A2.13 and CPL-style honesty applied internally. |
| **Money data over-exposure** (I) | Overview, `/top` | Money only for `metrics.read.money` (finance). Unknown pairs gated as money. Store GMV ranking is finance-only by default (O-5). |
| **Cache confusion** (I) | Summary | Per-user sources are never cached. The cache key is the source id only for non-personal sources. A test checks two users concurrently. |
| **DoS and cost** (D) | All three | Rate limits. Sources cached 30 s with a 2 s timeout each. `/top` window at most 92 days with a statement timeout of 2 s. No per-keystroke network. API4. |
| **Repudiation** (R) | Lookup, summary | Gate decisions audited. Lookup audited with probed kinds and result kinds, append-before-respond, fail closed. |
| **Spoofed provenance** (S, T) | Config | `real` is refused outside `OUTLET_ENV=production`. Set through IaC only (no runtime toggle). Changing it is a release-checklist step with owner sign-off (O-2). |
| **Elevation** (E) | All | `computeAccess` per request, no caching of access. Break-glass grants only its effective roles. Ledger kinds need a standing finance grant (ledger gate). |

---

## 9. Analytics events and server metrics
**Server metrics (built with the routes; aggregates, no actor id):** `outlet.admin.home.summary.reads`, `outlet.admin.home.source_state{source,state}`, `outlet.admin.home.source_latency_ms{source}`, `outlet.admin.home.source_invalid{source}`, `outlet.admin.home.overview_state{state, first_reason}`, `outlet.admin.metrics.reads{metric}` (existing), `outlet.admin.metrics.top.reads{metric,dimension}`, `outlet.admin.lookup{result=found|not_found|invalid|rate_limited|cooldown|unavailable}`, `outlet.admin.lookup.kinds_probed` (histogram).

**Client console events (proposed for `docs/analytics/events-proposed.md`; not sent until owner decision O-7 on staff telemetry; Zod-typed; no PII, no IDs, no typed text, no user id beyond the pseudonymous analytics id):**
| Event | Payload | When |
|---|---|---|
| `admin_home_viewed` | `overview_shown: boolean`, `source_count: int`, `unavailable_count: int` | Home rendered |
| `admin_overview_period_changed` | `period: "7d" \| "30d"` | Selector changed |
| `admin_definitions_opened` | none | Sheet opened |
| `admin_palette_opened` | `trigger: "shortcut" \| "button"` | Palette opened |
| `admin_palette_navigated` | `nav_id: NavItemId` | Item chosen |
| `admin_lookup_submitted` | `result: "found" \| "not_found" \| "rate_limited" \| "unavailable"`, `result_kind?: LookupKind` | Lookup answered |
| `admin_pii_guard_shown` | none | PII guard triggered (counts only, never the input) |

---

## 10. Acceptance criteria (Gherkin; become API, Playwright and axe tests)
**Summary**
- *Given* a DPO with 3 open breaches, the oldest detected 30 h ago, *when* they load the home, *then* `privacy.breaches_open.count = 3`, `oldest_age_seconds = 108000 ± 60`, and the tile shows "3", not "3+".
- *Given* 1,250 HELD moderation items and a trust_safety caller, *then* the summary count is 1,250 (not capped), while `/v1/admin/attention` still caps at 1,000 for its items.
- *Given* the reconciliation source times out, *then* that tile shows its failure state with "—", the other tiles render, and the strip does not count it as 0.
- *Given* a finance user, *then* no `privacy.*` element exists in the response body.
- *Given* a marketing user, *then* only approval and elevation items are returned and the overview is hidden with `no_capability`.

**Overview**
- *Given* `OUTLET_DATA_PROVENANCE` unset, *then* the band is absent from the DOM for every role, and no metrics request is made.
- *Given* provenance `real`, flags allowed, producers allowed and a finance user, *when* "Last 7 days" is selected, *then* GMV equals the sum of the 7 day points of `platform.gmv.purchased`, the delta equals `totals.delta`, and the percentage equals `delta_bps / 100` to two decimals.
- *Given* the previous window had GMV 0, *then* the tile shows "New" plus the absolute value, never "∞" or "100%".
- *Given* `platform.orders.purchased` has no producer, *then* the series route answers 503 `metric_source_unconfigured`, and no tile shows 0 for it.
- *Given* ops, *then* GMV, AOV and top-by-GMV are not rendered and not requested.
- *Given* the oldest `as_of` is 20 min old, *then* "Delayed" is shown as a word next to the time.
- *Given* a day point `held`, *then* the sparkline has a gap at that day and its text alternative skips it.
- *Given* GMV of `9007199254740993` piastres (above 2^53), *then* the tile renders the exact value.
- The definitions sheet lists every rendered metric in AR and EN. axe reports no violations in light and dark, AR and EN.

**Palette and lookup**
- *Given* the palette is open and the user types "pay", *then* no network request is made and the Finance item is listed only if the sidebar lists it.
- *Given* the user pastes `01012345678`, *then* no request is sent and the PII guidance is shown.
- *Given* ops pastes the UUID of a ledger entry, *then* the response is 404 with the same body as a random UUID, and the ledger resolver was not called.
- *Given* finance pastes the UUID of a payout they may read, *then* one result is returned and the browser navigates to `/finance?payout={id}`.
- *Given* 11 not-found lookups in 10 min, *then* the 12th answers 429 `lookup_cooldown` and the palette shows the wait time.
- The palette is fully operable by keyboard and screen reader in AR (RTL) and EN, and the visible button opens it.

---

## 11. Work packages (tiers per the delegation table; each is one reviewable step)
| WP | Scope | Tier | Depends on | Tests (tester, Sonnet) |
|---|---|---|---|---|
| **B0** | Registry `needsProducer` for all four of `platform.orders.placed`, `platform.seller_orders.placed`, `platform.orders.purchased` and `platform.aov` (F1 bug fix). **No re-sourcing.** `checkouts` has no producer and is client-tagged (F6). | Builder (Sonnet) | none | Regression test 11 for each of the four ids; contract enum equals registry |
| B1 | `AttentionReadService` (shared cache), `surfaces` field, summary route filtered by `computeCapabilities` (not `capabilityPredicates`), flag, OpenAPI, generated client | Builder (Sonnet) | none | Negative tests 1 to 8, 5b; `me`-consistency property against `buildAdminMe`; mutation ≥ 80% on the filter |
| B1a | Align `/v1/admin/attention` to `computeCapabilities` (F7). This changes the attention role-leakage snapshot, so it is a role change. | Architect plus **chief reviewer** | B1 | Snapshot diff reviewed; test 5b updated |
| B2 | New summary sources; new `me` key `moderation.read` = `adminGateDenial(access, MODERATOR_ROLES) === null`, with `MODERATOR_ROLES` exported from the reviews `index.ts`; `kyc.read` reused (already in `me`); `me` schema and version update; count queries in owning modules' `index.ts`; partial indexes (expand-only) | Builder (Sonnet), **Architect review** of the predicate | B1 | Role-leakage snapshot; test 5c; each count query against PGlite |
| B2a | Tighten `ReviewsController.requireModerator` to `adminGateDenial(access, MODERATOR_ROLES)` (passkey, effective role, expiry) (F9). Role change. | Architect plus **chief reviewer** | B2 | Moderation route negative tests: no passkey 403, expired grant 403, super_admin without break-glass 403 |
| B3 | Provenance config, boot guard, overview gate in the summary | Builder (Sonnet) | B1 | Test 12; boot refuses `real` outside production |
| B4 | Production Kysely count adapters for all summary sources (today Unconfigured), RLS role per source | Builder (Sonnet), **Architect review** | B2 | PGlite suite per source; timeout behaviour |
| B5 | Registry v2: `seller_orders.purchased`, `aov.seller_order` (both from seller rollups), funnel ids as `needsProducer`, `checkout_to_paid_bps` not added; the `platform_from_seller` reader scope returning `SUM(held_value)` as `held` | Builder (Sonnet), **Architect review** of ratio rules 3.5 and held propagation | B0 | Property: day sums equal window totals; a held hour in any store gives a `held` point, never `ok`; bigint above 2^53 |
| B6 | `/top` sub-route, flag, ETag, OpenAPI, `state: held` | Builder (Sonnet) | B5 | Tests 9 and 10; ordering and ties property; Cairo-midnight validation; held window gives `state: held` with no rows |
| B7 | Lookup module (`admin-lookup`), registry of 6 kinds through owning modules, rate limits, not-found budget and cooldown in **shared state** through the `RATE_LIMITER` port (Redis in production), audit, log redaction, `Problems.notFound()` only | Builder (Sonnet) | B2 | Tests 13 to 20 and 14b, including spy, the two-instance shared budget, and the body comparison with an unknown-route 404 |
| **B7-CR** | Chief-reviewer checkpoint: lookup authorisation, enumeration and timing controls, summary role leakage | **Chief reviewer (Fable)**; Opus if unavailable, and say so | B7, B2 | Review only |
| B8 | Admin-web: home reads the summary (exact counts, ages, server-time freshness), removes the ~15 list reads behind the flag, keeps the fallback while the flag is blocked | Builder (Sonnet) | B1 | Playwright AR/EN × light/dark, axe |
| B9 | Shared `adminNavGates` table (explicit hybrid, section 4.4): 12 items on `me` capabilities, 14 on interim role lists pinned to their API gate. Export the needed gate role constants. No new `me` keys. | Builder (Sonnet), **Architect review** of the route pinned for each item | B2 (for `moderation.read`) | `admin-nav-parity.test.ts`: each capability entry in `CAPABILITY_KEYS`; each role entry set-equal to its API gate |
| B9-next | Replace interim role entries with new `me` keys, one area per PR. Each is a role change. | Architect plus **chief reviewer** per key | B9 | Parity test entry moves from roles to capability |
| B10 | Admin-web: overview band (GMV, paid seller orders, units, AOV; funnel tiles "Not measured yet"), definitions sheet, sparklines (inline SVG), money formatter use, freshness labels. **Close VR-ADMIN-03 first** and set the GMV "includes" text from the answer. | Builder (Sonnet) | B3, B5, B6, VR-ADMIN-03 | Playwright; formatter tests above 2^53; RTL snapshot; definitions text test pinned to the VR-ADMIN-03 outcome |
| B11 | Admin-web: palette (combobox, nav-only), ID mode, PII guard, `?focus=` on destination pages | Builder (Sonnet) | B7, B9 | Keyboard and screen-reader E2E; the guard's regex table |
| B12 | Authz-matrix rows, flag registry descriptions, i18n key stubs AR/EN, events-proposed rows | Quick fix (Haiku) | B1, B6, B7 | Matrix machine check |
| **M-CR** | Milestone review before any flag is allowed with `real` provenance (money display and personal-data controls) | **Chief reviewer (Fable)** | all | Review only |

Order: B0 first (it fixes a live honesty defect in a route that already exists), then B1 to B4, B5 to B6, B7 to B7-CR, then web B8 to B11. B1a, B2a and B9-next are role changes and are scheduled separately after their reviews. Tier escalation per CLAUDE.md: a builder that fails twice on the predicate mirroring or the ratio rules escalates to the Architect.

---

## 12. Open owner decisions (recorded in ADR-0060; defaults are built)
| # | Decision | Safe default (built) | Blocks |
|---|---|---|---|
| O-1 | Overview audience: should marketing see funnel counts, and should super_admin with break-glass or Security see the band? Extends ADR-0049 item 3. | Counts: ops, finance. Money: finance. | Wider overview access |
| O-2 | Who may set `OUTLET_DATA_PROVENANCE=real`, and is it tied to ADR-0002 acceptance and the release checklist? | `synthetic` everywhere; `real` refused outside production; the band is hidden | Any overview in any environment |
| O-3 | Headline GMV definition: purchased gross before refunds (default), or delivered or net of refunds. Whether COD-confirmed orders count before delivery. Whether order-level vouchers reduce it (VR-ADMIN-03). | Purchased gross, VAT-inclusive, before refunds; COD counted at confirmation; labelled so | The GMV label and definitions text |
| O-4 | "Today so far" tile and its comparison. | Not built. If wanted: value only, "partial", no delta. | Intraday view |
| O-5 | Store GMV ranking visible to ops (commercially sensitive). | Finance only. Ops sees top stores by paid orders. | Ops top-by-GMV |
| O-6 | Lookup kinds beyond v1 (orders, refunds, returns when admin read routes exist). Whether any shopper lookup is ever allowed outside the PII flow. | v1 six kinds. Shopper lookup only through `pii-views` with a reason code. | Order and refund lookup |
| O-7 | Staff telemetry: may admin-console client events be collected, under what staff notice (PDPL, employees as data subjects), and with what retention? (VR-ADMIN-01) | Server aggregate counters only; client events not sent | Section 9 client events |
| O-8 | Sunset of `GET /v1/admin/attention` once admin-web uses the summary (T3 deprecation: at least 6 months, `Sunset` header). | Both kept; attention unchanged | Removing duplicate code |
| O-9 | Lookup thresholds: 20/min, 300/day, a not-found budget of 10 per 10 min, cooldown 15 min, Security alert above 3 users per hour. | As stated, in one config constant | Tuning |
| O-10 | Exact counts of sensitive legal-clock queues (breaches, overdue DSARs) on the home vs a banded display ("1 to 5"). | Exact, DPO only | Display change |

Verify-register rows (added to `docs/compliance/verify-register.md`, section "Admin home and overview rows (VR-ADMIN, ADR-0060)", 2026-10-20):
- **VR-ADMIN-01**: PDPL treatment of staff console telemetry (notice, lawful basis, retention). Owner: DPO or Legal.
- **VR-ADMIN-02**: Retention of admin lookup audit rows (default: the `audit_log` rule). Owner: DPO.
- **VR-ADMIN-03**: Whether `order_line.purchased.gross_minor` (`unitPriceMinor × qty − discountAllocMinor`, `producers.ts:88-90`) nets only item-level discounts or also order-level voucher shares allocated to the line, so the definitions sheet states it exactly. Owner: Engineering. Blocks B10.

---

## 13. Revision log
2026-10-20, chief-reviewer GO WITH CHANGES. Every item was checked against the code before editing, and every claim held. Two counts were corrected: 23 `me` keys and 26 nav items, against the reviewer's "about 25" and "27".
1. B0: no re-sourcing from `checkouts`. All four order ids are `needsProducer`. `checkout_to_paid_bps` is dropped. F6 is corrected.
2. "Placed" equals "paid" (F8). Placed-to-paid ratios are removed from 3.3, 3.5 and 3.7.
3. B1: summary visibility comes from `computeCapabilities`. The attention divergence is recorded (F7, B1a). The property test uses `buildAdminMe` as its oracle.
4. B2: `moderation.read` = `adminGateDenial(access, MODERATOR_ROLES)`. The tightening against `requireModerator` is recorded (F9, B2a).
5. B5: `platform_from_seller` propagates `SUM(held_value)`. `/top` gains `state: held` (F10).
6. B7: rate limits, not-found budget and cooldown live in shared state through `RATE_LIMITER`. The uniform 404 is `Problems.notFound()`, with the comparison against an unknown-route 404 made testable.
7. B9: an explicit hybrid with a parity test (section 4.4). New keys are role changes (B9-next).
8. The GMV definition is unverified until VR-ADMIN-03 is closed (before B10).
9. The band ships with GMV, paid seller orders, units and AOV only. Funnel tiles show "Not measured yet". Provenance has no effect until an outbox `EventSourcePort` exists (F11).
