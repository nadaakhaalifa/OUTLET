# Dashboards Phase B: show data that already exists (tier 1) in the Admin Console and Seller Center

Status: **Proposed** (architect draft, 2026-10-16). Documents only; no code in this change.
Sources: `reports/Seller and admin dashboards benchmark.md` (sections 3, 4, 5, 8 Phase B, 9), the research notes in `research_notes/Seller and admin dashboards benchmark/`, master prompt sections A3, B1, 19, 19.1, 22, 23 and T4, `docs/design-system/ux-principles.md`, and the code paths cited under each view. Read "HAUL" as "Z-OUTLET".

Depends on: **Phase A foundations**, `docs/specs/dashboard-foundations.md`, which another architect is writing at the same time and which did not exist when this was written. This spec names the Phase A items it needs by the labels in section 2. When the Phase A spec lands, its contracts win over the "what this view needs" lists here, and any field this spec needs but Phase A leaves out is a blocker that goes back to Phase A.

Evidence labels: **REPO** (a file read for this spec, path given), **INFERENCE** (a design judgement, not tested), **VERIFY** (needs counsel, a provider or the owner).

---

## 0. Scope, non-goals, and what was found in the code

**In scope (Phase B, tier 1).** Read-mostly views over data that existing endpoints already serve:
- Admin: A1 Ledger health, A2 Payouts by state, A3 Reconciliation, A4 Tax/ETA console, A5 Privacy/DPO console, A6 KYC and suspension queue, A7 Home "Attention needed".
- Seller: S1 Order pipeline, S2 Returns by SKU, S3 Ads reports, S4 Forecasts, S5 Sales, traffic and funnel (the nine analytics routes), S6 Finance (most of it is blocked; specified so the blocked state is honest).

**Out of scope.** Time-series trends, sparklines and period-over-period deltas (Phase C, after the Phase A time-series contract). Seller Health Score (no computation exists). War room, cost and carbon, cohorts. New domain events. Any money, legal, VAT or role decision (section 9).

**Code findings that change the plan** (each is REPO and cited again in the view it affects):

| # | Finding | Evidence | Effect |
|---|---|---|---|
| F-1 | Admin `/finance` computes a trial balance in the browser from the first 200 ledger balances and calls `GET /v1/admin/reconciliation/breaks`, which has **no controller**. It does not list payouts at all, only payout approvals. | `apps/admin-web/src/app/(console)/finance/page.tsx`, `api/client.ts:167-168`, VR-AC-03 | A1 replaces the browser trial balance with the Phase A integrity route; A3 repoints to `/v1/admin/finance/reconciliation/*`; A2 adds the payout list. |
| F-2 | `GET /v1/admin/tax/reconciliation` returns `reconciled: true` when ETA could not be queried, because only internal checks run when `etaReport` is null. With ETA Unconfigured in production, the console's "Reconciled" badge would be false assurance. | `packages/domain/src/tax/reconciliation.ts` (`reconcileDay`), `apps/api/src/modules/tax-eta/application/tax.ts:348` (`.catch(() => null)`) | A4 must not show "Reconciled" until the API says the ETA cross-check ran (backend item B-3). |
| F-3 | `GET /v1/admin/finance/reconciliation/summary` returns counts by status, severity and source plus `oldest_item_at`, but **no aging buckets** and no per-rail "input configured" signal. With PSP/COD/BNPL ports Unconfigured, "0 open" would read as "all matched". | `apps/api/src/modules/reconciliation/adapters/recon.controller.ts:99-113`, `kysely-store.ts:371-401` | A3 needs backend item B-2; until then the "no files received" rule applies. |
| F-4 | `GET /v1/seller/me` **exists** in the API (`{user_id, memberships[{store_id, role}]}`), but seller-web hard-wires `role: null` and never calls it. | `apps/api/src/modules/seller-analytics/adapters/seller-me.controller.ts`, `apps/seller-web/src/components/Shell.tsx:8-11` | The seller "me" blocker is a web wiring task, not an API build, but see F-5. |
| F-5 | Role vocabulary mismatch: seller-web `TeamRole` is `owner, manager, fulfilment, catalog, finance`; the policy `BRAND_ROLES` are `owner, manager, catalog, warehouse, finance, support`. | `apps/seller-web/src/view-models/nav.ts:9-27`, `packages/policy/src/types.ts:12` | Role-filtered seller nav cannot be switched on until the mapping is decided (section 9, D-ROLE-3). |
| F-6 | Seller-web calls `GET /v1/seller/store`, `/v1/seller/balance` and `/v1/seller/statements`; none has a controller. The real statement route is `GET /v1/seller/stores/{id}/statements?from&to`. | `apps/seller-web/src/api/client.ts:137,187,189`; `apps/api/src/modules/payouts/adapters/payouts.controller.ts:156` | S5 takes the store id from `/v1/seller/me`; S6 balance stays blocked. |
| F-7 | Seller analytics reads succeed in production and return **zeros**, because only the event source (ingest) is Unconfigured; the read store is Postgres. The honest signal is `meta.freshness.as_of === null` (never ingested). | `apps/api/src/production/ports.ts:163-168`, `packages/domain/src/seller-analytics/freshness.ts:14`, `apps/seller-web/src/view-models/analytics.ts:8` | S5 rule R-NODATA: `as_of === null` renders "No data yet" and **no numbers**. |
| F-8 | KYC queue rows carry only `updated_at`, not the time the seller entered the current state. Suspension reviews carry a server-computed `due_at` (5 business days, Egypt weekend) and `overdue`. | `apps/api/src/modules/admin/adapters/admin.controller.ts:118-135`, `packages/domain/src/admin/kyc-review.ts:129` | A6 labels KYC age as "since last change", never "in state for". |
| F-9 | Admin tax document wire includes `user_id`; the DSAR wire uses a pseudonymous `subject_ref`. | `apps/api/src/modules/tax-eta/adapters/wire.ts:90-115`, `privacy/adapters/wire.ts:63-87` | A4 never renders `user_id`. |
| F-10 | Nav and API disagree on who may read money views: the nav shows `/finance` to `finance` only, while the API's `payout.read` rule (payouts and reconciliation) allows `finance` and `ops`. | `apps/admin-web/src/view-models/nav.ts:28`, `packages/policy/src/rules.ts:107`, `reconciliation/adapters/access.ts` | Kept as is; widening is an owner decision (D-ROLE-2). |

---

## 1. Decisions taken in this spec (option comparisons)

Each decision compares at least two options on complexity, accuracy, cost and scalability. All are **Proposed**.

**D1. Where aggregates are computed.** (a) The web server fans out over list endpoints and counts rows; (b) the API adds small summary fields computed in SQL.
Choice: **(b) for money and legal views, with (a) only as a labelled interim.** Lists are capped at 50-500 rows, so client counts are wrong exactly when volume matters. The SQL side is one `GROUP BY` over tables that are already indexed, and the summary inherits the existing gate and audit. The interim always shows "50+" style caps, never a guessed total.

**D2. How views update.** (a) Server render plus a manual Refresh and an "as of" stamp; (b) SSE live feeds; (c) client polling every N seconds.
Choice: **(a).** Tier 1 data changes on the scale of minutes to hours (nightly integrity, 5-minute recon ticks, weekly payouts). SSE through Next 16 rewrites is unverified (report 6.2), and polling multiplies audited reads, because every read writes an access-audit row. Countdowns tick on the client from the server clock (the existing `slaCountdown` pattern) without refetching.

**D3. Chart rendering in Phase B.** (a) Wait for the Phase A chart-library spike (ECharts or other); (b) render only the five simple forms Phase B needs (horizontal bar, stacked bar, bullet, aging histogram, interval plot) as hand-written SVG primitives in `packages/ui-web`.
Choice: **(b).** These forms are rects and lines with SVG presentation attributes, which pass the nonce CSP without `style=` (REPO `apps/admin-web/src/security/csp.ts`). They need no new dependency or bundle budget, and they do not wait on a spike whose result is unknown. Phase C may swap them for the spike winner behind the same component API.

**D4. Period comparison in seller analytics.** (a) Make a second call for the previous equal window and show deltas; (b) show no deltas until the Phase A series contract exists.
Choice: **(b).** Two adjacent windows on k-anonymised cells widen the differencing surface the seller-analytics spec defends against, and they double the request count. A series endpoint with complementary suppression is the right place for deltas.

**D5. Time.** Every deadline and age is computed against the **server clock** returned with the response (`serverNowMs`, already in both clients), never the device clock. Days are shown in `Africa/Cairo` for money, tax and legal clocks, because the domain already computes them that way (payout cycle, tax day window, business days). Seller analytics windows stay **UTC days** as the API snaps them, captioned "Days are counted in UTC" until the owner decides (D-TIME-1).

---

## 2. Phase A items this spec depends on

Labels are this spec's own; map them to the item names in `dashboard-foundations.md` when it lands.

