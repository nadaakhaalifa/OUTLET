# ADR-0045: Dashboard metrics read path: outbox-fed rollups, exact facts for shopper metrics, complementary suppression

- Status: **Proposed.** Engineering parts (decisions 1-3) are a reversible default and may be built now. Decision 4 (with 4a-4c) changes a seller-facing privacy control and needs DPO acceptance (VR-DASH-02, VR-DASH-05) before `release.seller_analytics.shopper_series` is allowed. Decision 5 is an owner and counsel decision (VR-DASH-03); its safe default (producers blocked) is built. Amended 2026-10-16 after the chief-reviewer security and privacy review (B1, B2, B3, H3, M1, M5).
- Date: 2026-10-16
- Deciders: Architect (proposal), DPO (decision 4), Owner and counsel (decision 5), Tech Lead
- Spec refs: `docs/specs/dashboard-foundations.md` tracks 4, 5, 6 and sections 10-12; master prompt 19.1, 26, A2.7, B1; `docs/specs/seller-analytics.md` (algorithm choice, differencing defence); ADR-0029

## Context and problem statement
Dashboards need day and hour time series. Seller analytics today aggregates append-only facts at query time and has no producer in production (`unconfigured("analytics.warehouse")`). There is no warehouse (ClickHouse residency is blocked by ADR-0002). Distinct-shopper numbers and the k >= 50 gate must stay exact. Publishing daily series next to the existing aggregates opens a new differencing channel against the fold-into-smallest-cell rule.

The review found three more facts. (1) Legacy reads snap to UTC days (`snapToDays`, `packages/domain/src/seller-analytics/kanon.ts:87-94`) while series bucket in Africa/Cairo, so mixed-boundary reads of the same facts can be subtracted. (2) The fold rule (`kAnonymizeAdditive`, `kanon.ts:60-85`) **already leaks** across two overlapping legacy requests, because the fold target and the folded set change with the window. (3) Per-request complementary suppression does not protect against differencing two different windows; only a fixed grid plus a persisted, monotone record of what was hidden does.

## Decision
1. **Additive counters come from rollup tables updated by outbox consumers** in the inbox transaction (`seller_analytics_hourly`, `platform_metrics_hourly`, one row per UTC hour with the derived Cairo date, hour and offset). Day, week and month aggregate the hourly rows by Cairo date.
2. **A reconciliation job recomputes recent buckets from facts** (hourly for 48 h, nightly for 35 days). It reads rollups and facts in one `REPEATABLE READ` snapshot and corrects a row only by **compare-and-set on a `version` column**, skipping rows a consumer touched since the snapshot; keys with no rollup row are inserted under the same `pg_advisory_xact_lock(rollup_key_hash(key))` the consumer takes. (The earlier "lock rows, then read facts" design missed new keys, and an `updated_at` test is unsound because `now()` is the transaction start.) It is also the backfill tool.
3. **Distinct-shopper and k-gated metrics never use rollups**; they read facts through one repository function, `releaseShopperTable`.
4. **Complementary suppression with exact union counts** replaces the fold rule for every shopper-gated read (legacy `traffic.by_source`, `geography`, `repeat_rate`, `unique_visitors`, `search_terms`, and all gated series): every published margin minus its released cells equals a hidden set covering at least 50 distinct shoppers, computed by SQL over facts. With:
   - 4a. **One window function** (`gatedWindow`, ADR-0047 grid) for every shopper-gated read, switched in one release for legacy and series alike.
   - 4b. **A fixed calendar grid** for gated metrics: complete Cairo days and complete months, presets `month:YYYY-MM`, `last_full_months:{1,3,6,12}`, `current_month` (no margins); no arbitrary `from`/`to`, no hour, **no week** (Saturday weeks straddle months, so week and month margins are not nested). The released aggregates form a laminar family. _Superseded in proposal by ADR-0052 (Proposed) for the gated-breakdown rules in 4b._
   - 4c. **A persisted, monotone suppression memo** per (store, metric, dimension, dimension key, Cairo bucket or period): once a cell or margin is hidden it stays hidden in every later release that contains it, including the previous-period comparison and after late data or erasure. _Superseded in proposal by ADR-0052 (Proposed) for the gated-breakdown, margin and memo rules in 4b and 4c._
   Until the DPO accepts decision 4, `release.seller_analytics.shopper_series` stays blocked: no gated series exist and the legacy gated fields keep UTC days and the fold rule, so there is no mixed state.
5. **Server producers of checkout, purchase and return facts** (with `governorate`, `size_label` and a consented `shopper_key`) are built behind `kill.analytics.producers`, default blocked. Writing these facts for seller reporting is a lawful-basis decision for the owner and counsel (VR-DASH-03), not an engineering default.
6. **`unique_visitors` is suppressed below 50 distinct shoppers** now (it was released 1-49 with no gate). Releasing it ungated is a DPO decision (VR-DASH-06).
7. **Facts retention and erasure**: facts are purged at 25 months through an `(occurred_at)` index and batched deletes; erasure NULLs `shopper_key` for every live pseudonym (all key versions times all rotation epochs in the retention window) before the user row is erased, and erased keys are remembered 31 days so late outbox payloads are neutralised at ingest.

## Options compared
- Rollups: outbox consumers (chosen) vs scheduled recompute vs ClickHouse. Consumers meet the 15-minute freshness SLO with one idempotent upsert per key per batch; scheduled recompute rescans facts every period and misses late events beyond its window; ClickHouse adds infrastructure that residency blocks. Recompute is kept as the repair path, so a consumer bug is bounded to one reconciliation interval.
- Reconciler concurrency: row locks before reading facts (draft) vs `updated_at` cut-off vs version CAS plus advisory lock for new keys (chosen). Row locks cannot lock a key that does not exist yet; `updated_at` misclassifies a long consumer transaction; CAS is exact and skips at most one run's worth of rows.
- Differencing defence: fold into smallest (current) vs per-request complementary suppression vs complementary suppression on a fixed grid with a monotone memo (chosen) vs noise. Fold leaks within and across requests; per-request suppression still leaks when two different windows are subtracted; noise breaks money reconciliation; a laminar grid plus a monotone memo closes the cross-request channel at the cost of fewer window choices for gated metrics and one small table.
- Facts purge: index plus batched deletes (chosen now) vs monthly partitioning (needs a contract migration of an existing table and a primary-key change); partitioning is the path above about 50 million rows.

## Consequences
- Day and hour series can never disagree (one table).
- Hot keys during drops are bounded by per-batch pre-aggregation and sorted lock order (row and advisory locks in the same order).
- Gated metrics lose arbitrary windows and weeks; sellers pick a month or a preset. The UI states it.
- Gated reads now write (the memo) and serialise per (store, metric, dimension) under an advisory lock; they are rate-limited, so this is cheap. A memo write failure is a 503, never an unchecked release.
- Fixing the fold rule removes a weakness that exists in production code today; the DPO evidence is a committed fixture that reproduces the leak.
- Facts must be retained 25 months and purged afterwards (VR-DASH-04); purge and erasure ship enabled because they only remove data.
- If ClickHouse is approved later, it replaces the rollup adapter behind the same read port; the memo and the grid stay.

## Owner decision required
- DPO: accept decision 4 with 4a-4c as one decision (VR-DASH-02, VR-DASH-05). Safe default: `shopper_series` blocked, legacy behaviour unchanged.
- DPO: ungated `unique_visitors` (VR-DASH-06). Safe default: suppressed below 50.
- Owner and counsel: decision 5 (VR-DASH-03). Safe default: `kill.analytics.producers` blocked.
