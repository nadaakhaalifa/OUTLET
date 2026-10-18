# Ops and observability consoles: reusable patterns for a platform-owner Admin Console

Labels: DOCUMENTED = fetched from the cited URL. INFERRED = my synthesis. Spec targets come from /Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md (sections 23, T8, T9, T10, T4), which was already in context.

Spec targets (DOCUMENTED, local spec): checkout success >= 99.5% (28d); reserve tx p95 < 150 ms; webhook to PAID p95 < 5 s; read API p95 < 300 ms; search p95 < 150 ms; crash-free sessions >= 99.8%; refunds initiated within 24h >= 99%; unmatched PSP lines older than 3 days = 0. Spec also requires multi-window burn-rate alerting (1h/5m, 6h/30m), a feature freeze when the error budget is exhausted, a 48h release freeze before mega events, DORA on the Admin dashboard, and SCI plus cost per order (FinOps).

## 1. SLO dashboards, error budgets, burn-rate alerting, status pages, incidents, on-call

### Takeaway
Show each SLO as a row with SLI, target, remaining budget, and current burn rate, and alert with multiwindow multi-burn-rate rules. Datadog, Grafana and Honeycomb confirm the budget and burn-rate views. Status-page and on-call features are only thinly documented in what I could fetch.

### Cited Findings
- The SRE Workbook recommends, for a 99.9% SLO: page at burn rate 14.4 (long 1h, short 5m, 2% budget consumed); page at burn rate 6 (6h/30m, 5%); ticket at burn rate 1 (3d/6h, 10%). — [Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/)
- "A good guideline is to make the short window 1/12 the duration of the long window." The short window confirms the budget is still burning, which cuts false positives and speeds reset. — [Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/)
- The workbook compares six approaches. Multiwindow multi-burn-rate is the most recommended (good precision, recall and reset). Its cost is many parameters that are hard to manage. Plain burn-rate alerting has low recall: a 35x burn never alerts yet drains a 30-day budget in 20.5 h. Alert-duration (`for`) clauses are not recommended. — [Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/)
- Datadog: error budget = 100% minus target. The SLO list can be sorted by "Error Budget Left". Burn-rate icons use a rolling 2h window: red above 6, yellow between 1 and 6, and the list is filterable by Critical/Elevated/Healthy. The side panel holds status history, Corrections and Audit History tabs. Rolling windows are 7, 30 or 90 days. SLO and SLO List widgets embed in dashboards. A 100% target is invalid (no budget). — [Datadog SLO docs](https://docs.datadoghq.com/service_management/service_level_objectives/)
- Datadog types: metric-based (good/total events), monitor-based, and time-slice. — [Datadog SLO docs](https://docs.datadoghq.com/service_management/service_level_objectives/)
- Grafana Cloud SLO: the dashboard shows burn rate, error budget and SLI results. Alert rules are configured per SLO. Maintenance windows pause budget consumption and burn-rate alerting. — [Grafana SLO docs](https://grafana.com/docs/grafana-cloud/alerting-and-irm/slo/)
- Honeycomb: "Budget Burndown" shows the remaining budget in the window (example: 550 failed events in 30 days at 99.9% leaves 45%). Burn alerts go to PagerDuty, Slack, Teams, webhooks or email. The SLO heatmap plus BubbleUp points to the cause of violations. Tags organise SLOs by team/service. — [Honeycomb SLO docs](https://docs.honeycomb.io/notify/alert/slos/)
- Sentry release health defines crash-free sessions (share of sessions with no crash) and crash-free users. Session statuses are Abnormal, Crashed, Errored, Healthy, Unhandled. Adoption stages use a 10% threshold (Adopted, Low Adoption, Replaced). Crash-rate monitors alert below a threshold. — [Sentry release health](https://docs.sentry.io/product/releases/health/)
- PagerDuty (secondary, third-party sources only): responders can hold roles such as Incident Commander, Scribe and Internal Liaison. The incident log records triggered, acknowledged, notes, escalations and resolved. A status-page incident timeline runs investigating, monitoring, resolved. — [DevGenius guide](https://blog.devgenius.io/pagerduty-101-the-ultimate-guide-for-first-time-site-reliability-engineers-c8864dceebf0), [Pingoru mirror](https://pingoru.io/providers/pagerduty)

### Inferences
- INFERRED SLO table for the Admin Console, one row per spec SLO: SLI value, target, budget remaining (%), 1h and 6h burn rate, status chip, sparkline. Default sort by budget remaining ascending, as in Datadog.
- INFERRED: the spec's 28-day checkout window works with the workbook's 30-day table. The 14.4 / 6 / 1 thresholds are budget-fraction based, so they port to 99.5% unchanged, but the budget is 10x larger than at 99.9%, which makes alert volume lower than at 99.9%. Verify before adoption.
- INFERRED: latency SLOs (reserve, search, webhook-to-PAID) need a "good event = request under threshold" definition so the same burn math applies.
- INFERRED: "unmatched PSP lines older than 3 days = 0" is a zero-tolerance count, not a ratio. Show it as a count tile with an aging histogram. It has no budget, so any non-zero value should alert immediately.
- INFERRED: the spec's "budget exhausted means feature freeze" should appear as a banner and a deploy-gate state on the SLO page.
- INFERRED: show planned maintenance and game-day windows as annotations (Grafana pauses budget consumption in maintenance windows).

### Gaps
- Datadog's burn-rate alert configuration and any public status-page feature were not described in the fetched page.
- Grafana's panel layout and fast/slow rule details, and Honeycomb's alert types (exhaustion time vs budget rate), were not in the fetched pages.
- PagerDuty's own documentation on status pages and incident timelines was not retrieved (the support.pagerduty.com redirect was not followed); only third-party descriptions. On-call schedule UI details: not found.

## 2. DORA dashboards and DevEx

### Takeaway
DORA now has five metrics, split into throughput and instability, and the official guidance warns against targets, cross-team blending and single-metric views. Visualise trends per service, not leaderboards.

### Cited Findings
- Throughput: change lead time (commit to production), deployment frequency, failed deployment recovery time. Instability: change fail rate (deployments needing immediate intervention such as rollback or hotfix) and deployment rework rate (unplanned deployments resulting from a production incident). — [dora.dev](https://dora.dev/guides/dora-metrics-four-keys/)
- The page gives no tier thresholds. It says top performers do well on all five and speed and stability are generally correlated. — [dora.dev](https://dora.dev/guides/dora-metrics-four-keys/)
- Use at application/service level; use several metrics together; share ownership across dev, ops and release; treat as leading and lagging indicators. — [dora.dev](https://dora.dev/guides/dora-metrics-four-keys/)
- Pitfalls: metrics as goals (Goodhart), a single metric, disparate comparisons, blending across teams, siloed ownership, competing between teams, measurement over improvement. — [dora.dev](https://dora.dev/guides/dora-metrics-four-keys/)

### Inferences
- INFERRED: spec T11 targets (deploy daily, lead time < 1 day, CFR < 15%, recovery < 1h) are not in the cited DORA page, which gives no thresholds; treat them as the spec's own goals. Display them as reference lines, not as pass/fail scoring, to stay consistent with the anti-Goodhart guidance.
- INFERRED honest visualisation: show median and p85 or the distribution for lead time and recovery (not mean only), include the sample size, display the five metrics together with throughput and instability in one view, separate by service, and annotate incidents and freezes. Do not rank teams.
- INFERRED: the spec's wording "rework rate" matches DORA's deployment rework rate definition above.

### Gaps
- DevEx (developer experience) guidance: not retrieved; no source fetched on DevEx frameworks or surveys.
- DORA's published benchmark tiers: not found on the fetched page.

## 3. Queue, outbox, DLQ, webhook replay, jobs, reconciliation, ledger integrity, chaos readiness

### Takeaway
No vendor source gave a ready dashboard spec for these. The patterns below are mostly inference from the spec and general reconciliation practice; only reconciliation statuses have a documented analogue.

### Cited Findings
- Stripe transaction reconciliation classifies records as Settled (amounts match within a threshold), In process (difference beyond threshold), Open (your record has no Stripe counterpart), Foreign (Stripe record missing from your data). — [Stripe docs](https://docs.stripe.com/reconciliation/transaction-reconciliation)
- A vendor reconciliation workspace tracks ingestion status, unmatched transactions, review-queue depth, unreconciled payouts and last successful sync (vendor product page, not Stripe's own). — via search result, [Ecosire](https://ecosire.com/apps/dynamics-365-finance-operations/d365fo-stripe-payments-connector)
- Spec T4 requires nightly reconciliation (PSP files vs psp_clearing, courier COD, BNPL, ETA, store-credit projections), a trial balance of 0, a verified journal hash chain and a daily signed snapshot (DOCUMENTED in the local spec). Spec T9 lists chaos tests (PSP down, search down, Redis down, courier down, LLM down), RPO <= 15 min, RTO <= 1h, monthly restore drills.

### Inferences
- INFERRED outbox/queue panel: outbox lag (oldest unpublished row age), relay throughput, per-consumer inbox lag, retry counts, DLQ depth and oldest age, with a "replay" action gated by maker-checker for money-related queues.
- INFERRED webhook panel per provider: received vs signature-failed vs deduped vs processed, event-to-state latency p95 (feeds the 5 s SLO), replay by event ID, raw-body viewer with PII masking.
- INFERRED job/cron panel: last success time, duration, next run, failure streak, with the sweeper (30 s) and nightly purge/recon jobs as first-class rows and a missed-run alert.
- INFERRED integrity panel: trial-balance value (must be 0), last hash-chain verification time and result, projection drift count, reconciliation matches by status using the Settled/In process/Open/Foreign vocabulary plus aging buckets (0-1d, 1-3d, >3d).
- INFERRED game-day readiness: checklist with last chaos run date per dependency, last restore drill result and measured RTO/RPO versus targets, status of kill switches, pre-scale plan, on-call staffed. Colour by staleness.

### Gaps
- Stripe's own engineering material on ledger dashboards: not found (search returned only third-party guides).
- Google/AWS game-day guidance: one Microsoft URL returned 404; no chaos/game-day source retrieved.
- Outbox/DLQ dashboard references from Datadog/Grafana: not retrieved.

## 4. FinOps and carbon (SCI / ISO 21031)

### Takeaway
SCI is a rate: carbon per functional unit, with the spec's choice of "one completed order". FinOps source pages fetched were too thin to cite metric definitions.

### Cited Findings
- SCI = C per R; expanded (O + M) per R; O = E x I; M = TE x TS x RS. E is energy in kWh and should include provisioned (reserved) hardware, not just used. I is region-specific grid intensity (gCO2eq/kWh), market-based measures excluded. R should describe how the application scales, used consistently across components; options include transaction, API call, user, batch job. — [SCI spec](https://sci.greensoftware.foundation/)
- FinOps Framework lists "Unit Economics" and "KPIs & Benchmarking" under Quantify Business Value, and the journey as Inform, Optimize, Operate; no formulas on that page. — [FinOps Framework](https://www.finops.org/framework/)

### Inferences
- INFERRED panels: gCO2e per order trend split into E x I and M components, so a change can be attributed to code efficiency versus grid intensity; cost per order and cost per 1k sessions on the same time axis; per-LLM-feature cost versus budget (spec T10).
- INFERRED: label estimates with their method and data source, since the spec says no carbon claims without a methodology page, and MENA grid intensity is a spec VERIFY item.
- INFERRED: browsing is a different scaling unit than orders, so keep "per 1,000 sessions" as a second SCI series, as the spec already does.

### Gaps
- ISO/IEC 21031:2024 status: not confirmed on the fetched SCI spec page (it does not mention it). The spec cites a GSF article for this; not re-fetched.
- FinOps unit-cost formulas and Green Software Foundation dashboard guidance: not found.

## 5. Ops-console UX patterns (search, entity pages, approvals, flags, saved views, alert routing)

### Takeaway
Documented evidence covers audit logging (Retool), alert delivery and admin-managed alerts (Metabase), and flag kill switches and rollouts (PostHog). Entity pages, maker-checker, break-glass and reason-code patterns are mostly not sourced and are inference from the spec.

### Cited Findings
- Retool audit logs are admin-only and capture query runs, page views, logins, invites and permission modifications; entries show actor and time, and admins can see queries, parameters and IP. On Retool Cloud, logs are kept one year. A community report says some permission-group changes were not logged, and workflows run as an admin role so attribution can be wrong. — [Retool docs](https://docs.retool.com/docs/audit-logs), [Retool logged events](https://docs.retool.com/org-users/reference/logged-events), [Retool community](https://community.retool.com/t/audit-logs-workflow-runs-ownership/66071)
- Retool approval workflows for access requests: not found in search.
- Metabase alerts run on a schedule and fire when a question returns results or crosses a goal; they deliver to email, Slack or webhooks (webhooks need admin/settings access). Users edit only their own alerts; admins manage all in Monitor > Alerts management. Dashboard subscriptions are the route for sending dashboards. — [Metabase alerts](https://www.metabase.com/docs/latest/questions/alerts)
- PostHog feature flags support release conditions by person property, cohort or group, gradual rollout (e.g. start at 1%), and kill-switch use without a redeploy. Staleness, approvals and activity log were not covered on the fetched page. — [PostHog feature flags](https://posthog.com/docs/feature-flags)
- Datadog SLO side panels expose Audit History and Corrections tabs, an example of per-object audit on the entity page. — [Datadog SLO docs](https://docs.datadoghq.com/service_management/service_level_objectives/)
- Honeycomb tags organise SLOs by team/service (filterable view). — [Honeycomb SLO docs](https://docs.honeycomb.io/notify/alert/slos/)

### Inferences
- INFERRED entity page layout (order, user, seller, payout): header with state-machine status, left timeline merging domain events, outbox events, ledger postings, courier and PSP events, and audit entries, right panel with allowed actions per state. Every action shows the approval requirement before the click.
- INFERRED global search: one box that resolves IDs by prefix (order group, seller order, AWB, PSP ref, payout, phone hash) and returns typed result groups. PII lookups require the reason code that spec section 23 mandates.
- INFERRED maker-checker: bulk action produces a preview and dry-run diff, a proposer cannot be the approver, approvals expire, and the executed result is linked back to the audit entry. The spec requires dual approval for payouts, refunds, plan price changes, role grants and exports.
- INFERRED break-glass: time-boxed elevation with mandatory reason, a persistent banner while active, auto-revoke, and a post-use review item.
- INFERRED flag/kill-switch panel (OpenFeature): list each kill switch the spec names (each payment method, BNPL, COD, drops, games, stylist LLM, ML ranking, crawlers, referral payouts, gift-card sales) with state, last change, actor, reason, linked runbook. Changes need a reason and, for money paths, approval. OpenFeature is a vendor-neutral API, so the Admin Console would write through the chosen provider's own management API; verify the provider.
- INFERRED saved views: per-role default views (Ops, Finance, SRE) stored server-side; alert routing table mapping SLO or alert to owner team and channel, similar to Honeycomb's PagerDuty/Slack targets.

### Gaps
- OpenFeature documentation: both fetches failed, so no OpenFeature claims are cited here.
- Looker patterns: not researched (no tool calls spent).
- Retool/Metabase/Looker internal-tool UX conventions beyond audit logs and alerts: not found.
- PostHog flag approvals, audit log, stale-flag handling: not on the fetched page.

## 6. Mega-event war room

### Takeaway
No vendor source gave a war-room layout, so this is inference from the spec and the SLO sources above.

### Cited Findings
- Spec section 23 lists the war-room signals: traffic, errors, checkout success, stock-outs, PSP health, queue depth. Spec T8 requires a release freeze 48h before mega events plus a game day, and T9 requires k6 at 20x baseline. — local spec
- Burn-rate colour thresholds (red above 6, yellow 1 to 6) come from Datadog and can be reused for tiles. — [Datadog SLO docs](https://docs.datadoghq.com/service_management/service_level_objectives/)

### Inferences
- INFERRED single-screen layout: top row of SLO tiles (checkout success, reserve p95, webhook to PAID p95, search p95, crash-free) with burn rate; second row: traffic and waiting-room queue depth with admission rate; third row: per-PSP success rate and latency with failover and kill-switch state; fourth row: stock-outs and drop sell-through, outbox lag and DLQ, intraday reconciliation unmatched lines; right rail: incident timeline, who is on call, active freezes and flags.
- INFERRED: 1-minute refresh with a visible "data as of" stamp, since stale data in a war room is dangerous; use the same colour semantics everywhere.

### Gaps
- No documented war-room dashboard examples from Datadog, Grafana, PagerDuty or others were found in this pass.

## Research limits
About 22 tool calls were used. Several fetches failed or returned thin pages (OpenFeature x2, PagerDuty support page not followed, Microsoft game day 404). Looker and Honeycomb alert-type detail were not covered.