| Label | Phase A item (report section 8 name) | Needed by | Hard or soft |
|---|---|---|---|
| PA-ME | `GET /v1/admin/me` (VR-AC-01): effective roles, standing roles, assurance, posture | A1-A7 (role filtering, write enablement), A7 entirely | Hard for A7 and for any write control; soft for read-only rendering (the API stays the authority) |
| PA-SME | Seller "me" wired in seller-web (API exists, F-4), store switcher, role mapping (F-5) | S1-S6 | Hard (store id; today's `/v1/seller/store` has no controller) |
| PA-UIWEB | `packages/ui-web`: shared token CSS, Tile, Card, Table, Badge, Skeleton, Dialog, plus the D3 SVG primitives (`BarH`, `StackedBar`, `Bullet`, `AgingBars`, `IntervalPlot`, `Figure` with summary and table toggle) | All | Hard for charts; tables can ship without it |
| PA-SPIKE | Chart spike in production CSP mode | none in Phase B (D3) | Not a blocker |
| PA-INTEGRITY | `GET /v1/admin/ledger/integrity` exposing the stored `IntegrityJob.run()` result | A1, A7 | Hard |
| PA-TS | Time-series contract `{id, window, grain, series[], asOf, basis, suppressed}` with Cairo-day buckets | none in Phase B (D4) | Not a blocker |
| PA-PUB | Event publishers (impression, per-store checkout and purchase, `stock_snapshot`) and an outbox-backed `EventSourcePort` | S5 having **any** data | Soft: S5 ships showing "No data yet" |
| PA-AUDIT | `GET /v1/admin/audit-log` and `/verify` | A1 second chain tile | Soft (tile shows "Not exposed yet") |
| PA-OPENAPI | Resolve the OpenAPI paths with no controller (build or delete) | A1 (balances fallback), A3 (`/reconciliation/breaks`), S6 (`/v1/seller/balance`, `/statements`) | Soft: the views below stop calling the dead paths |
| PA-ATTN | `GET /v1/admin/attention` (counts only, role-filtered) | A7 | Soft: A7 has a fan-out interim, but only once PA-ME exists |
| PA-BUDGET | Per-web performance budgets and recorded visual baselines in CI | Test plan section 8 | Soft |

**What A1 needs from the PA-INTEGRITY contract** (a checklist for the Phase A author; field names are theirs):
1. Overall `ok` and the time the run **finished**, with run kind (nightly or intraday) and the scheduled next run.
2. Trial balance per currency: the sum in piastres as a decimal string, and `ok`.
3. Chain: `ok`, verified length (entries), head hash prefix, and on failure the first failing sequence number. No entry bodies.
4. Store credit: drift count and negative count, plus at most N **pseudonymous** account references (no user ids, no names).
5. A staleness signal, or enough timestamps to compute one, and a "never run" state distinct from "passed".
6. Gate: same as the ledger controller (live `finance` grant plus passkey, access-audit fail-closed with `audit_unavailable`; REPO `apps/api/src/modules/ledger/adapters/ledger.controller.ts:38-66`).

**Contract as amended after the security and privacy review** (`dashboard-foundations.md` track 3 and section 12): each run carries `audit_evidence: present | missing` (missing means the run's audit row is absent, a tamper signal, and the route reports `state: failed`); `store_credit` carries `sample_available` (false once the drift sample passed its retention, safe default 25 months); the drift sample returns internal user ids, not pseudonymous references, so item 4 above is met only by the A1 rule that drift refs are rendered pseudonymously in the browser and revealed through PII reveal.

---

## 3. Backend additions owned by Phase B (small, additive)

These are the only API changes Phase B asks for. Each is additive: no field removed, no behaviour change for existing callers, no new table. The builder implements them with an integration test **and** a negative authorization test per route. If a Phase A metrics contract (`GET /v1/admin/metrics/{id}`) lands first, B-1 and B-2 may be served as metric ids instead; the field semantics below still bind.

### B-1. Payout summary by state
`GET /v1/admin/finance/payouts/summary` · auth: admin audience, `FinanceAccess.require` (the `payout.read` rule: finance, ops; passkey; audited) · not idempotent (read) · rate limit 60/min per user.

```
200 {
  "as_of": "2026-10-16T08:00:00.000Z",
  "next_cycle_at": "2026-10-18T07:00:00.000Z",           // nextCycleRun(now, cycle config), Cairo Sunday 10:00 by default
  "by_state": {
    "SCHEDULED": { "count": 12, "amount": {"amount":"1250000","currency":"EGP"}, "oldest_updated_at": "..." | null },
    "ON_HOLD":   { "count": 3,  "amount": {...}, "oldest_updated_at": "...", "by_hold_reason": { "iban_name_mismatch": 2, "manual_hold": 1 } },
    "APPROVED": {...}, "SENT": {...}, "SETTLED": {...}, "FAILED": { ..., "by_failure_code": { "<code>": n } }, "CANCELLED": {...}
  },
  "settled_window_days": 30                                 // SETTLED and CANCELLED are counted over the last 30 days only
}
```
Rules: every state in `PAYOUT_STATES` is present (zero when none). Amounts are `bigint` sums serialised as strings. `oldest_updated_at` is labelled "last change" because no state-entry timestamp exists (INFERENCE: adding `state_entered_at` is a Phase C migration). Errors: 401, 403 (`forbidden`), 503 `audit_unavailable`.
Tests: sum of `by_state` counts equals the count of a list walk over the same fixture; ON_HOLD reason counts sum to the ON_HOLD count; a seller token gets 401/403; a `support` admin gets 403.

### B-2. Reconciliation summary: aging and rail inputs
Extend `GET /v1/admin/finance/reconciliation/summary` with two fields (existing fields unchanged):
```
"aging": {                                   // live tickets (status <> resolved), age = now - item_at
  "psp_settlement":  { "lt_1d": 0, "d1_3": 0, "gt_3d": 0 },
  "cod_remittance":  {...}, "bnpl_settlement": {...}, "eta_submission": {...},
  "store_credit": {...}, "trial_balance": {...}, "run": {...}
},
"unmatched_over_3d": 0,                      // live tickets of the four rail sources with now - item_at > 3 days (ESCALATE_AFTER_MS)
"rails": [ { "source": "psp_settlement", "last_file_at": "..." | null, "files_received": 0, "input": "configured" | "unconfigured" } ]
```
`input` comes from the provider-readiness registry the composition already reports through `/v1/ready` (REPO `docs/plan/production-boot-gap.md`), so no secret is exposed. Bucket edges: `lt_1d` = age < 24 h, `d1_3` = 24 h to 72 h, `gt_3d` > 72 h, using the same constant as `shouldEscalate` (REPO `packages/domain/src/reconciliation/aging.ts`). Tests: bucket sums equal `open + escalated` per source; the boundary at exactly 72 h falls in `d1_3` (strictly older escalates, matching the domain); same authorization tests as the existing summary.

### B-3. Tax daily reconciliation: say whether ETA was checked, and allow a range
1. Add `authority_checked: boolean` to the `GET /v1/admin/tax/reconciliation` response. It is false when `eta.dayReport` failed or is Unconfigured (today's `.catch(() => null)`). This closes F-2.
2. Optional: `GET /v1/admin/tax/reconciliation?from=YYYY-MM-DD&to=YYYY-MM-DD` (at most 31 Cairo days) returning `{ days: [<same object per day>] }`, so the 7- or 14-day chart is one call instead of seven to fourteen (the route is limited to 30 per minute). Until it exists, A4 makes 7 parallel single-day calls.
Tests: with the ETA port Unconfigured, `authority_checked` is false and the web shows "Internal checks only"; a range over 31 days is 422; `ops` may read and gets 403 on requeue.

### B-4 (optional, seller). Deadline sort for seller orders
`GET /v1/seller/orders?status=PAID&sort=deadline` orders by `accept_by` (PAID) or `dispatch_by` (ACCEPTED, PACKED), ascending. Without it, S1 sorts only the rows it fetched and says so. Tests: cross-tenant 404 on a foreign `store` filter is unchanged; sort is stable on ties by id.

No other backend change is in Phase B. Consent statistics, transfer register, admin order search, seller balance and analytics names are listed as gaps where they block, not built here.

---

## 4. Shared rules for every Phase B view

### 4.1 State vocabulary
Every element (tile, chart, table) renders exactly one state. This extends the seller `ScreenState` (REPO `apps/seller-web/src/view-models/screen-state.ts:5-11`) and the admin `ErrorBlock`/`Empty` (REPO `apps/admin-web/src/components/ui.tsx`).

| State | When | What shows | Never |
|---|---|---|---|
| loading | Streaming render (Suspense boundary per section) | Skeleton with the final shape | Spinner-only blank page |
| ready | Data parsed by Zod | Data with an "as of {time}" stamp | |
| empty | Source is configured and has run, and there is genuinely nothing | Says why and the next action ("No payouts on hold") | A zero chart |
| no_data_yet | Source never produced data (`as_of === null`, never ran, no files received) | "No data yet" plus the reason in one plain sentence | Zeros, empty axes, "0%" |
| not_configured | Provider Unconfigured (`not_configured` client error, `input: unconfigured`, 503 with an `*_disabled` code) | "Not connected yet" plus which provider, in product words | Zeros |
| stale | Data older than its freshness rule | Greyed values, "Last updated {time}", and the rule | Silent old numbers |
| partial | A capped list (`has_more: true`) or a count over the cap | "50+" style count, plus "showing the first N" | A guessed total |
| error | 5xx or contract error | Retry plus request id; the last good value only if cached in the same render | Raw error text, enums |
| offline | Network down | Offline banner; countdowns stop with "paused, reconnecting" | Ticking stale countdowns |
| forbidden | 403/404 from the API | "You do not have access to this" (no detail) | Hints about the resource's existence |
| roles_unknown | PA-ME absent or failing | Admin: read views render, all write controls disabled (the existing posture rule), A7 shows the link list and a notice | Enabled writes |

Rule **R-NODATA** (the honesty rule): a numeric zero may be shown only when the source is configured, has run at least once, and the response is within its freshness rule. Otherwise the state is `no_data_yet`, `not_configured` or `stale`. This holds for every tile, chart and table cell, and it is tested per view.

### 4.2 Chart rulebook (report section 6.1, applied)
- Allowed in Phase B: horizontal bar (ranking), stacked horizontal bar (composition of one total), bullet bar (actual against a target or SLA window), aging histogram (counts per age bucket), interval plot (p10-p50-p90 range with a tick), countdown row (a list, not a chart). Not allowed: pie, donut, 3D, radial gauge, radar, dual axis, truncated bar axis, rainbow palette.
- Every chart sits in a `<figure>` with (1) a generated one-sentence `<figcaption>` summary in the active language (largest, smallest, total or breach count), (2) a visible "View as table" toggle rendering a semantic `<table>` with identical formatting, and (3) direct labels instead of a legend.
- Colour is never the only signal: status uses an icon plus a text label plus colour, and chart series differ in pattern or position as well as colour. Marks need 3:1 contrast against adjacent colours (WCAG 1.4.11). Categorical series are capped at 5; the palette comes from `@outlet/ui-tokens` (Phase A defines the data-viz tokens; INFERENCE: Okabe-Ito order).
- Bars start at zero. Money is right-aligned in tables (inline-end in RTL), uses one formatter over `bigint` piastres, and is never concatenated as text.
- Targets: 24x24 CSS px minimum, with 44 px preferred (product rule 6). Under `prefers-reduced-motion`, nothing animates.
- No inline `style=`: widths and positions use SVG `x`, `y`, `width` and `height` attributes, or classes.

### 4.3 Arabic and RTL
- Layout, legends and table column order mirror. The value axis sits on the inline-start side.
- **Time axis direction** is not used in Phase B, because there are no time series (D4). The aging histogram orders buckets youngest to oldest along the reading direction (right to left in Arabic). Recorded under D-TIME-2.
- Numerals: `Intl.NumberFormat("ar-EG")` for Arabic-Indic digits, or `ar-EG-u-nu-latn` when the user prefers Western digits, using the existing per-app formatter (`lib/format`). Ids, AWB and references are wrapped in `<bdi dir="ltr">`, Latin store and campaign names in `<bdi>`.
- Arabic is authoritative. Every key below exists in `ar` before `en`, and the parity tests fail the build otherwise (REPO admin `i18n/ar.ts` header, seller `i18n.test.ts`).
- Durations ("3 days 4 hours left") use the existing `clockText` and `Countdown` helpers, which already localise.

### 4.4 Security and privacy rules common to all views
- The API is the authority. Hiding a nav item is a convenience; a direct URL renders `forbidden` from the API's 403 or 404 (REPO `view-models/nav.ts:12-16`).
- Admin write controls render only when `posture.sensitiveWritesEnabled` (REPO `view-models/posture.ts:14-21`); otherwise `WritesDisabledNote`. Writes reuse the existing server actions with an `Idempotency-Key`, a reason code where the route takes one, and dual approval where the route requires it. No new write route is added.
- Aggregate views carry no P2/P3. Identifiers shown are pseudonymous refs (`subject_ref`), store names, payout ids (staff), AWB and ETA UUIDs. Revealing personal data always goes through `POST /v1/admin/pii-views` with an `ADMIN_REASON_CODES` value (REPO `packages/domain/src/admin/roles.ts:19-29`), never inline.
- Every gated read already writes an access-audit row. Views must not fan out to endpoints the viewer's roles cannot read, because that fills the audit log with denials and looks like probing (rule for A7).
- No analytics SDK loads in either web app. Phase B adds no client events and no new domain events, so each view's **Events** block says "none", and the audit records are the trail.

---

## 5. Admin views

### A1. Ledger health (`/finance/ledger`, Money group)

**Flow.** Finance opens Money, then Ledger health. Four status tiles show trial balance, hash chain, store-credit drift, and freshness of the last run. A failing tile links to the evidence list (currencies out of balance, first bad chain sequence, drift refs). The "Account balances" table moves here as a secondary, clearly partial list.

**Wireframe** (LTR shown; RTL mirrors):
```
Ledger health                                         As of 16 Oct 08:00 (server)  [Refresh]
+---------------------+---------------------+---------------------+---------------------+
| [check] Trial bal.  | [check] Hash chain  | [!] Store credit    | [clock] Last run    |
| Balanced to zero    | Verified, 48,210    | 2 accounts drift    | Nightly, 02:31      |
| EGP 0.00            | entries, head 9f3a… | 0 negative          | Next: 17 Oct 02:30  |
+---------------------+---------------------+---------------------+---------------------+
Findings (only when a tile fails)
  Table: currency | sum (piastres) | status        or   chain: first failing seq, verified up to
  Table: drift ref (pseudonymous) | ledger | projection | delta        [Reveal requires reason]
Account balances (partial: first 200)  -- existing table, labelled "not a proof of balance"
Audit-log chain (PA-AUDIT)  -- "Not exposed yet" until /v1/admin/audit-log/verify exists
```

| Element | Form | Why |
|---|---|---|
| Four tiles | Binary status tile: icon, text, value, last-run time | A flat line at zero is wasted space; the question is "pass or fail, and how fresh" (admin catalogue I1-I3) |
| Findings | Table | Exact figures belong in tables; there is no chart for a list of offenders |
| Balances | Table, right-aligned money | Kept from today, demoted and labelled |

**Rules.**
- The tile state comes only from PA-INTEGRITY. The browser no longer computes a trial balance (F-1); `view-models/finance.ts trialBalance()` is removed from this page.
- Freshness: **stale** when the last finished run is more than 26 h old with no intraday run since (nightly at 02:30 Cairo plus 2 h grace; INFERENCE, Proposed). **Never run** is `no_data_yet`, never "passed".
- Any failing tile puts a severity-1 row into A7 for finance.
- `audit_evidence: missing` on the latest run renders every tile as failed with the text "Integrity evidence missing: contact Security" (never "Balanced"); `sample_available: false` renders the findings table as "Sample no longer kept (retention)", not as "no drift".
- Drift refs stay pseudonymous. Revealing the user behind one goes through PII reveal with `finance_reconciliation` and is audited.

**Edge cases.** A run in progress shows the previous result with "check running" (if the contract exposes it). A multi-currency future works because the tile lists every currency (EGP only today). A chain failure with a huge offset shows the first failing sequence only. A 503 `audit_unavailable` is an error state with retry, never a silent pass. A super_admin with a standing grant only gets 403, because the ledger gate opens nothing to standing super_admin (REPO ledger controller comment), and the page says so.

**Data.** No new tables. Reads PA-INTEGRITY plus `GET /v1/admin/ledger/balances` (`items[]` from `balanceWire`, filters `owner_type`, `owner_id`, `type`, `limit` up to 200). PII class: P1, with drift refs pseudonymous.

**API.**
| Call | Exists | Auth | Fields used |
|---|---|---|---|
| `GET /v1/admin/ledger/integrity` | **No (PA-INTEGRITY)** | finance + passkey, audited | per section 2 checklist |
| `GET /v1/admin/ledger/balances?limit=200` | Yes (`ledger.controller.ts:68-83`) | finance + passkey, audited, 60/min | `items[]` |
| `GET /v1/admin/audit-log/verify` | **No (PA-AUDIT; OpenAPI `/v1/admin/audit-log` has no controller)** | | |

**Events.** None (section 4.4).

**Failure handling.** One retry on a 5xx in the server render, then the error state with request id. A tile never falls back to the browser computation.

**Security and abuse.** API3 (no excessive data): no entry bodies, no user ids. API1 (BOLA): no object ids in the tiles. The page is read-only, so there are no writes to abuse.

**Metrics.** KPI: time from a failing integrity run to a finance acknowledgement (target: same business day; INFERENCE). SLI: page server render p95 < 1.5 s. Guardrail: zero renders of "Balanced" when the contract says not ok or never run (tested).

**Acceptance.**
```gherkin
Scenario: integrity never ran
  Given the integrity route reports no completed run
  When a finance admin opens Ledger health
  Then every tile shows "No data yet" and no tile shows "Balanced"

Scenario: trial balance fails
  Given the last run reports EGP sum "-150"
  Then the trial-balance tile shows a fail icon, the text "Does not balance" and "EGP -1.50"
  And the Home attention queue for finance shows a severity-1 row linking here

Scenario: stale result
  Given the last finished run is 30 hours old
  Then the tiles are greyed and show "Last checked 30 hours ago"

Scenario: integrity evidence missing
  Given the latest completed run reports audit_evidence "missing"
  When a finance admin opens Ledger health
  Then every tile shows a fail icon and "Integrity evidence missing" and no tile shows "Balanced"

Scenario: wrong role
  Given an admin with only the ops role
  When they open /finance/ledger directly
  Then the API returns 403 and the page shows the forbidden state
```

**Role visibility.** finance (read). security: no access by default (D-ROLE-1). super_admin: break-glass elevation only.

**Blockers.** PA-INTEGRITY (hard), PA-ME (role-aware nav and A7), PA-UIWEB (tiles; a table fallback is acceptable), PA-AUDIT (soft, one tile).

**Copy keys (AR first).**
| Key | AR | EN |
|---|---|---|
| `ledgerHealth.title` | سلامة دفتر الأستاذ | Ledger health |
| `ledgerHealth.intro` | نتيجة آخر فحص لميزان المراجعة وسلسلة القيود وأرصدة الرصيد الشرائي. | Result of the last check of the trial balance, the entry chain and store-credit balances. |
| `ledgerHealth.trial.ok` | الميزان متوازن عند الصفر | Balanced to zero |
| `ledgerHealth.trial.fail` | الميزان غير متوازن | Does not balance |
| `ledgerHealth.chain.ok` | السلسلة سليمة حتى القيد {{n}} | Chain verified up to entry {{n}} |
| `ledgerHealth.chain.fail` | انقطاع في السلسلة عند القيد {{seq}} | Chain broken at entry {{seq}} |
| `ledgerHealth.credit.ok` | لا فروق في الرصيد الشرائي | No store-credit drift |
| `ledgerHealth.credit.drift` | {{n}} حسابات بها فرق، {{neg}} برصيد سالب | {{n}} accounts drift, {{neg}} negative |
| `ledgerHealth.run.last` | آخر فحص: {{kind}}، {{time}} | Last check: {{kind}}, {{time}} |
| `ledgerHealth.run.next` | الفحص التالي: {{time}} | Next check: {{time}} |
| `ledgerHealth.run.never` | لم يُجرَ أي فحص بعد | No check has run yet |
| `ledgerHealth.run.stale` | آخر فحص منذ {{hours}} ساعة | Last checked {{hours}} hours ago |
| `ledgerHealth.balances.partial` | أول {{n}} حساب فقط. هذه القائمة ليست دليلاً على التوازن. | First {{n}} accounts only. This list is not a proof of balance. |
| `ledgerHealth.auditChain.notExposed` | التحقق من سجل التدقيق غير متاح بعد | Audit-log verification is not available yet |

---

### A2. Payouts by state, eligibility and holds (`/finance/payouts`)

**Flow.** Finance (or ops, read-only, per the API) opens Payouts. A stacked state bar shows counts and amounts per state. The ON_HOLD and FAILED lists show reasons. A rules panel explains eligibility. Approve, hold and cancel stay on the payout row, with the existing approval and posture rules.

**Wireframe.**
```
Payouts                                  Next weekly cycle: Sun 18 Oct 10:00 Cairo   As of …  [Refresh]
State (count and amount, last 30 days for Settled/Cancelled)
 [Scheduled 12 | On hold 3 | Approved 1 | Sent 2 | Failed 1 ]   stacked horizontal bar, labelled segments
 Table view toggle: state | count | amount | last change (oldest)
On hold (3)                                                    Failed (1)
 store | cycle | amount | reason (text) | last change            store | cycle | amount | failure code | attempts
 [Approve*] [Cancel*]  (*disabled unless posture ok; approval id required above threshold)
How eligibility works (static, from domain constants)
 - A line is payable once its order is closed (return window ended) plus 3 days, with no open dispute.
 - Minimum payout EGP 100.00; below that the amount carries forward.
 - Refunds after a payout are netted from the next payout.
```

| Element | Form | Why |
|---|---|---|
| State distribution | One stacked horizontal bar plus a table | Part-to-whole of one total; at most 7 segments, labelled directly |
| Hold reasons | Sorted horizontal bar (when B-1 exists) plus list | Ranking of causes |
| ON_HOLD and FAILED rows | Tables, oldest first | Actionable queue that empties as you act |
| Eligibility | Text panel | Rules, not data |

**Rules.**
- States and reasons are the domain enums `PAYOUT_STATES` and `HOLD_REASONS` (REPO `packages/domain/src/state-machine/machines/payout.ts`, `payouts/lifecycle.ts:5-13`), rendered as localised labels, never raw enums (UX rule 2).
- Eligibility text uses `PAYOUT_HOLD_AFTER_CLOSE_MS` (3 days) and `DEFAULT_MINIMUM_PAYOUT_MINOR` (10,000 piastres) (REPO `payouts/eligibility.ts:5-7`). It is generated from those constants so it cannot drift.
- The next cycle comes from B-1 `next_cycle_at`. Interim: `nextCycleRun(serverNow, DEFAULT_CYCLE_CONFIG)` from `@outlet/domain`, labelled "default schedule".
- Amounts are shown only for complete sets. In the interim (no B-1), per-state counts come from `GET …/payouts?status=X&limit=50`. When `has_more` is true the count shows "50+" and the amount cell says "Not totalled: more than 50".
- Hold reasons are **staff only**. The seller view is S6 and is governed by D-PAYOUT-1.
- Actions: approve, hold and cancel call the existing routes with an `Idempotency-Key`. A `dual_approval_required` 403 shows "Another approver must approve this amount first" with a link to Approvals. `hold_not_cleared` and `open_dispute` 409s show their reason in words.

**Edge cases.** A payout that changes state between render and click gets a 409 `payout_conflict`: "This payout changed; reload". A seller's IBAN shows last 4 only. Zero payouts in every state while the payout rail is Unconfigured means **not_configured** ("Payout bank rail not connected yet"), because the weekly cycle still schedules payouts but nothing can be SENT. The rail status comes from B-1 or `/v1/ready`; until then the page shows a standing notice. CANCELLED is shown in the table only, not the bar (it is not exposure).

**Data.** Reads `adminPayoutWire` fields: `id, store_id, cycle_key, status, amount, eligible_total, netted_total, carry_forward, line_count, iban_last4, sent_at, settled_at, created_at, cutoff_at, hold_reason, approval_id, approved_by, approved_at, attempts, failure_code, ledger_ref, provider_ref, version, updated_at, lines[]` (REPO `payouts/adapters/wire.ts`). Store names need a store lookup (none for admin; the table shows a store short id in `<bdi>` until an admin seller list exists, PA-OPENAPI `/v1/admin/sellers`). PII: P1, with IBAN masked.

**API.**
| Call | Exists | Auth | Notes |
|---|---|---|---|
| `GET /v1/admin/finance/payouts?status=&cycle_key=&store_id=&cursor=&limit≤50` | Yes (`payouts.controller.ts:203-220`) | `payout.read` (finance, ops), audited, 120/min | `items[]`, `page{next_cursor,has_more}` |
| `GET /v1/admin/finance/payouts/{id}` | Yes (`:222-229`) | same | detail with `lines[]` |
| `POST …/{id}/approve`, `/hold`, `/cancel` | Yes (`:231-263`) | finance role in the use case; Idempotency-Key required; 30/min | dual approval via approval records (ADR-0021) |
| `GET /v1/admin/finance/payouts/summary` | **No (B-1)** | | |
| `GET /v1/admin/approvals?kind=payout` | Yes (`admin.controller.ts:206`) | any admin | waiting approvals |

**Events.** None new. The commands already emit their own outbox and audit records.

**Failure handling.** List failure: error state per section, so the rules panel still renders. Command failure: problem code mapped to copy; never retried automatically (money).

**Security and abuse.** BFLA: write buttons are hidden for ops and also enforced by `requireFinance` (403 `finance_role_required`). Self-approval is blocked by the approvals model. Idempotency keys stop double clicks. API3: `ledger_ref` and `provider_ref` are shown to finance only, in the detail view.

**Metrics.** KPI: payouts SENT on cycle day versus scheduled. Guardrail: FAILED count > 0 raises an A7 row; ON_HOLD older than 7 days raises an A7 row (INFERENCE threshold, Proposed). SLI: render p95 < 1.5 s.

**Acceptance.**
```gherkin
Scenario: interim count is capped honestly
  Given 75 SCHEDULED payouts and no summary endpoint
  Then the Scheduled segment label reads "50+" and its amount reads "Not totalled: more than 50"

Scenario: hold reason in words
  Given a payout ON_HOLD with hold_reason "iban_name_mismatch"
  Then the row shows "Bank account name does not match the seller's legal name" and no raw code

Scenario: ops can read but not act
  Given an ops admin
  Then the payout tables render and Approve, Hold and Cancel are not shown
  And a direct POST to /approve returns 403 finance_role_required

Scenario: rail not connected
  Given the payout rail provider is Unconfigured
  Then the page shows "Payout bank rail not connected yet" above the state bar
```

**Role visibility.** finance (read and act); ops (read, per the API; the nav entry stays finance-only until D-ROLE-2); everyone else 403.

**Blockers.** B-1 (soft; interim exists), PA-ME (hiding actions per role; posture), PA-UIWEB (bar), PA-OPENAPI `/v1/admin/sellers` (store names; soft).

**Copy keys.**
| Key | AR | EN |
|---|---|---|
| `payoutsBoard.title` | المدفوعات للبائعين | Seller payouts |
| `payoutsBoard.nextCycle` | الدورة الأسبوعية التالية: {{time}} بتوقيت القاهرة | Next weekly cycle: {{time}} Cairo time |
| `payoutsBoard.state.SCHEDULED` | مجدولة | Scheduled |
| `payoutsBoard.state.ON_HOLD` | معلّقة | On hold |
| `payoutsBoard.state.APPROVED` | معتمدة | Approved |
| `payoutsBoard.state.SENT` | مُرسلة | Sent |
| `payoutsBoard.state.SETTLED` | مُسوّاة | Settled |
| `payoutsBoard.state.FAILED` | فشلت | Failed |
| `payoutsBoard.state.CANCELLED` | ملغاة | Cancelled |
| `payoutsBoard.hold.no_bank_details` | لا توجد بيانات حساب بنكي | No bank details |
| `payoutsBoard.hold.iban_name_mismatch` | اسم الحساب البنكي لا يطابق الاسم القانوني للبائع | Bank account name does not match the seller's legal name |
| `payoutsBoard.hold.name_check_unavailable` | تعذّر التحقق من اسم الحساب | Name check unavailable |
| `payoutsBoard.hold.risk_review` | قيد مراجعة المخاطر | Under risk review |
| `payoutsBoard.hold.exceeds_ledger_balance` | المبلغ يتجاوز الرصيد في الدفتر | Amount exceeds the ledger balance |
| `payoutsBoard.hold.open_dispute` | يوجد نزاع مفتوح | An open dispute |
| `payoutsBoard.hold.manual_hold` | تعليق يدوي | Manual hold |
| `payoutsBoard.notTotalled` | لم يُحسب الإجمالي: أكثر من {{n}} | Not totalled: more than {{n}} |
| `payoutsBoard.lastChange` | آخر تغيير | Last change |
| `payoutsBoard.railNotConnected` | لم يُربط مسار التحويل البنكي بعد. لا يمكن إرسال أي دفعة. | Payout bank rail not connected yet. No payout can be sent. |
| `payoutsBoard.rules.title` | كيف تصبح الدفعة مستحقة | How a payout becomes due |
| `payoutsBoard.rules.closed` | يصبح البند مستحقاً بعد إغلاق الطلب وانتهاء مهلة الإرجاع بثلاثة أيام، ودون نزاع مفتوح. | A line is due 3 days after its order closes (return window ended), with no open dispute. |
| `payoutsBoard.rules.minimum` | الحد الأدنى للدفعة {{amount}}، وما يقل عنه يُرحَّل للدورة التالية. | Minimum payout {{amount}}; anything below carries forward. |
| `payoutsBoard.rules.netting` | المبالغ المستردة بعد الدفع تُخصم من الدفعة التالية. | Refunds after a payout are deducted from the next payout. |

---

### A3. Reconciliation: PSP, COD, BNPL, ETA (`/finance/reconciliation`)

**Flow.** Finance or ops opens Reconciliation. The top shows the zero-tolerance tile "Unmatched older than 3 days", the last-run line and the rejected-files count. Below sit one aging histogram per rail and the ticket table (filter by rail, severity, status), with a link to ticket detail.

**Wireframe.**
```
Reconciliation                          Last run: 16 Oct 08:05 (5-min tick), ok   As of …  [Refresh]
+-------------------------------+  +----------------+  +----------------+  +----------------+
| [!] Unmatched > 3 days: 0     |  | Open 4         |  | Escalated 1    |  | Rejected files |
| target 0 (spec T4/T8)         |  | crit 0 high 2  |  |                |  | 0              |
+-------------------------------+  +----------------+  +----------------+  +----------------+
Aging by rail (live tickets)            <1 day   1-3 days   >3 days
 PSP settlement      [Not connected: no settlement files received]
 COD remittance      [Not connected: no settlement files received]
 BNPL settlement     [Not connected: no settlement files received]
 ETA submissions     ##        #          (bars; >3d bucket outlined and labelled)
 Store credit / trial balance (ledger checks)  ...
Tickets  [rail v] [severity v] [status v]
 rail | kind (words) | severity | ref <bdi> | delta | item date | age | status
```

| Element | Form | Why |
|---|---|---|
| Zero-tolerance tile | Status tile with target text "0" | The SLO is binary at 0 (T8 "unmatched PSP lines older than 3 days = 0") |
| Aging per rail | Aging histogram (3 buckets, small multiples, shared scale) | Distribution by age; small multiples avoid a stacked bar's misread middle segments |
| Severity counts | Tile with three labelled numbers | Few values; no chart |
| Tickets | Table, oldest item first | Action list |

**Rules.**
- Rails: `psp_settlement`, `cod_remittance`, `bnpl_settlement`, `eta_submission`. Ledger checks (`store_credit`, `trial_balance`, `run`) are shown below, separated, because they are not external rails (REPO `packages/domain/src/reconciliation/types.ts:1-9`).
- "Unmatched older than 3 days" = B-2 `unmatched_over_3d`. Interim: walk `GET …/tickets?status=open` and `?status=escalated` (100 per page, at most 3 pages each) and count tickets of the four rails with `now - item_at > 72 h`. If any walk has `has_more`, the tile is **partial** ("at least N").
- **No-files rule (F-3):** a rail with no settlement file ever received (B-2 `rails[].files_received === 0`, or interim: no row of that kind in `GET …/files?limit=100`) shows `not_configured` "No settlement files received yet. Zero open items does not mean matched." Its histogram is not drawn.
- Finding kinds render as words (17 kinds in `FINDING_KINDS`). `ref` is a provider key, currency or file id, never personal data (domain comment), shown in `<bdi>`.
- `escalated` means "critical, or older than 3 days" (REPO `shouldEscalate`); the tile's helper text says so, so escalated is not misread as "over 3 days".

**Edge cases.** `last_run` null: no_data_yet. `last_run.ok` false: error tile "Last run failed" plus an A7 row. A ticket resolved between list and detail: the detail shows it resolved. A 404 on detail shows the forbidden/not-found state. The ETA rail duplicates A4: A3 shows its tickets, A4 shows document states, and each links to the other.

**Data.** Reads `summary {open, escalated, by_severity, by_source, oldest_item_at, rejected_files, last_run}`, tickets (`ticketWire`: `id, source, kind, severity, status, ref, detail, amount_delta, item_at, first_seen_at, last_seen_at, escalated_at, resolved_at, last_run_id`), runs and files (REPO `recon.controller.ts:30-71`). PII: P1.

**API.**
| Call | Exists | Auth | Notes |
|---|---|---|---|
| `GET /v1/admin/finance/reconciliation/summary` | Yes (`recon.controller.ts:99`) | `ReconAccess` = `payout.read` (finance, ops), audited, 60/min | B-2 adds `aging`, `unmatched_over_3d`, `rails` |
| `GET …/reconciliation/tickets?status&source&severity&cursor&limit≤100` | Yes (`:116`) | same, 120/min | |
| `GET …/reconciliation/tickets/{id}` | Yes (`:134`) | same | |
| `GET …/reconciliation/runs?limit≤100`, `…/files?limit≤100` | Yes (`:144,:152`) | same, 60/min | |
| `GET /v1/admin/reconciliation/breaks` | OpenAPI only, **no controller** | | admin-web stops calling it (F-1, VR-AC-03) |

**Events.** None.

**Failure handling.** If the summary fails, the tickets still render, and the reverse. Each section has its own error state.

**Security and abuse.** Read-only. `detail` is machine codes only (domain contract), and is not rendered as HTML. Rate limits: one render makes at most 1 summary call plus 1 files call, plus at most 6 ticket pages in the interim.

**Metrics.** SLO (T8): unmatched PSP lines older than 3 days = 0. KPI: median ticket age at resolution. Guardrail: zero "0 open" renders for a rail with no files (tested).

**Acceptance.**
```gherkin
Scenario: rails not connected
  Given no PSP, COD or BNPL settlement file has ever been received
  When finance opens Reconciliation
  Then those three rails show "No settlement files received yet" and no histogram
  And the zero-tolerance tile shows "0" only with the note "covers connected rails: ETA"

Scenario: ageing boundary
  Given an ETA ticket whose item_at is exactly 72 hours before server now
  Then it is in the 1-3 days bucket and not counted in "Unmatched older than 3 days"
  Given another ticket 72 hours and 1 second old
  Then it is counted

Scenario: escalated is not the same as old
  Given a critical trial_balance ticket opened 10 minutes ago
  Then it counts as Escalated and appears in the ledger-checks row, not in "older than 3 days"
```

**Role visibility.** finance, ops (read). Nav stays finance-only (D-ROLE-2).

**Blockers.** B-2 (soft; interim walk), PA-ME, PA-UIWEB (histograms; a table fallback is acceptable). Real data needs the provider contracts (VR-RC-01, VR-INT-05).

**Copy keys.**
| Key | AR | EN |
|---|---|---|
| `recon.title` | المطابقة المالية | Reconciliation |
| `recon.overdue.title` | غير مطابق منذ أكثر من 3 أيام | Unmatched older than 3 days |
| `recon.overdue.target` | المستهدف: صفر | Target: zero |
| `recon.overdue.partial` | على الأقل {{n}} | At least {{n}} |
| `recon.overdue.covers` | يشمل المسارات المتصلة فقط: {{rails}} | Covers connected rails only: {{rails}} |
| `recon.escalated.help` | المُصعَّد يعني خطورة حرجة أو عمراً يتجاوز 3 أيام. | Escalated means critical severity or older than 3 days. |
| `recon.rail.psp_settlement` | تسويات مزوّد الدفع | Payment provider settlements |
| `recon.rail.cod_remittance` | تحويلات الدفع عند الاستلام | Cash-on-delivery remittances |
| `recon.rail.bnpl_settlement` | تسويات التقسيط | Instalment provider settlements |
| `recon.rail.eta_submission` | إرسالات مصلحة الضرائب | Tax authority submissions |
| `recon.rail.noFiles` | لم يصل أي ملف تسوية بعد. عدم وجود بنود مفتوحة لا يعني أنها مطابقة. | No settlement files received yet. Zero open items does not mean matched. |
| `recon.bucket.lt1d` | أقل من يوم | Under 1 day |
| `recon.bucket.d1_3` | من يوم إلى 3 أيام | 1 to 3 days |
| `recon.bucket.gt3d` | أكثر من 3 أيام | Over 3 days |
| `recon.lastRun` | آخر تشغيل: {{time}}، {{result}} | Last run: {{time}}, {{result}} |
| `recon.lastRun.failed` | فشل آخر تشغيل | The last run failed |
| `recon.kind.<FINDING_KIND>` | (17 keys, one per `FINDING_KINDS` value) | (17 keys) |

---

### A4. Tax and ETA console (`/tax`)

**Flow.** Finance, ops or super_admin opens Tax. A 7-day stacked bar shows documents per Cairo day by submission state. Today's tiles show submitted, accepted, rejected and the acceptance rate. Below are a reject-reasons bar, a dead-letter list with Requeue (finance and super_admin, posture ok), and the per-day discrepancy table.

**Wireframe.**
```
Tax and ETA                     [Internal checks only: the tax authority was not queried]   As of …
Last 7 days (Cairo days)        Queued | Submitted | Retry | Accepted | Rejected | Dead letter
 10 Oct  ####=====..
 …       (stacked horizontal bars, one per day, labelled; table toggle)
Today: Left the queue 14 | Accepted 11 | Rejected 1 | Acceptance 91.66% (11 of 12 decided)
Reject reasons (from rejected documents, this page of 50)     sorted horizontal bar
Dead letters (needs action)   kind | issued | attempts | last error (words) | [Requeue*]
Discrepancies (selected day)  internal id <bdi> | kind (words)
```

| Element | Form | Why |
|---|---|---|
| Per-day states | Stacked horizontal bar per day (7 rows) | Composition per day with comparable totals; horizontal keeps Arabic day labels readable; no time axis is needed (D-TIME-2) |
| Today tiles | Tiles; the rate shown with its n | Small-sample honesty: "11 of 12" |
| Reject reasons | Sorted horizontal bar | Ranking |
| Dead letters, discrepancies | Tables | Action lists |

**Rules.**
- States are `SUBMISSION_STATES` (`QUEUED, SUBMITTED, ACCEPTED, REJECTED, RETRY, DEAD_LETTER`) and kinds are `DOCUMENT_KINDS` (`seller_einvoice, shopper_ereceipt, seller_goods_ereceipt`) (REPO `packages/domain/src/tax/submission.ts:4`, `documents.ts:12`).
- `submitted` in the API means "everything except QUEUED", so it includes RETRY and DEAD_LETTER. The label is therefore "Left the queue", not "Accepted by ETA".
- `acceptance_rate_bps` null: "No decisions yet". Shown as a percentage with 2 decimals from integer bps, always with "{accepted} of {decided}".
- **Reconciled badge rule (F-2):** "Reconciled" shows only when `reconciled === true` **and** `authority_checked === true` (B-3). Otherwise: "Internal checks only: the tax authority was not queried". Until B-3 lands the badge never shows, and the banner is permanent.
- Money: `gross_by_state` is shown in the table view only, labelled "Gross as issued (incl. VAT)". No VAT total, VAT rate or VAT-base figure is derived on this page (D-VAT-1).
- Requeue: `POST /v1/admin/tax/submissions/{documentId}/requeue` with an `Idempotency-Key`. 409 `invalid_transition` → "Only dead letters can be requeued"; 409 `submission_conflict` → "Changed; reload".
- `user_id` from the document wire is never rendered (F-9). The recipient shows kind, plus `legal_name_ar` for business recipients only.

**Edge cases.** A DST day (23 or 25 h) is handled by the server's `cairoDayWindow`. A day with zero documents is shown as a labelled empty row "No documents", not a zero-length bar. When ETA is Unconfigured, documents will sit in QUEUED or RETRY and then DEAD_LETTER; the page shows `not_configured` "Tax authority connection not set up" above the chart, and dead letters are expected, so Requeue is disabled with that reason. 429 from the 30/min limit: the chart shows the days that loaded and marks the rest "not loaded" (partial).

**Data.** `taxReconciliation {date, documents, counts, gross_by_state, submitted, accepted, rejected, acceptance_rate_bps, discrepancies[{internal_id, kind}], reconciled}`; documents list (`adminDocumentWire` with `submission{state, attempts, max_attempts, next_attempt_at, last_submitted_at, last_error, eta_uuid, signed_document_ref, rejection_reasons, decided_at}`) (REPO `tax-eta/adapters/wire.ts:90-130`). PII: P1; `user_id` (P1 pseudonymous id) is suppressed in the UI.

**API.**
| Call | Exists | Auth | Notes |
|---|---|---|---|
| `GET /v1/admin/tax/reconciliation?date=YYYY-MM-DD` | Yes (`tax-eta.controller.ts:238`) | finance, ops, super_admin + passkey, audited, **30/min** | 7 calls per render; B-3 adds `authority_checked` and range |
| `GET /v1/admin/tax/documents?state=&kind=&cursor=&limit≤50` | Yes (`:211`) | same, 60/min | `state=REJECTED` for reasons, `DEAD_LETTER` for the action list |
| `GET /v1/admin/tax/documents/{documentId}` | Yes (`:228`) | same | |
| `POST /v1/admin/tax/submissions/{documentId}/requeue` | Yes (`:251`) | finance, super_admin; Idempotency-Key; 20/min | |
| `GET /v1/admin/tax/invoices` | OpenAPI only, **no controller** | | not used |

**Events.** None new.

**Failure handling.** Per-day call failures mark only that day "not loaded". A requeue failure is never retried automatically.

**Security and abuse.** BFLA: Requeue hidden for ops and enforced by the API (WRITERS). The 30/min limit caps the chart; B-3's range form removes the pressure.

**Metrics.** KPI: acceptance rate (bps) by day. Guardrails: reject rate > 1% or queue age > 24 h raises an A7 row (admin catalogue J1; INFERENCE thresholds, Proposed). SLI: render p95 < 2 s (7 calls).

**Acceptance.**
```gherkin
Scenario: no false assurance
  Given the ETA adapter is Unconfigured and today's report has reconciled true
  When finance opens Tax
  Then the page shows "Internal checks only: the tax authority was not queried"
  And the word "Reconciled" does not appear

Scenario: rate with its sample
  Given 11 accepted and 1 rejected documents today
  Then the tile reads "91.66%" and "11 of 12 decided"

Scenario: ops cannot requeue
  Given an ops admin and a DEAD_LETTER document
  Then no Requeue button is rendered, and a direct POST returns 403
```

**Role visibility.** finance, ops, super_admin (read); finance, super_admin (requeue).

**Blockers.** B-3 (the "Reconciled" badge stays off until then), PA-ME, PA-UIWEB. Real data needs VR-06 and the ETA contract.

**Copy keys.**
| Key | AR | EN |
|---|---|---|
| `taxConsole.title` | الضرائب ومنظومة الفاتورة الإلكترونية | Tax and ETA |
| `taxConsole.internalOnly` | فحوص داخلية فقط: لم يُستعلم من مصلحة الضرائب | Internal checks only: the tax authority was not queried |
| `taxConsole.notConfigured` | لم يُضبط الاتصال بمصلحة الضرائب بعد | Tax authority connection not set up |
| `taxConsole.reconciled` | تمت المطابقة مع مصلحة الضرائب | Reconciled with the tax authority |
| `taxConsole.leftQueue` | خرجت من قائمة الانتظار | Left the queue |
| `taxConsole.rate` | {{rate}} ({{accepted}} من {{decided}} تم البت فيها) | {{rate}} ({{accepted}} of {{decided}} decided) |
| `taxConsole.noDecisions` | لا قرارات بعد | No decisions yet |
| `taxConsole.state.<STATE>` | (6 keys) قيد الانتظار، مُرسلة، مقبولة، مرفوضة، إعادة محاولة، متوقفة | (6 keys) Queued, Submitted, Accepted, Rejected, Retrying, Dead letter |
| `taxConsole.kind.<KIND>` | فاتورة إلكترونية للبائع، إيصال إلكتروني للمشتري، إيصال بضائع البائع | Seller e-invoice, Shopper e-receipt, Seller goods e-receipt |
| `taxConsole.gross` | الإجمالي كما صدر (شامل الضريبة) | Gross as issued (incl. VAT) |
| `taxConsole.dayNotLoaded` | لم يُحمَّل هذا اليوم | This day did not load |
| `taxConsole.requeue.onlyDead` | لا يمكن إعادة الإرسال إلا للمستندات المتوقفة | Only dead letters can be requeued |
| `taxConsole.requeue.disabledNotConfigured` | إعادة الإرسال معطلة حتى يُضبط الاتصال | Requeue is off until the connection is set up |

---

### A5. Privacy and DPO console (`/privacy`)

**Flow.** The DPO opens Privacy. The top shows open breaches as countdown rows, which are the most urgent legal clocks. Next come the DSAR summary tiles and the aging bars against the 30-day SLA, then the DSAR queue table, and a "Consent statistics: not measured yet" panel.

**Wireframe.**
```
Privacy (DPO)                                                     As of … (server)  [Refresh]
Breach register (open first)                                                  [Record breach]
 [!] High · 1,240 affected · detected 15 Oct 09:00
     Triage (4 h)          Met                    [check]
     PDPC notice (72 h)    1 day 22 h left        [clock]  ======-----  (bullet: time used of 72 h)
     Subject notice (3 d)  waiting for PDPC notice
     Next step: [Record PDPC notified]
DSAR requests     Open 6 | Overdue 0 | Due within 24 h 1 | Export 4 · Deletion 2
 Age vs 30-day deadline (deadline VERIFY)   0-10 d ###  11-20 d ##  21-30 d #  >30 d (none)
 Queue: type | subject ref <bdi> | received | due | time left | export ready target | status (+ blockers in words)
Consent statistics      Not measured yet: no aggregate endpoint
```

| Element | Form | Why |
|---|---|---|
| Breach clocks | Countdown rows, each with a bullet bar of time used against the clock length, plus icon and text | Deadlines, not trends; a bullet replaces any gauge (rulebook) |
| DSAR summary | Tiles (exact server counts) | |
| DSAR aging | Aging histogram, 4 buckets, the SLA marked as a reference line at 30 days | Distribution against a deadline |
| Queue | Table, soonest due first | Action list |

**Rules.**
- Clocks come from the server: each breach carries `clocks.{triage,pdpc,subjects}` with `status ∈ pending|overdue|met|met_late|not_required`, `due_at` and `ms_remaining` (REPO `privacy/adapters/wire.ts:89-110`). The client only ticks `ms_remaining` down from the fetch time, using the monotonic timer pattern. Durations are triage 4 h, PDPC 72 h and subjects 3 days (REPO `packages/domain/src/privacy/breach.ts:12-14`). The subject clock base is conservative and already marked VERIFY in code (new row VR-DB-01).
- Severity colouring of a pending clock (INFERENCE, Proposed D-THRESH-1): neutral above 24 h left, amber at 24 h or less, red at 12 h or less, red with an "Overdue" label below 0. It is always paired with the text "x h left" and an icon.
- `not_required` (the DPO decided no notification): shown as "Not required (DPO decision)" with the decision time, never hidden.
- DSAR: the deadline is `DSAR_SLA_DAYS = 30` (REPO `dsar-queue.ts:8`, VERIFY VR-01). The aging chart's reference line is captioned "30-day working deadline; statutory deadline to be confirmed". The export-ready target is 72 h (`EXPORT_READY_TARGET_MS`), and `ready_target_missed` shows as its own badge.
- Blockers on deletion requests (`open_orders, open_returns, open_disputes`) render in words.
- The queue limit is 200 today (client). The API returns `next_cursor: null` with no paging, so when `items.length === limit` the table is **partial** and says so. The summary counts are exact.
- Consent statistics: no endpoint exists (repo audit). The panel is `not_configured` "Not measured yet", never a guess. Building it needs a DPO decision on aggregation (k>=50) and is not Phase B.
- The breach `summary` is DPO-entered free text. It is rendered as text (never HTML) and is visible only on this page.

**Edge cases.** Device clock skew is irrelevant (server time). Offline: countdowns pause with "Reconnecting". A breach recorded with `detected_at` in the past may be born overdue, and shows red at once. A met_late clock stays red as "Met late" (a legal fact, not hidden). A closed breach moves to a collapsed "Closed" section.

**Data.** `queueWire {summary{open, overdue, due_within_24h, by_kind}, next_cursor, items[{id, type, subject_ref, status, received_at, due_at, ms_remaining, overdue, ready_target_at, ready_target_missed, cooling_ends_at, blockers}]}`; `breachWire {id, detected_at, severity, summary, affected_count, status, dpo_decision, triaged_at, pdpc_notified_at, subjects_notified_at, closed_at, clocks}`. PII: `subject_ref` is pseudonymous (P1); the breach summary may contain P2 typed by the DPO (DPO-only).

**API.**
| Call | Exists | Auth | Notes |
|---|---|---|---|
| `GET /v1/admin/privacy/requests?kind&overdue&include_closed&limit≤500` | Yes (`dpo.controller.ts:88`) | `dpo` + passkey, audited, 60/min | |
| `GET /v1/admin/privacy/breaches` | Yes (`:103`) | same | full list |
| `POST /v1/admin/privacy/breaches`, `/{id}/triage`, `/pdpc-notified`, `/subjects-notified`, `/close` | Yes (`:112-178`) | `dpo`; `Idempotency-Key` optional (`required: false`); 20/min | existing actions kept |
| Consent stats, transfer register | **No endpoint** | | gap, not Phase B |

**Events.** None new (breach actions already audit).

**Failure handling.** If the breach list fails, an error banner sits at the very top. That failure is severity-1, because it hides legal clocks, and it raises an A7 row ("Breach register unavailable") for the DPO.

**Security and abuse.** The DPO role only. Every read is audited as `pii_view`. No subject identity is shown. Actions keep the existing state machine (409 `invalid_transition`).

**Metrics.** KPI: share of breach clocks met on time (target 100%). SLI: render p95 < 1.5 s. Guardrail: any overdue clock raises an A7 severity-1 row.

**Acceptance.**
```gherkin
Scenario: PDPC clock goes amber then red
  Given a breach detected at 2026-10-15T09:00:00Z and server now 2026-10-17T10:00:00Z
  Then the PDPC clock shows "23 h left" with an amber icon and the text label
  Given server now 2026-10-17T22:00:00Z
  Then it shows "11 h left" in red

Scenario: no-notification decision
  Given the DPO triaged with "no_notification_required"
  Then PDPC and subject clocks read "Not required (DPO decision)"

Scenario: partial DSAR list
  Given 200 items returned with limit 200
  Then the table says "Showing the first 200" and the tiles still show the exact open count

Scenario: non-DPO
  Given an admin with the security role only
  Then /privacy returns the forbidden state
```

**Role visibility.** dpo only (read and act). security reads the PII-view audit on `/pii`, not this page.

**Blockers.** PA-ME (nav, A7), PA-UIWEB. Consent stats: no endpoint (gap). VR-01 (DSAR deadline) and VR-DB-01 (breach clock base) are the legal rows.

**Copy keys.**
| Key | AR | EN |
|---|---|---|
| `dpo.breach.title` | سجل الاختراقات | Breach register |
| `dpo.breach.clock.triage` | الفرز (4 ساعات) | Triage (4 h) |
| `dpo.breach.clock.pdpc` | إخطار مركز حماية البيانات (72 ساعة) | PDPC notice (72 h) |
| `dpo.breach.clock.subjects` | إخطار أصحاب البيانات (3 أيام) | Data subject notice (3 days) |
| `dpo.breach.left` | متبقٍ {{duration}} | {{duration}} left |
| `dpo.breach.overdue` | متأخر منذ {{duration}} | Overdue by {{duration}} |
| `dpo.breach.met` | تم في الموعد | Met on time |
| `dpo.breach.metLate` | تم متأخراً | Met late |
| `dpo.breach.notRequired` | غير مطلوب (قرار مسؤول حماية البيانات) | Not required (DPO decision) |
| `dpo.breach.waitingPdpc` | بانتظار إخطار المركز | Waiting for the PDPC notice |
| `dpo.breach.unavailable` | تعذّر تحميل سجل الاختراقات. قد تكون هناك مواعيد قانونية غير ظاهرة. | The breach register did not load. Legal deadlines may be hidden. |
| `dpo.dsar.title` | طلبات أصحاب البيانات | Data subject requests |
| `dpo.dsar.open` / `.overdue` / `.due24h` | مفتوحة / متأخرة / مستحقة خلال 24 ساعة | Open / Overdue / Due within 24 h |
| `dpo.dsar.deadlineNote` | مهلة عمل 30 يوماً؛ المهلة القانونية قيد التأكيد | 30-day working deadline; statutory deadline to be confirmed |
| `dpo.dsar.readyMissed` | فات موعد تجهيز الملف (72 ساعة) | Export ready target missed (72 h) |
| `dpo.dsar.blocker.open_orders` / `open_returns` / `open_disputes` | طلبات مفتوحة / مرتجعات مفتوحة / نزاعات مفتوحة | Open orders / Open returns / Open disputes |
| `dpo.dsar.partial` | يُعرض أول {{n}} طلب | Showing the first {{n}} |
| `dpo.consent.notMeasured` | إحصاءات الموافقات غير مقيسة بعد | Consent statistics are not measured yet |

---

### A6. KYC and suspension queue (`/sellers` and `/suspensions`, Supply/Trust)

**Flow.** Ops, T&S or support opens Sellers: the KYC funnel counts by state and the NEEDS_INFO and SUBMITTED queues, aged by last change. Ops, T&S or security opens Suspensions: open automatic and manual suspensions with their 5-business-day review clock, aging bars, and Uphold/Reinstate (ops and T&S, with a reason code).

**Wireframe.**
```
Sellers and KYC                                              As of …
KYC by state   Draft 4 | Submitted 7 | Auto checks 2 | Needs info 3 | Approved 120+ | Rejected 5
               (horizontal bars in pipeline order, counts capped "200+")
Needs info (oldest change first)   seller <bdi> | stores | last change | age since change [!>5 d]
Submitted / Auto checks            ...
-----------------------------------------------------------------------------------------
Suspension reviews (5 business days)                         As of …
 Due status:  Overdue 0 | Due in <1 business day 1 | 1-2 days 2 | 3-5 days 1   (aging bars)
 seller <bdi> | reason (words) | automatic? | suspended | due | time left (bullet) | [Uphold*] [Reinstate*]
```

| Element | Form | Why |
|---|---|---|
| KYC funnel | Horizontal bars in pipeline order, not sorted; capped counts labelled | Stage counts; the dwell box plot needs state-entry times that do not exist (F-8) |
| Queues | Tables | Action lists |
| Suspension due status | Aging histogram by **remaining** business time to `due_at` | Uses the server's business-day `due_at` instead of recomputing a calendar |
| Row clock | Bullet bar: time used of the 5-business-day window, plus text | Target against actual |

**Rules.**
- KYC states: `DRAFT, SUBMITTED, AUTO_CHECKS, APPROVED, NEEDS_INFO, REJECTED` (REPO `packages/domain/src/state-machine/machines/kyc.ts`). Counts come from one `GET /v1/admin/kyc/queue?state=X&limit=200` per state (6 calls, 60/min). Capped at "200+" when 200 rows return.
- Age is "since last change" from `updated_at` (F-8), never "in this state for". NEEDS_INFO with more than 5 days since the last change is flagged (INFERENCE, D-THRESH-2).
- Suspension SLA: `due_at` and `overdue` are server-computed (REPO `admin.controller.ts:125-135`, `packages/domain/src/admin/kyc-review.ts:129`). Buckets use `due_at - serverNow`, in hours converted to business days by the server-provided due time. If that conversion cannot be exact client-side, the buckets are "overdue / due in 24 h / due in 24-72 h / later". The row text always shows the exact `due_at`.
- Uphold: `POST /v1/admin/kyc/suspension-reviews/{id}/uphold` (no body). Reinstate: `POST /v1/admin/kyc/sellers/{sellerId}/reinstate` with a `reason_code` from `ADMIN_REASON_CODES`, through the existing `ReasonDialog`. Both require posture ok.
- "Automatic" suspensions are labelled, because the spec requires human review of automatic suspensions within 5 business days (master prompt 9.5; legality VR-15).

**Edge cases.** A review decided by someone else between render and click returns 409 `kyc_conflict` ("Changed; reload"). A seller with zero stores is shown as "No stores". `store_names` are seller-supplied Latin or Arabic text, rendered in `<bdi>` as text. A suspension review list entry without an OPEN state goes to "Decided".

**Data.** `sellerWire {seller_id, kyc_state, store_count, store_names, updated_at}`; `reviewWire {id, seller_id, state ∈ OPEN|UPHELD|REINSTATED, reason_code, suspended_at, due_at, overdue, automatic, reviewed_at}`. PII: P1 business data.

**API.**
| Call | Exists | Auth | Notes |
|---|---|---|---|
| `GET /v1/admin/kyc/queue?state=&limit≤200` | Yes (`admin.controller.ts:446`) | kycRead: ops, trust_safety, support; audited; 60/min | |
| `GET /v1/admin/kyc/sellers/{sellerId}` | Yes (`:455`) | same | with `open_review` |
| `GET /v1/admin/kyc/suspension-reviews?state=&limit≤200` | Yes (`:516`) | kycReviewRead: ops, trust_safety, security | |
| `POST …/suspension-reviews/{id}/uphold` | Yes (`:526`) | kycWrite: ops, trust_safety; 20/min | no Idempotency decorator on this route (REPO); the web sends a key anyway |
| `POST /v1/admin/kyc/sellers/{sellerId}/suspend` and `/reinstate` | Yes (`:482,:499`) | kycWrite; Idempotency-Key required; `reason_code` | |
| `/v1/admin/sellers` | OpenAPI only, **no controller** | | not used |

**Events.** None new.

**Failure handling.** Per-state call failures mark that bar "not loaded". Actions are never retried automatically.

**Security and abuse.** BFLA: support and security see read-only views (support has no suspension read; security has no KYC read). Reason codes are required for reinstate and audited. The uphold route has no idempotency decorator; flagged for the builder as a follow-up check (INFERENCE: a duplicate uphold is a state-machine 409, so it is safe).

**Metrics.** KPI: suspension reviews decided within 5 business days (target 100%, spec 9.5). Guardrails: an overdue review raises an A7 severity-2 row; a review within 1 business day of due raises a severity-2 row.

**Acceptance.**
```gherkin
Scenario: overdue review
  Given an OPEN review whose due_at is before server now
  Then the row shows "Overdue" with icon and text, and Home shows it to ops and trust_safety

Scenario: capped funnel
  Given 200 APPROVED sellers returned for limit 200
  Then the Approved bar is labelled "200+"

Scenario: support cannot open suspensions
  Given a support admin
  Then /suspensions renders the forbidden state from the API's 403
```

**Role visibility.** KYC: ops, trust_safety, support (read); ops, trust_safety (act). Suspensions: ops, trust_safety, security (read); ops, trust_safety (act).

**Blockers.** PA-ME, PA-UIWEB. A dwell-time box plot needs `state_entered_at` (Phase C).

**Copy keys.**
| Key | AR | EN |
|---|---|---|
| `kycQueue.title` | البائعون والتحقق من الهوية | Sellers and verification |
| `kycQueue.state.<STATE>` | مسودة، مُقدَّم، فحوص آلية، مطلوب معلومات، معتمد، مرفوض | Draft, Submitted, Automatic checks, Needs information, Approved, Rejected |
| `kycQueue.sinceChange` | منذ آخر تغيير: {{duration}} | Since last change: {{duration}} |
| `kycQueue.agedFlag` | لم يتغير منذ أكثر من {{days}} أيام | No change for more than {{days}} days |
| `kycQueue.capped` | {{n}}+ | {{n}}+ |
| `suspensions.title` | مراجعات الإيقاف (5 أيام عمل) | Suspension reviews (5 business days) |
| `suspensions.automatic` | إيقاف آلي، يحتاج مراجعة بشرية | Automatic suspension, needs human review |
| `suspensions.due` | المراجعة مستحقة {{time}} | Review due {{time}} |
| `suspensions.bucket.overdue` / `.lt1` / `.d1_2` / `.d3_5` | متأخرة / خلال يوم عمل / يوم إلى يومين / 3 إلى 5 أيام | Overdue / Within 1 business day / 1-2 days / 3-5 days |
| `suspensions.reason.<CODE>` | (one key per suspension reason code) | (one key per code) |

---

### A7. Home "Attention needed" (`/`)

**Flow.** Any admin signs in and lands on Home. A queue lists only items the viewer's roles may act on, ordered by severity and then deadline. Each row has a count (exact or capped), an age or deadline, and a deep link. Below sit "Approvals waiting on me" and "My elevations expiring". The existing brand-application tiles stay as one source.

**Wireframe.**
```
Home                                              Roles: Finance, Ops (from server)   As of …
Attention needed
 1  [!] Ledger check failed: trial balance                  1 h ago        Ledger health ->
 2  [clock] Breach PDPC notice due                          23 h left      Privacy ->
 2  [clock] Suspension review due                           6 h left       Suspensions ->
 3  [!] Reconciliation: unmatched older than 3 days         2 items        Reconciliation ->
 3  [!] Payouts failed                                       1              Payouts ->
 3  [!] Tax documents in dead letter                         50+            Tax ->
 4  [inbox] Approvals waiting on me                          2              Approvals ->
 5  [!] KYC needs info for more than 5 days                  3              Sellers ->
 (Empty state: "Nothing needs your attention right now." with the as-of time)
Brand applications   Unassigned 12 | Mine 3 | SLA late 50+     (existing tiles)
All areas (link list, role filtered)
```

| Element | Form | Why |
|---|---|---|
| Queue | Ordered list (not a chart), each row with severity icon, text, count, deadline, link | A queue that empties as you act (report section 2) |
| Brand tiles | Existing tiles | Kept |

**Rules.**
- **Requires PA-ME.** With `roles === null` (VR-AC-01), the queue is not computed: the page shows "Your roles could not be confirmed, so attention items are hidden", plus the link list (today's behaviour). This avoids fanning out to endpoints that would deny and audit (section 4.4).
- Source matrix (severity 1 = page-level, 2 = legal clocks, 3 = money, 4 = approvals, 5 = trust):

| Sev | Item | Source call | Roles that see it | Count rule |
|---|---|---|---|---|
| 1 | Ledger integrity failed or never ran for 26 h+ | PA-INTEGRITY | finance | binary |
| 1 | Breach register unavailable | `GET /v1/admin/privacy/breaches` error | dpo | binary |
| 2 | Breach clock overdue or within 24 h | breaches `clocks` | dpo | exact |
| 2 | DSAR overdue or due within 24 h | requests `summary.overdue`, `due_within_24h` | dpo | exact |
| 2 | Suspension review overdue or due within 1 business day | suspension-reviews `state=OPEN` | ops, trust_safety, security | capped 200 |
| 3 | Unmatched older than 3 days; last run failed | recon summary (B-2) | finance, ops | exact (B-2) or "at least" |
| 3 | Payouts FAILED; ON_HOLD older than 7 days | payouts summary (B-1) or `status=FAILED&limit=50` | finance, ops | exact or "50+" |
| 3 | ETA dead letters; rejects today | tax documents `state=DEAD_LETTER&limit=50`; today's reconciliation | finance, ops, super_admin | "50+" |
| 4 | Approvals waiting on me | `GET /v1/admin/approvals` filtered by `approvalInbox(selfId, selfRoles)` | any | exact within the page |
| 4 | My elevations expiring within 1 h | `GET /v1/admin/elevations/mine` | any | exact |
| 5 | KYC NEEDS_INFO for more than 5 days since change | kyc queue `state=NEEDS_INFO` | ops, trust_safety, support | capped 200 |
| 5 | Brand applications SLA late | existing `brandQueue(sla_breached)` | ops, trust_safety (capability `brand_review.read`; standing super_admin does not pass the brand review gate) | "50+" |

- **Visibility comes from capabilities, not from the "Roles that see it" column** (amended after the security and privacy review, `dashboard-foundations.md` section 7.2, M7). Each row is shown only when `GET /v1/admin/me` reports the capability of the page it links to, computed by the same exported predicate the route gate uses: integrity `ledger.integrity.read`; breach register, breach clocks and DSAR `privacy.read`; suspension reviews `kyc_review.read`; reconciliation `recon.read` (finance, ops); payouts `payout.read`; ETA `tax.read` (finance, ops, super_admin); approvals and elevations `console.access`; KYC needs-info `kyc.read`; brand applications `brand_review.read` (ops, trust_safety). The roles column above is informative and must equal the capability outcome (snapshot test); where they differ, the capability wins. The legal-clock thresholds (DSAR due, breach 72 h) are Proposed owner and counsel values (VR-01, VR-DB-01).
- Interim (no PA-ATTN): the admin-web server calls only the sources whose capability is true in `me`, in parallel, with a 3 s budget per call. A source that fails shows one row "Could not check {area}" (severity of that source), never silence.
- With PA-ATTN, the server returns counts only, already filtered; the page renders the same rows.
- The order is severity ascending, then the soonest deadline, then the largest count. Ties are broken by a stable source order.
- Business anomalies (GMV, conversion) are Phase C and not shown.

**Edge cases.** A user with zero effective roles (standing super_admin only, no elevation) sees only Approvals and Elevations plus the text "Most areas need an active elevation". When a source returns 403 even though its role is held (a policy drift), the row is hidden and a console-side error is logged with the request id, without disclosing anything to the user. Counts change after an action; returning Home re-renders (no live push, D2).

**Data.** No new data. The deadline and count per source are read as defined in that source's view. PII: none (counts and links only).

**API.** The calls listed in the matrix, all existing except PA-INTEGRITY, B-1, B-2 and PA-ATTN.

**Events.** None.

**Failure handling.** Per-source isolation as above. A total budget of 4 s, after which the remaining sources show "Still checking: open the area".

**Security and abuse.** No cross-role leakage: a role that cannot read a source never triggers its call, and with PA-ATTN the server filters. Negative test per role (test plan). Counts can leak volume to a role that holds the source, which is acceptable because the source view shows the same.

**Metrics.** KPI: median time from an item appearing to its view being opened (Phase C, needs the audit log). SLI: Home server render p95 < 2 s. Guardrail: zero calls to sources outside the viewer's roles (asserted in tests through gateway request logs).

**Acceptance.**
```gherkin
Scenario: roles unknown
  Given GET /v1/admin/me fails
  When an admin opens Home
  Then no attention source is called and the notice "Your roles could not be confirmed" is shown

Scenario: role filtering
  Given an admin whose effective roles are [dpo]
  Then Home calls only the privacy sources, approvals and elevations
  And shows no finance, KYC or tax rows

Scenario: a source fails
  Given the reconciliation summary returns 503 for a finance admin
  Then Home shows "Could not check reconciliation" at severity 3

Scenario: nothing to do
  Given every source returns zero for a finance admin
  Then Home shows "Nothing needs your attention right now" with the as-of time
```

**Role visibility.** Per the matrix. super_admin standing grants nothing (the ledger and admin gates are break-glass only).

**Blockers.** **PA-ME (hard)**, PA-INTEGRITY (row 1), B-1 and B-2 (exact counts), PA-ATTN (soft).

**Copy keys.**
| Key | AR | EN |
|---|---|---|
| `attention.title` | يحتاج إلى انتباهك | Attention needed |
| `attention.none` | لا شيء يحتاج إلى انتباهك الآن. | Nothing needs your attention right now. |
| `attention.rolesUnknown` | تعذّر تأكيد أدوارك، لذلك أُخفيت البنود. | Your roles could not be confirmed, so attention items are hidden. |
| `attention.noRoles` | معظم الأقسام تحتاج إلى صلاحية مؤقتة مفعّلة. | Most areas need an active elevation. |
| `attention.couldNotCheck` | تعذّر فحص {{area}} | Could not check {{area}} |
| `attention.stillChecking` | ما زال الفحص جارياً: افتح القسم | Still checking: open the area |
| `attention.item.ledgerFailed` | فشل فحص دفتر الأستاذ: {{check}} | Ledger check failed: {{check}} |
| `attention.item.breachDue` | موعد إخطار الاختراق يقترب | Breach notice due |
| `attention.item.dsarDue` | طلبات بيانات متأخرة أو مستحقة خلال 24 ساعة | Data requests overdue or due within 24 h |
| `attention.item.suspensionDue` | مراجعة إيقاف مستحقة | Suspension review due |
| `attention.item.reconOverdue` | مطابقة: بنود غير مطابقة منذ أكثر من 3 أيام | Reconciliation: unmatched older than 3 days |
| `attention.item.payoutsFailed` | دفعات فشلت | Payouts failed |
| `attention.item.etaDead` | مستندات ضريبية متوقفة | Tax documents in dead letter |
| `attention.item.approvals` | موافقات بانتظارك | Approvals waiting on you |
| `attention.item.elevations` | صلاحياتك المؤقتة تنتهي قريباً | Your elevations expire soon |
| `attention.item.kycAged` | طلبات تحقق تنتظر معلومات منذ أكثر من {{days}} أيام | Verification waiting for information for more than {{days}} days |
| `attention.roles` | الأدوار: {{roles}} | Roles: {{roles}} |

---

## 6. Seller views

Common seller rules: the store id comes from `GET /v1/seller/me` memberships (F-4, F-6), with a store switcher when there is more than one. A foreign or malformed store id is a 404 with an identical body (seller-analytics spec), rendered as `forbidden`. Buyer data is masked and only present while the order is active (REPO `buyerViewForSeller`). Nav role filtering stays off until D-ROLE-3 resolves the vocabulary mismatch (F-5); the API enforces access regardless.

### S1. Order pipeline with SLA timers (`/orders`)

**Flow.** Fulfilment staff open Orders. A state strip shows counts per state. Below it the "Act now" queue lists PAID orders (accept by) and ACCEPTED/PACKED orders (dispatch by), soonest deadline first, with countdowns. Accept, reject, pack and create shipment are the existing actions.

**Wireframe.**
```
Orders                                          Server time 14:02 Cairo   [Refresh]
State: Paid 4 | Accepted 3 | Packed 2 | Shipped 18 | Out for delivery 5 | Delivered 50+ | Exceptions 1
Act now (soonest deadline first; sorted within the orders loaded)
 order <bdi> | items | governorate | deadline type | time left            | [Accept] [Reject]
 A1B2…       | 2     | Giza        | Accept by     | [====---] 1 h 40 m (!)
 C3D4…       | 1     | Cairo       | Dispatch by   | [==-----] 30 h 10 m       [Pack]
Exceptions: cancelled, rejected by seller, delivery failed, returned to seller, disputed (table)
```

| Element | Form | Why |
|---|---|---|
| State strip | Labelled count strip in pipeline order (not a chart) | Snapshot of a state machine; order matters more than size |
| Countdown rows | Bullet bar of time used against the 24 h or 48 h window, plus text and an icon at warning or overdue | Target against actual; linear, not radial |

**Rules.**
- Deadlines come from the wire: `accept_by` (always set) and `dispatch_by` (when accepted) (REPO `orders/adapters/wire.ts:66-68`). The window lengths are `ACCEPT_SLA_MS` (24 h) and `DISPATCH_SLA_MS` (48 h) (REPO `packages/domain/src/orders/types.ts:6-8`), used only to scale the bullet. The deadline itself is never recomputed client-side.
- Countdown: the existing `slaCountdown` (server time plus a monotonic elapsed timer; no server time means no countdown, REPO `view-models/sla.ts`). Warning at ≤ 2 h (`SLA_WARNING_MS`, existing); overdue at 0. Changing the warning threshold is D-THRESH-3 (Proposed: keep 2 h).
- Counts: one `GET /v1/seller/orders?status=X&limit=50` per shown state, "50+" when `has_more`. Delivered and Closed are collapsed into one "Delivered" count, because CLOSED means the return window ended.
- Sorting: B-4 `sort=deadline` when available; otherwise the queue sorts only the loaded rows (up to 2 pages per state) and shows "Sorted within the first {n} orders".
- An overdue accept leads to auto-cancel by the `orders.expire-unaccepted` job (REPO `workers/registry.ts:53-54`). The row says "Will be cancelled automatically" once overdue, which is true only because that job exists.
- Buyer: governorate and first name only in the list. The relay phone and address only on detail while the order is active.

**Edge cases.** An order that changes state between render and click returns 409 and "This order changed; reload". Offline: countdowns pause. The order must be in a store the user holds; a foreign store is 404. COD versus prepaid is shown from `payment_type` as words.

**Data.** `sellerOrderViewWire {id, status, lines[], subtotal, shipping, commission, net_to_seller, buyer{governorate_code, first_name?, phone_relay?, address_visible}, accept_by, dispatch_by?, payment_type, created_at}`. PII: P2 masked (first name, relay phone), time-limited.

**API.**
| Call | Exists | Auth | Notes |
|---|---|---|---|
| `GET /v1/seller/orders?status=&cursor=&limit≤50` | Yes (`orders.controller.ts:185`) | `store_order` read (owner, manager, warehouse, support, finance), 120/min | |
| `GET /v1/seller/orders/{id}` | Yes (`:205`) | same, ETag | |
| `POST …/{id}/accept`, `/reject`, `/pack`; `POST /v1/seller/shipments` | Yes | `store_order` write (owner, manager, warehouse); Idempotency-Key | existing |
| `sort=deadline` | **No (B-4)** | | optional |

**Events.** None new.

**Failure handling.** If a count call fails, only that count shows "not loaded". If the queue fails, it shows an error with retry and the strip remains.

**Security and abuse.** Cross-tenant 404 (existing tests). Write roles are enforced by the API: support and finance can read but not accept.

**Metrics.** KPI: accept within SLA (bps) and dispatch within SLA (Phase C aggregates). SLI: render p95 < 1.5 s. Guardrail: no countdown is shown without server time (tested).

**Acceptance.**
```gherkin
Scenario: countdown from server time
  Given an order with accept_by 16:00 Cairo and server time 14:02
  And the device clock is 3 hours fast
  Then the row shows "1 h 58 m left" with the warning icon

Scenario: no server time
  Given a response without a server time header
  Then the row shows the deadline time and no countdown

Scenario: foreign store
  Given a seller of store A requests orders filtered to store B
  Then the API returns 404 and the page shows the forbidden state
```

**Role visibility.** Read: owner, manager, warehouse, support, finance (API). Act: owner, manager, warehouse. Nav (fulfilment) pending D-ROLE-3.

**Blockers.** PA-SME (store and role), PA-UIWEB (bullet; text-only fallback acceptable), B-4 (soft).

**Copy keys (seller).**
| Key | AR | EN |
|---|---|---|
| `orders.pipeline.title` | مسار الطلبات | Order pipeline |
| `orders.pipeline.actNow` | يحتاج إجراءً الآن | Act now |
| `orders.pipeline.acceptBy` | اقبل قبل | Accept by |
| `orders.pipeline.dispatchBy` | اشحن قبل | Dispatch by |
| `orders.pipeline.left` | متبقٍ {{h}} س {{m}} د | {{h}} h {{m}} m left |
| `orders.pipeline.overdue` | فات الموعد | Overdue |
| `orders.pipeline.autoCancel` | سيُلغى الطلب تلقائياً | Will be cancelled automatically |
| `orders.pipeline.sortedWithin` | مرتبة ضمن أول {{n}} طلب | Sorted within the first {{n}} orders |
| `orders.pipeline.serverTime` | وقت الخادم {{time}} بتوقيت القاهرة | Server time {{time}} Cairo |
| `orders.pipeline.changed` | تغيّر هذا الطلب؛ أعد التحميل | This order changed; reload |
| `orders.state.<STATE>` | (one per seller order state) | (one per state) |

---

### S2. Returns by SKU and inspection queue (`/returns`)

**Flow.** The seller opens Returns. The inspection queue comes first (48 h clocks), then "Return rate by product" (ranked) and the reasons for a selected product.

**Wireframe.**
```
Returns                                    Window: last 30 days (UTC days)   Data as of 13:50
Inspect now (48 h)   return <bdi> | reason (words) | received | inspect by | time left | [Inspect]
Return rate by product (products with sales in the window)
 Linen dress (M,L)     ######## 18.0%  (9 of 50 sold)
 Cotton shirt          ####     8.0%   (4 of 50)
 [View as table]
Reasons for: Linen dress    Too small ##### 5 | Too large ## 2 | Changed mind # 1 | Defective # 1
```

| Element | Form | Why |
|---|---|---|
| Inspection queue | Countdown rows | Deadlines |
| Return rate | Sorted horizontal bar with the n label ("9 of 50 sold") | Ranking; n prevents small-sample misreads |
| Reasons | Sorted horizontal bar (never a pie) | Ranking of causes |

**Rules.**
- Data: the analytics `returns` route `skus[{sku_id, product_id, sold_units, returned_units, return_rate_bps, reasons}]` plus `meta` (REPO `seller-analytics/adapters/wire.ts:133-143`).
- **R-NODATA** applies: `meta.freshness.as_of === null` renders "No data yet" for the rate and reasons sections. The inspection queue comes from the operational returns list and is unaffected.
- Products are named, never shown as ids (UX rule 2). Names come from `GET /v1/seller/products` pages (catalog), joined in the server render. If a name is missing: "Product no longer listed". The analytics product store is `internal.wiring` in production (repo audit), so the API cannot name them.
- Rate shown as a percentage from bps with one decimal, always with "x of y sold". Products with `sold_units` < 5 (INFERENCE, D-THRESH-4) are listed in the table but not ranked in the chart ("too few sales to compare").
- Reason taxonomy in words (spec 22: too small, too large, not as described, defective, changed mind, late, wrong item).
- Inspection: `inspection_due_at` from the returns list (48 h; silence = auto-approve per spec 22). The row says "Approves automatically when time runs out".

**Edge cases.** A window with sales but no returns is a real zero ("No returns in this window") only when R-NODATA passes. A stale `meta` greys the chart with "Last updated". A product deleted mid-window: "Product no longer listed".

**Data.** As above; the returns list (`returnWire {id, order_line_id, seller_order_id, status, reason, resolution, return_shipping_payer, eligibility_window_ends_at, inspection_due_at, created_at}`). PII: none (no buyer identity).

**API.**
| Call | Exists | Auth | Notes |
|---|---|---|---|
| `GET /v1/seller/stores/{storeId}/analytics/returns?from&to` | Yes (`analytics.controller.ts:134`) | `store_order` read, 120/min | UTC-day windows, max 366 days |
| `GET /v1/seller/returns?cursor&limit` | Yes (`returns.controller.ts:238`) | `store_return` read (owner, manager, warehouse, support) | |
| `POST /v1/seller/returns/{returnId}/inspect` | Yes | `store_return` write | existing |
| `GET /v1/seller/products` | Yes (client) | catalog | for names |

**Events, failure, security.** No new events. The analytics section and the queue fail independently. Cross-tenant 404; no shopper ids on the wire.

**Metrics.** KPI: return rate by SKU; inspection within 48 h. Guardrail: zero numbers rendered under `as_of === null`.

**Acceptance.**
```gherkin
Scenario: analytics never ingested
  Given meta.freshness.as_of is null
  Then "Return rate by product" shows "No data yet" and no bar, percentage or zero
  And the inspection queue still lists open returns

Scenario: small sample
  Given a product with 3 sold and 1 returned
  Then it appears in the table as "33.3% (1 of 3 sold)" and not in the ranked chart
```

**Role visibility.** Analytics: owner, manager, warehouse, support, finance. Queue: owner, manager, warehouse, support.

**Blockers.** PA-SME, PA-PUB (any real data), PA-UIWEB.

**Copy keys.**
| Key | AR | EN |
|---|---|---|
| `returnsSku.title` | المرتجعات حسب المنتج | Returns by product |
| `returnsSku.inspectNow` | افحص الآن (48 ساعة) | Inspect now (48 h) |
| `returnsSku.autoApprove` | يُقبل تلقائياً عند انتهاء الوقت | Approves automatically when time runs out |
| `returnsSku.rate` | {{rate}} ({{returned}} من {{sold}} مبيعة) | {{rate}} ({{returned}} of {{sold}} sold) |
| `returnsSku.tooFew` | مبيعات قليلة جداً للمقارنة | Too few sales to compare |
| `returnsSku.noReturns` | لا مرتجعات في هذه الفترة | No returns in this window |
| `returnsSku.unlisted` | المنتج لم يعد معروضاً | Product no longer listed |
| `returnsSku.reason.<REASON>` | مقاس صغير، مقاس كبير، غير مطابق للوصف، معيب، تغيير رأي، متأخر، منتج خاطئ | Too small, Too large, Not as described, Defective, Changed mind, Late, Wrong item |
| `analytics.noDataYet` | لا بيانات بعد. تبدأ الإحصاءات عند وصول أول الأحداث. | No data yet. Analytics starts once the first events arrive. |
| `analytics.utcDays` | الأيام محسوبة بتوقيت UTC | Days are counted in UTC |
| `analytics.asOf` | البيانات حتى {{time}} | Data as of {{time}} |
| `analytics.stale` | آخر تحديث {{time}}، أقدم من المعتاد | Last updated {{time}}, later than usual |

---

### S3. Ads reports (`/ads`)

**Flow.** The owner or manager opens Ads, then Report, and picks a period (default 30 days). Tiles show the totals. A ROAS-by-campaign bar has a 1.00x reference line. Spend and attributed revenue are shown as two aligned bar panels per campaign.

**Wireframe.**
```
Ads report            Period: 17 Sep - 16 Oct   [change]       Spend excludes VAT
Impressions 12,400 | Clicks 310 | CTR 2.50% | Spend EGP 1,240.00 | CPC EGP 4.00 | Revenue EGP 3,100.00 | ROAS 2.50x
ROAS by campaign                       | 1.00x
 Ramadan edit      ##########|####  2.50x
 Basics            #####     |      0.80x
Spend (EGP)               Attributed revenue (EGP)      (two aligned panels, same row order)
```

| Element | Form | Why |
|---|---|---|
| Totals | Tiles (no deltas, D4) | |
| ROAS | Horizontal bar with a 1.00x reference line | Target against actual; break-even is the meaningful reference |
| Spend and revenue | Two aligned bar panels | Avoids a dual axis (rulebook) |

**Rules.**
- Fields: `{from, to, total{impressions, clicks, spend, attributed_revenue, ctr_bp, cpc|null, roas_bp|null}, campaigns[{campaign_id, name, ...stats}]}` (REPO `ads.controller.ts:121-129,306-326`). `roas_bp` is a string of bps (10,000 = 1.00x). `cpc` null when there are no clicks.
- Spend is VAT-exclusive (the ads balance says `vat_inclusive: false`). The caption says "Spend excludes VAT". No VAT figure is computed (D-VAT-1).
- `roas_bp === null`: "No spend". `cpc === null`: "No clicks".
- Attribution honesty: in the production composition the ads attribution port is `internal.wiring` (repo audit). If the report returns but attribution is not connected, revenue would read 0. Until the API exposes an attribution status, the revenue tile and ROAS show "Attribution not connected yet" whenever `attributed_revenue` is 0 **and** clicks > 0 (INFERENCE heuristic, Proposed). Tracked as gap G-ADS-1.
- Campaign names are seller text in `<bdi>`.

**Edge cases.** A 503 from a wired port is an error state "Ads reporting unavailable". No campaigns: empty "No campaigns in this period". `to <= from`: 422, prevented by the date picker.

**Data.** As above. PII: none.

**API.** `GET /v1/seller/ads/reports?store_id&from&to[&campaign_id]` (Yes; `store_payout` read: owner, manager, finance; 60/min). `GET /v1/seller/ads/campaigns`, `/balance` (Yes).

**Events, failure, security.** None new; a single call; cross-tenant 404 on a foreign `campaign_id` (existing).

**Metrics.** KPI: ROAS and CTR. Guardrail: never show a ROAS computed client-side.

**Acceptance.**
```gherkin
Scenario: break-even line
  Given a campaign with roas_bp "8000"
  Then its bar ends short of the 1.00x line and is labelled "0.80x" with the text "below break-even"

Scenario: attribution not connected
  Given clicks 310 and attributed_revenue 0
  Then revenue and ROAS show "Attribution not connected yet" instead of "EGP 0.00" and "0.00x"
```

**Role visibility.** owner, manager, finance (API `store_payout` read); nav shows owner and manager.

**Blockers.** PA-SME, PA-UIWEB; G-ADS-1 (attribution status field, soft).

**Copy keys.**
| Key | AR | EN |
|---|---|---|
| `adsReport.title` | تقرير الإعلانات | Ads report |
| `adsReport.spendExVat` | الإنفاق لا يشمل ضريبة القيمة المضافة | Spend excludes VAT |
| `adsReport.roas` | العائد على الإنفاق الإعلاني | Return on ad spend |
| `adsReport.breakEven` | نقطة التعادل 1.00x | Break-even 1.00x |
| `adsReport.belowBreakEven` | أقل من نقطة التعادل | Below break-even |
| `adsReport.noSpend` | لا إنفاق | No spend |
| `adsReport.noClicks` | لا نقرات | No clicks |
| `adsReport.attributionMissing` | ربط الإيرادات بالإعلانات غير متصل بعد | Attribution not connected yet |
| `adsReport.noCampaigns` | لا حملات في هذه الفترة | No campaigns in this period |

---

### S4. Forecasts (`/forecasts`)

**Flow.** Catalog or warehouse staff open Forecasts, pick a horizon (7, 14 or 28 days, per the API's horizons) and a scope. An interval plot shows p10, p50 and p90 per row. Insufficient or suppressed rows explain why. The bilingual advice notice from the server is always visible.

**Wireframe.**
```
Demand forecast (advice only)           As of 15 Oct (generated 03:15)   [stale badge if stale]
"Estimates are advice only. The range shows where demand is expected to fall 8 times out of 10. ..."
 scope        | next 14 days            | how sure            | history
 Dresses / M  |   |----[*]------|  12-30 units, most likely 18   | backtest error 22% vs baseline 31% | 140 days
 Shirts / XL  | Not enough history (reason in words)
```

| Element | Form | Why |
|---|---|---|
| Rows | Interval plot (range line p10 to p90, tick at p50), labelled with numbers | Uncertainty must be visible; a bare point would overstate certainty (the API has no point field) |
| Backtest | Text in the row | Context, not a chart |

**Rules.**
- Data: `forecastsWire {store_id, as_of_date, generated_at, stale, advice_only, notice{ar,en}, items[{scope, scope_key, horizon_days, status, reason_codes, model_version, model?, interval?{p10,p50,p90,nominal_coverage_bps}, history?, backtest?}], has_more}` (REPO `forecasting/adapters/wire.ts`).
- Show `notice[locale]` verbatim. Coverage is "nominal" (8 of 10) until backtests measure it; when `backtest.coverage_bps` exists it is shown as "measured {x}%".
- 503 `demand_forecasting_disabled`: `not_configured` "Forecasts are switched off" (the `kill.demand_forecasting` default is Blocked).
- `stale: true`: the stale state, with `generated_at`.
- Rows with `status !== "ok"` show `reason_codes` in words, never a number.

**Edge cases.** p10 = p90 shows a single tick labelled "narrow range". Zero p90 shows "No demand expected" only when status is ok. Rate limit 30/min: one call per render.

**API.** `GET /v1/seller/stores/{storeId}/forecasts?scope&scope_key&horizon_days&limit≤200` (Yes; `store_inventory` read: owner, manager, catalog, warehouse).

**Events, failure, security.** None new. Single call. Cross-tenant 404. The interval is read-only advice (spec 20.8).

**Metrics.** KPI: none in Phase B (dark feature). Guardrail: no point estimate is ever rendered without its range.

**Acceptance.**
```gherkin
Scenario: forecasting switched off
  Given the API returns 503 demand_forecasting_disabled
  Then the page shows "Forecasts are switched off" and no chart

Scenario: insufficient history
  Given an item with status "insufficient_history"
  Then the row shows "Not enough sales history yet" and no range
```

**Role visibility.** owner, manager, catalog, warehouse.

**Blockers.** PA-SME, PA-UIWEB, `kill.demand_forecasting` (owner switch, VR-P3-14).

**Copy keys.**
| Key | AR | EN |
|---|---|---|
| `forecast.title` | توقع الطلب (للاسترشاد فقط) | Demand forecast (advice only) |
| `forecast.off` | التوقعات متوقفة حالياً | Forecasts are switched off |
| `forecast.range` | من {{p10}} إلى {{p90}} وحدة، والأرجح {{p50}} | {{p10}} to {{p90}} units, most likely {{p50}} |
| `forecast.nominal` | النطاق اسمي: 8 من كل 10 | The range is nominal: 8 times out of 10 |
| `forecast.measured` | التغطية المقاسة {{x}} | Measured coverage {{x}} |
| `forecast.narrow` | نطاق ضيق | Narrow range |
| `forecast.reason.<CODE>` | (one key per reason code) | (one key per reason code) |
| `forecast.stale` | أُنشئ {{time}}، أقدم من المعتاد | Generated {{time}}, older than usual |

---

### S5. Sales, traffic and funnel from the nine analytics routes (`/dashboard`, `/insights`)

**Flow.** The seller opens Dashboard and picks a window (default last 30 UTC days; max 366). The Sales tiles come first, then funnel, traffic by source, geography and search terms. Insights holds sell-through, size curve and aging with the markdown table. Each section shows its own as-of stamp.

**Wireframe.**
```
Dashboard          Store: [Nile Linen v]   Window: 17 Sep - 16 Oct (UTC days)   Data as of 13:50
[No data yet banner when every report has as_of null:
 "No data yet. Analytics starts once the first events arrive. Nothing here is zero; it is not measured."]
Sales     GMV | Net after commission | Orders | Units | AOV | Repeat rate (needs 50+ shoppers)
Funnel    Views ########## 1,200 -> Bag #### 140 (11.66%) -> Checkout ## 60 (42.85%) -> Purchase # 40 (66.66%)
          (impressions: "not measured yet")
Traffic by source   [ feed 45% | search 30% | stylist 10% | other (includes small groups) 15% ]  + table
Geography (orders)  Cairo ##### | Giza ### | Alexandria ## | Other governorates (includes small groups)
Search terms        "linen dress" ##### 120 clicks | ...   (+ "4 terms hidden: fewer than 50 shoppers")
Insights: Sell-through (bullet vs target) | Size curve (stocked vs sold, paired bars) | Aging 30/60/90 (stacked) + markdown table
```

| Element | Form | Why |
|---|---|---|
| Sales | Tiles, no deltas (D4) | Single aggregate per window |
| Funnel | Horizontal funnel bars with step conversion (bps shown as %) | Sequential drop-off |
| Traffic by source | One 100% stacked horizontal bar plus table | Composition of one window total (no series yet) |
| Geography | Sorted horizontal bar (no map in Phase B) | Ranking; maps rank poorly and need licensed shapes |
| Search terms | Ranked horizontal bar | Ranking |
| Sell-through | Bullet per SKU against the target (when a target is configured; otherwise a bar) | Target against actual |
| Size curve | Paired bars per size (stocked share against sold share) | Two-measure comparison |
| Aging | Stacked horizontal bar per bucket plus the markdown table | Composition |

**Rules.**
- **R-NODATA per report.** Each of the nine responses carries `meta {store_id, from, to, freshness{as_of, lag_ms, slo_ms, within_slo}, k_anonymity_min: 50}` (REPO `seller-analytics/adapters/wire.ts:17-28`). `as_of === null`: that section is `no_data_yet` with no numbers. `within_slo === false`: stale. Only with `as_of` set and within SLO may a zero show, as "0".
- When all sections are `no_data_yet`, one page-level banner replaces the per-section messages. This is the expected production state until PA-PUB (F-7).
- Impressions and per-store checkout: until PA-PUB publishes them, the funnel's impression and checkout steps are "not measured yet" even when other steps have data (seller-analytics spec gaps). The step conversion into an unmeasured step is not computed.
- k-anonymity: suppressed cells are counted, never named ("4 terms hidden: fewer than 50 shoppers"). A merged cell flagged `includes_suppressed` is labelled "includes small groups". Repeat rate null shows "Needs at least 50 shoppers".
- Markdown table: always shows the mandatory notice that a new price will not show "% off" unless verified (`showsPercentOff: false`, spec 19.1; markdown is `heuristic_v1`). No clearance probability is shown.
- CSV export (owner and manager) stays on the existing watermarked, audited route; no new export.
- Money from `amount_minor` strings via the bigint formatter.
- Store names and search terms in `<bdi>`; search terms are shopper text and rendered as text.

**Edge cases.** A window longer than 366 days returns 422 `invalid_range`, prevented by the picker. A 503 `seller_analytics_unavailable` is an error ("Analytics temporarily unavailable"), **not** no-data. Multi-store users switch store; each switch is a full server render.

**Data.** The nine wires (traffic, funnel, sales, sell-through, size-curve, aging, returns, search-terms, geography) as in `seller-analytics/adapters/wire.ts`. PII: P1 aggregates, k>=50.

**API.** `GET /v1/seller/stores/{storeId}/analytics/{traffic|funnel|sales|sell-through|size-curve|aging|returns|search-terms|geography}?from&to` (Yes, `analytics.controller.ts:71-154`; `store_order` read; 120/min each). `POST …/analytics/exports` (Yes; owner and manager). `GET /v1/seller/analytics/summary`: OpenAPI only, **no controller**, not used.

**Events.** None. The page loads no analytics SDK.

**Failure handling.** Nine independent sections (Suspense per section); a failed section never blanks the page.

**Security and abuse.** Cross-tenant 404 with identical bodies (existing). There is no parameter to lower k. Budget and measurement data are barred by boundary tests (REPO `seller-analytics/test/boundaries.test.ts`).

**Metrics.** KPI: dashboard weekly active sellers (Phase C). SLI: render p95 < 2 s for 5 parallel calls. Guardrail: zero numeric renders under `as_of === null` (tested per section).

**Acceptance.**
```gherkin
Scenario: production today
  Given every analytics report returns meta.freshness.as_of null
  When the owner opens Dashboard
  Then a single banner says "No data yet" and no tile, bar or table shows a number

Scenario: real zero
  Given sales returns orders 0 with as_of 5 minutes ago and within_slo true
  Then the Orders tile shows "0" with "Data as of {time}"

Scenario: impressions not published
  Given funnel data with views 1,200 and impressions 0 and as_of set
  Then the impressions step reads "Not measured yet" and no impression-to-view rate is shown

Scenario: suppressed terms
  Given 4 suppressed search terms
  Then the chart footer reads "4 terms hidden: fewer than 50 shoppers" and names none
```

**Role visibility.** Read: owner, manager, warehouse, support, finance (API `store_order`). Export: owner, manager. A dedicated `store_analytics` resource is D-ROLE-4.

**Blockers.** PA-SME (hard: store id), PA-PUB (any data), PA-UIWEB. Deltas and sparklines: PA-TS (Phase C).

**Copy keys** (in addition to the `analytics.*` keys in S2).
| Key | AR | EN |
|---|---|---|
| `analytics.pageNoData` | لا بيانات بعد. تبدأ الإحصاءات عند وصول أول الأحداث. لا شيء هنا يساوي صفراً؛ إنه غير مقيس. | No data yet. Analytics starts once the first events arrive. Nothing here is zero; it is not measured. |
| `analytics.notMeasuredStep` | غير مقيس بعد | Not measured yet |
| `analytics.hiddenCells` | {{n}} مخفية: أقل من 50 متسوقاً | {{n}} hidden: fewer than 50 shoppers |
| `analytics.includesSmall` | يشمل مجموعات صغيرة | Includes small groups |
| `analytics.needs50` | يحتاج 50 متسوقاً على الأقل | Needs at least 50 shoppers |
| `analytics.unavailable` | الإحصاءات غير متاحة مؤقتاً | Analytics temporarily unavailable |
| `analytics.markdownNotice` | لن يظهر السعر الجديد بخصم % ما لم يتم التحقق منه. | A new price will not show a % off unless it is verified. |
| `analytics.source.<CODE>` | الخلاصة، البحث، المنسّق، روابط مشتركة، إعلانات، صنّاع محتوى، متاجري | Feed, Search, Stylist, Shared links, Ads, Creators, My Stores |

---

### S6. Seller finance (`/finance`): mostly blocked, specified for honest states

**Flow.** Owner, manager or finance opens Finance: payouts list with a status stepper, the statement for a chosen period with a waterfall header, and e-invoices. The balance tiles stay blocked.

**Wireframe.**
```
Finance
Balance (available / pending / held)   "Not available yet" (no balance endpoint)
Payouts   cycle | amount | status stepper: Scheduled > Approved > Sent > Settled   (On hold / Failed shown as exceptions)
Statement 1 Sep - 30 Sep  [period]
 Opening 10,000 | + Merchandise 25,000 | - Commission 2,500 | - VAT on commission 350 | +/- Adjustments 0 | - Payouts 20,000 | = Closing 12,150
 (waterfall bars + table; lines table below)
E-invoices from Z-OUTLET   number | date | status (words) | ETA UUID <bdi>
```

**Rules.**
- Repoint the statement to `GET /v1/seller/stores/{id}/statements?from&to` (≤ 400 days; REPO `payouts.controller.ts:156-176`). It returns `{opening_balance, closing_balance, totals{merchandise, commission, vat_on_commission, adjustments, payouts, net}, lines[], payouts[]}`. The client's `/v1/seller/statements` call is removed (F-6).
- Balance tiles: `/v1/seller/balance` has no controller, so the tiles show `not_configured` "Balance not available yet", never zeros. Building balance is a Phase C money item, with a chief-reviewer checkpoint.
- Payout stepper from `status`. ON_HOLD shows "On hold" plus the D-PAYOUT-1 default text ("Contact seller support for details"); **no reason**, because `sellerPayoutWire` omits it by design (REPO `payouts/adapters/wire.ts:9`).
- The waterfall uses only the statement's own totals (no client arithmetic beyond the display order), and checks `opening + net = closing` before drawing; on mismatch it shows the table only and the "Figures do not add up; contact support" error (INFERENCE guard).
- VAT: the "VAT on commission" line is shown exactly as the statement provides it. No rate is printed and no VAT summary is derived (D-VAT-1, VR-PO-04).

**API.** `GET /v1/seller/payouts` (Yes), `GET /v1/seller/payouts/{id}` (Yes), `GET /v1/seller/stores/{id}/statements` (Yes), `GET /v1/seller/invoices` (Yes; `store_payout` read: owner, manager, finance). `/v1/seller/balance`, `/v1/seller/statements`: **no controller**.

**Acceptance.**
```gherkin
Scenario: no balance endpoint
  When a finance member opens Finance
  Then the balance area reads "Balance not available yet" and shows no amount

Scenario: payout on hold
  Given a payout with status ON_HOLD
  Then the stepper shows "On hold" and "Contact seller support for details" and no reason code
```

**Events, failure, security, metrics.** None new; sections fail independently; cross-tenant 404 (existing); guardrail: no zero balance is ever rendered.

**Role visibility.** owner, manager, finance.

**Blockers.** PA-SME; `/v1/seller/balance` (PA-OPENAPI, then a Phase C money build); D-PAYOUT-1.

**Copy keys.**
| Key | AR | EN |
|---|---|---|
| `sfinance.balanceUnavailable` | الرصيد غير متاح بعد | Balance not available yet |
| `sfinance.onHold` | معلّقة | On hold |
| `sfinance.onHoldHelp` | تواصل مع دعم البائعين للتفاصيل | Contact seller support for details |
| `sfinance.step.<STATE>` | مجدولة، معتمدة، مُرسلة، مُسوّاة، فشلت | Scheduled, Approved, Sent, Settled, Failed |
| `sfinance.opening` / `.closing` | الرصيد الافتتاحي / الرصيد الختامي | Opening balance / Closing balance |
| `sfinance.vatOnCommission` | ضريبة القيمة المضافة على العمولة | VAT on commission |
| `sfinance.notAddingUp` | الأرقام لا تتطابق؛ تواصل مع الدعم | Figures do not add up; contact support |

---

## 7. Build order, parallelisation and file conflicts

Tiers per the user's delegation table: **Builder** (Sonnet) for views and the small API additions; **Tester** (Sonnet) for the test plan; **Chief reviewer** (Fable) for the payout and ledger views (money), and before any change to D-PAYOUT-1 or role defaults.

| Step | Work | Depends on | Tier | Parallel with |
|---|---|---|---|---|
| B0 | Contract alignment: map PA-* labels to the Phase A spec; confirm the PA-INTEGRITY fields (section 2 checklist) | Phase A spec | Architect | none (first) |
| B1 | API additions B-1 (payout summary), B-2 (recon aging and rails), B-3 (tax `authority_checked`, range) with integration and negative-authz tests, plus OpenAPI entries | B0 | Builder | B2, B4 |
| B2 | Admin client and schemas: add payouts list/summary, recon summary/tickets/runs/files, integrity; **remove** `reconciliationBreaks` and the browser trial balance | B0 | Builder | B1 (schemas follow the OpenAPI from B1) |
| B3 | Shared: state vocabulary helpers (`no_data_yet`, `partial`, `roles_unknown`) and the five SVG primitives in `packages/ui-web` | PA-UIWEB scaffold | Builder | B1 |
| B4 | Seller wiring: call `/v1/seller/me`, store switcher, remove the `/v1/seller/store`, `/balance` and `/statements` calls, repoint statements | PA-SME decision D-ROLE-3 for nav only | Builder | B1, B2 |
| B5a | A1 Ledger health | PA-INTEGRITY, B2, B3 | Builder, then chief-reviewer | B5b-B5f |
| B5b | A2 Payouts | B1, B2, B3 | Builder, then chief-reviewer | |
| B5c | A3 Reconciliation | B1 (or interim), B2, B3 | Builder | |
| B5d | A4 Tax | B1 (B-3), B2, B3 | Builder | |
| B5e | A5 Privacy | B3 | Builder | |
| B5f | A6 KYC and suspensions | B3 | Builder | |
| B6 | A7 Home | PA-ME (hard), A1-A6 merged | Builder | S views |
| B7 | S1-S6 seller views | B4, B3 | Builder (one per view possible) | B5x |
| B8 | Test plan section 8 (real-API e2e, axe, visual baselines) | each view | Tester | per view |

**File-conflict flags** (two builders must not edit these at the same time; serialise or split as noted):
- `apps/admin-web/src/api/client.ts` and `api/schemas.ts`: one owner, step B2 only. Views consume, never edit.
- `apps/admin-web/src/i18n/ar.ts` and `en.ts` (a single typed catalog): the largest conflict risk. Proposal: each view adds its keys in one contiguous block named after its prefix, merged by one builder per day. Or split the catalog into per-area modules merged into the typed record, if the `MessageKey` derivation allows it (not verified). The seller app already has split files.
- `apps/admin-web/src/view-models/nav.ts` and `app/(console)/layout.tsx`: new Money sub-routes (`/finance/ledger`, `/finance/payouts`, `/finance/reconciliation`). One builder (B2).
- `apps/admin-web/src/app/styles.ts` and `apps/seller-web/src/styles/tokens-css.ts`: to be replaced by `packages/ui-web` (Phase A). Phase B must not add new classes there; use ui-web.
- `apps/seller-web/src/api/client.ts`, `components/Shell.tsx`, `page-context.ts`: step B4 only.
- `tooling/e2e/gateway.mjs`: Phase A may change its `/v1/admin/me` fake; coordinate before adding the real-API project (section 8).
- `docs/api/openapi.yaml`: B1 adds three entries. Phase A's PA-OPENAPI deletes or fixes others; rebase carefully.
- `apps/admin-web/src/app/(console)/finance/page.tsx`: split into A1/A2/A3 pages; B5a owns the split, and B5b and B5c start after it.

---

## 8. Test plan

**Negative authorization (API).** For every route used and every route added: a shopper token gets 401/403; a seller token on admin routes 401/403; an admin without the role 403 (with the access-audit deny row asserted); seller A on store B's resources 404 with a body identical to a missing id. New routes B-1 to B-4 each get the role matrix (finance, ops, support, dpo, security, super_admin standing-only) as a table test, extending `apps/api/src/authz-matrix.test.ts`. Audit-unavailable: each gated read returns 503 `audit_unavailable` when the sink throws on allow.

**Unit (web view-models, vitest).**
- R-NODATA: for each section mapper, `as_of null` gives no numeric output; stale; real zero.
- Clocks with a fixed server time and an elapsed timer: breach thresholds (24 h, 12 h, 0), DSAR buckets, suspension buckets, the order countdown with a skewed device clock, and DST days (last Friday of April, last Thursday of October) for Cairo-day labels.
- Caps: "50+", "200+", "at least N", "not totalled".
- Tax: the "Reconciled" badge appears only with both flags true.
- Recon: the 72 h boundary (exactly 72 h is not overdue; 72 h + 1 s is).
- Statement waterfall: `opening + net == closing`, using bigint.
- Copy: no raw enum reaches a rendered string (map every enum value; a test fails on an unmapped value).

**E2E (Playwright) with the real-API posture.** Add a project `dashboards-real` where `tooling/e2e/gateway.mjs` fixture answers are **off** for every route these views call, so requests reach the API (PGlite or Postgres 16) seeded through application use cases (orders placed via the checkout fakes, payouts scheduled by the cycle command, tickets via reconciliation runs, breaches via the DPO route). No SQL inserts into business tables, so state machines stay valid (INFERENCE). Run two identities: (1) with `/v1/admin/me` really absent (today), asserting `roles_unknown`, writes disabled and A7 hidden; (2) after PA-ME, per role. Cases per view: the acceptance scenarios above, `no_data_yet` for production-like composition (analytics source Unconfigured, ETA Unconfigured, rails Unconfigured), offline (route abort) with countdowns paused, and 403 direct URL.

**Accessibility.** The existing `checkPage` on every new route and state (axe wcag2a/aa/21a/21aa/22aa failing on serious or critical; CSP nonce present and zero violations; dir and computed direction; no horizontal overflow at 390 px; Tab reaches main). Plus: each chart has a `figure` with `figcaption`, a reachable "View as table" toggle, and a table with `th scope`; status never relies on colour (a test that strips colour from tokens and asserts the icon and text remain); reduced motion.

**Visual baselines.** Record and commit baselines (currently opt-in and empty, REPO `docs/engineering/visual-regression.md`) for every view in AR and EN × light and dark × desktop 1440 and mobile 390, in states ready, no_data_yet, stale, error and partial. Run in CI behind PA-BUDGET once Phase A turns the visual project on; until then run locally with `E2E_VISUAL=1` and attach the diffs to the PR.

**Copy and i18n.** Parity tests (AR before EN), `tooling/copy-lint` (no hard-coded social proof, no developer text), and an Arabic review pass of the keys in this spec before ship.

**Money review.** A1, A2 and S6 go to the chief reviewer before merge (user rule: money views).

---

## 9. Owner and counsel decisions these views must not pre-empt

Each has a safe default that the views implement now. All are **Proposed**; none is decided by this spec.

| Id | Decision | Safe default implemented | Who | Record |
|---|---|---|---|---|
| D-PAYOUT-1 | What sellers see when a payout is on hold: the reason, a reserve-style hold amount, the next date, and how negative-balance netting is displayed | Seller sees "On hold" plus "Contact seller support for details"; no reason, no reserve amount (the API already omits them). Admin sees reasons. | Owner, finance counsel | ADR extending ADR-0021; new row VR-DB-02 |
| D-VAT-1 | VAT presentation on seller and admin finance views (rates printed, VAT summaries, VAT base for platform-funded discounts) | Show only VAT lines the API returns, labelled exactly ("VAT on commission"; "Gross as issued (incl. VAT)"; "Spend excludes VAT"). No derived VAT totals or rates. | Tax counsel | Existing VR-06 and VR-PO-04 (not duplicated) |
| D-ROLE-1 | Security role reading ledger integrity tiles | Finance only (matches the ledger gate today) | Owner | ADR; role matrix |
| D-ROLE-2 | Ops seeing Money in the nav (the API already allows ops to read payouts and reconciliation) | Nav unchanged (finance only); a direct URL works for ops read-only because the API allows it | Owner | ADR; VR-AC-05 note |
| D-ROLE-3 | Seller role vocabulary: web `fulfilment` versus policy `warehouse`; web lacks `support` | Seller nav stays unfiltered (today's behaviour) until mapped; the API enforces access | Owner | ADR; update `TeamRole` or `BRAND_ROLES` |
| D-ROLE-4 | A dedicated `store_analytics` seller resource instead of reusing `store_order` read | Keep `store_order` read (support and finance see analytics) | Owner | ADR (seller-analytics spec "Gaps") |
| D-TIME-1 | Seller analytics day boundary: UTC (as the API snaps) or Cairo | UTC with a visible caption | Owner, Arabic UX reviewer | Small ADR |
| D-TIME-2 | Time-axis direction in RTL charts (needed in Phase C) | Not used in Phase B; aging buckets run youngest to oldest in reading direction | Arabic UX reviewer | Small ADR |
| D-THRESH-1 | Breach-clock colour bands (24 h amber, 12 h red) | As stated, always with text and icon | DPO | Note in the DPO runbook |
| D-THRESH-2 | KYC NEEDS_INFO aged flag (5 days) and payout ON_HOLD aged flag (7 days) | As stated | Owner, ops | Config with audit (later) |
| D-THRESH-3 | Seller order warning threshold | Keep the existing 2 h (`SLA_WARNING_MS`) | Owner | none |
| D-THRESH-4 | Minimum sales for ranking return rate (5) | As stated | Owner | none |
| D-ALERT-1 | ETA reject-rate (> 1%) and queue-age (> 24 h) attention triggers | As stated | Finance, tax | none |
| (existing) | DSAR statutory deadline | 30 days, labelled "to be confirmed" | DPO, counsel | VR-01 |
| (existing) | Automatic suspension without prior human review | Labelled automatic; review within 5 business days | Counsel | VR-15 |

---

## 10. Gaps this spec records (not built in Phase B)

| Id | Gap | Where it bites |
|---|---|---|
| G-ADS-1 | The ads report has no attribution-status field; `attributed_revenue` 0 is ambiguous while attribution is `internal.wiring` | S3 |
| G-NAMES | Analytics rows have no product names; the server render joins through the catalog | S2, S5 |
| G-CONSENT | No consent-statistics or transfer-register endpoint | A5 |
| G-STATE-TS | No `state_entered_at` for payouts or KYC; ages are "since last change" | A2, A6 |
| G-SELLER-BAL | `/v1/seller/balance` has no controller | S6 |
| G-ADMIN-SELLERS | `/v1/admin/sellers` has no controller; admin views show store short ids | A2, A3 |
| G-UPHOLD-IDEM | `POST …/suspension-reviews/{id}/uphold` has no `@Idempotent` decorator, unlike its siblings | A6 (check, likely safe) |
| G-SUBJREF | The DSAR `subject_ref` is an unsalted SHA-256 of the user id (`subj_` plus 24 hex, REPO `privacy/adapters/wire.ts:61`), so anyone holding user ids can link it back. Acceptable for the DPO-only view; a keyed HMAC would be stronger. DPO to decide | A5 |
