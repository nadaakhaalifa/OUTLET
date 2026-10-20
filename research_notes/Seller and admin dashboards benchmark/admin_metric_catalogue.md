# Platform owner / admin metric catalogue and admin console IA (Z-OUTLET)

Label key: DOCUMENTED = external URL; REPO = file path read in this repo; INFERENCE = my design choice. All money in integer piastres (BIGINT, spec A2.4); percentages computed as integer basis points (bps) unless noted. "Exists?" values: YES (data + read path), DATA-ONLY (events/tables but no admin read endpoint), SPEC (spec only), NO.

Repo grounding caveat: I inspected module directory listings, the admin controller route list, nav.ts, status doc, and targeted greps (about 12 repo calls). "Exists?" is based on that; each row says how confident. No code was run.

## 1. What do documented benchmarks (Stripe, Shopify, DORA, SRE) say about metric definitions and chart choices?

### Takeaway
Definitions to copy: Stripe's subscriber-level churn (churned when MRR goes non-zero to zero; 30-day window), Shopify's first-order-month cohort retention view, DORA throughput/stability pairs, and SRE multi-window burn-rate alerting. Two documented gaps: Shopify has no confirmed native funnel report, and the DORA site itself could not be fetched.

### Cited Findings
- Stripe churn: a subscriber counts as churned only when MRR drops from non-zero to zero; rate = churned subscribers in past 30 days / (active subscribers 30 days ago + new subscribers in the window) — [Stripe support](https://support.stripe.com/questions/calculating-subscriber-churn-rate-in-billing) (surfaced via search summary; page not fetched in full)
- Stripe MRR decomposes into new, expansion, churn components — [Stripe MRR explainer](https://stripe.com/resources/more/what-is-monthly-recurring-revenue)
- Shopify customer cohort report groups customers by first-order month and toggles retention rate / gross sales / amount spent per customer; basic CLV = (avg purchase value x purchase frequency) x avg lifespan, with a margin-based variant subtracting COGS, shipping, acquisition cost — [Shopify cohort retention](https://www.shopify.com/blog/cohort-retention-analysis), [Shopify CLV](https://www.shopify.com/blog/customer-lifetime-value-analysis)
- No official confirmation of a native Shopify funnel report found; funnels appear in third-party apps — search result summary (see [Lifetimely](https://apps.shopify.com/lifetimely-lifetime-value-and-profit-analytics))
- DORA: deployment frequency, lead time, change failure rate, recovery time (throughput vs stability); a fifth "deployment rework rate" is reported by secondary sources — [Google Cloud Four Keys](https://cloud.google.com/blog/products/devops-sre/using-the-four-keys-to-measure-your-devops-performance), [TeamRetro](https://www.teamretro.com/guides/agile-metrics/dora-metrics/). The spec A2.14 already lists rework rate (REPO `docs/haul-master-prompt-v3.md`).
- SRE burn-rate alerting: page when both a long and short window exceed threshold; commonly cited tiers 14.4x over 1h (5m short), 6x over 6h (30m short), ticket at 1x over 3d (6h short); the short window stops alerts firing after budget is no longer burning — [SRE Workbook](https://sre.google/workbook/alerting-on-slos/) (tier numbers from secondary summaries, window pairs vary by source)

### Inferences
- INFERENCE: Plus churn should use Stripe's subscriber-level definition on `subscriptions` status transitions; treat `PAUSED` as not churned, `CANCELLED_AT_PERIOD_END` as churn at `period_end` (configurable, as Stripe lets you choose timing, per a ~1,000-day-old third-party guide, so verify).
- INFERENCE: build the conversion funnel ourselves from the typed events (REPO `packages/analytics/src/analytics-events.ts`); do not expect a vendor pattern.

### Gaps
- Could not fetch dora.dev or Stripe Dashboard pages directly (WebFetch not used; search summaries only). Stripe Dashboard chart types not verified.
- No documented benchmark for marketplace "attention needed" queues found; the home queue design is INFERENCE.

## 2. Metric catalogue (build-from table)

Conventions. Windows: D=day, W=week, M=month, T=trailing. Cairo timezone (Africa/Cairo) day boundaries (spec §17). Freshness: RT = under 1 min, NRT = under 15 min (matches seller analytics SLO, spec §19.1), Daily = nightly batch. Privacy class: P0 public, P1 internal, P2 personal, P3 sensitive (spec A3). All metrics aggregate unless "entity" noted. Small cells: suppress groups with n < 50 when slicing by demographic or governorate x seller (INFERENCE, mirrors k >= 50 in spec §10/§19.1).

Warehouse note: spec §23/§26 assume ClickHouse + dbt. REPO: a grep for "clickhouse" in `apps`/`packages` returned no usable result (shell glob error; not confirmed absent). `docs/specs/admin-console-web.md` says admin app loads no analytics SDK and metrics are "emitted by the API audit stream". Treat the warehouse as SPEC until proven.

### A. Commerce and revenue

| # | Metric | Question | Definition / formula (piastres) | Grain, windows | Fresh | Chart and why | Drill-downs | Alert | Priv | Exists? |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | GMV | How much value is shoppers buying? | sum(order_lines.unit_price*qty - discount_alloc) over SellerOrders with status in PAID/CONFIRMED_COD..CLOSED, VAT-inclusive, gross of returns; report GMV-placed and GMV-net-of-returns separately | Day; D/W/M, YoY by Hijri-aware events | NRT | Line + prior-period overlay; shows trend and seasonality (Eid, White Friday) | store, category, world (local/global), payment method, governorate, drop vs non-drop | D/D-7 drops below -30% for 2h (non-event) | P1 | DATA-ONLY. REPO `apps/api/src/modules/orders`, `checkout` hold lines; no admin aggregate route seen |
| A2 | Net revenue | What does HAUL itself earn? | commission + fees + ads + Plus + shipping_revenue, ex-VAT. From ledger: sum of credits to `platform_commission`, `shipping_revenue`, `plus_revenue`, ad revenue accounts minus refunds (spec T4) | Day, M | Daily (ledger-true), NRT estimate | Stacked column by revenue stream; composition matters | stream, store, plan | M-o-M -20% | P1 | PARTIAL. REPO `modules/ledger` (accounts, postings); no summary endpoint seen |
| A3 | Take rate | What share of GMV do we keep? | net_revenue_bps = 10000 * net_revenue / GMV (integer bps) | M; by store/category | Daily | Line with GMV bars secondary axis; reveals mix shift | store, category, commission surcharge | below floor set by Finance for 7d | P1 | DATA-ONLY (derivable); `commission_rate_snapshot` on seller_orders per spec §7 |
| A4 | Contribution margin per order (CM/order) | Is each order profitable? | CM = net_revenue_allocated - shipping_cost_net - psp_fee - promo_expense_platform - refund_cost - cod_rto_cost - payment_failure_cost; divide by completed orders. Every term an integer piastres posting (accounts `psp_clearing`, `promo_expense_platform`, `refund_reserve`, `cod_clearing` per T4) | Order -> day/week/M; cohort of orders | Daily | Waterfall (GMV-to-CM bridge) for one period + line of CM/order over time; waterfall shows which cost eats margin | payment method, COD vs prepaid, governorate, courier, store, promo | CM/order < 0 for any category-week; COD CM < 0 | P1 | PARTIAL. Ledger accounts exist (REPO `modules/ledger`, spec `docs/specs/ledger-chart-of-accounts.md`); shipping cost and RTO cost postings need courier remittance port (status doc: courier contracts open). Treat as NO until RTO cost posting verified |
| A5 | Conversion by step | Where do shoppers drop? | Unique-user funnel: product_viewed -> add_to_bag -> checkout_started -> payment_selected -> order_placed -> order paid; rate = n(step k)/n(step k-1), sessions and users | Day/W; by platform, new/returning, world | NRT (events) | Funnel bars (horizontal) with step-rate labels; sequential drop-off is the question | method, 3-DS drop-off, store, device | checkout success < 99.5% (SLO, spec §7) burn-rate page | P1 (pseudonymous) | DATA-ONLY. REPO `packages/analytics/src/analytics-events.ts`, `docs/analytics/events.md`; consent-gated so under-counted for non-consenting users (state this on chart) |
| A6 | AOV | Basket value? | GMV-placed / orders (OrderGroups); also median | D/W | NRT | Line + distribution histogram (mean is skewed) | store count in bag, Plus vs non | n/a (guardrail via free-delivery A/B) | P1 | derivable |
| A7 | Items per order | Basket depth | sum(qty)/OrderGroups | D/W | NRT | Line | same | n/a | P1 | derivable |
| A8 | Multi-store bag rate | Is "one bag" working? | OrderGroups with >= 2 SellerOrders / OrderGroups | D/W | NRT | Line + stacked 1/2/3+ stores share | world, free-delivery unlock | drop > 25% w/w | P1 | derivable (order_group -> seller_orders, spec §7) |
| A9 | Stylist-driven GMV | Does the AI stylist pay back? | GMV of lines whose `source`=stylist outfit within 7d attribution (cart_lines.source, spec §6) | W | Daily | Line + share-of-GMV | outfit size, multi-store outfits, budget | n/a; LLM cost circuit breaker separate | P1 | PARTIAL. Event `stylist_outfit_generated`, `outfit_added_to_bag` in analytics-events.ts; `cart_lines.source` per spec; REPO `modules/stylist` |
| A10 | Cohort retention D1/D7/D30/M3 | Do shoppers come back? | cohort = first-order (or first-open) date; retention(d) = users active/ordering on day d / cohort size; also first-order-month revenue retention | Cohort day/week | Daily | Triangular heatmap (cohort x age) + selected-cohort lines; Shopify uses the same cohort view (DOCUMENTED above) | acquisition channel, world, first-payment method, Plus | D30 order retention -15% relative vs trailing 8 cohorts | P1 | DATA-ONLY (needs warehouse) |
| A11 | Repeat rate | Share with >= 2 delivered orders in 90d | repeat_customers_90d / purchasers; north star "90-day repeat" (spec §0) | M | Daily | Line | channel, category | below target set by product | P1 | derivable |
| A12 | LTV by channel | What is a customer worth by source? | cumulative CM (not revenue) per cohort customer at 90/180/365d, by first-touch channel (organic, referral, creator, ads, WhatsApp) | Cohort x channel | Daily | Line of cumulative CM per customer per channel (curves show payback crossing CAC) | channel, creator, referral code | LTV90/CAC < 1 | P1 | NO for channel attribution (referral/creator modules exist, REPO `modules/referrals`, `creators`; creators NOT composed in production per status doc) |
| A13 | CAC | Cost to acquire | channel spend (ads, creator commissions, referral credit, promo first-order) / new purchasers | M | Daily | Column per channel | channel | CAC > 60% of LTV90 | P1 | NO (spend inputs mostly absent) |
| A14 | CAC payback | Months to recover CAC | months until cumulative CM per cohort customer >= CAC | Cohort | Daily | Cumulative-curve with CAC line | channel | > 6 months | P1 | NO |

### B. HAUL Plus, budget

| # | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| B1 | Plus penetration | active+grace members / MAU purchasers (users with >= 1 order in 90d); by plan | Line + plan stack | n/a | PARTIAL. REPO `modules/subscriptions`; admin page `apps/admin-web/src/app/(console)/plus` exists but spec `docs/specs/admin-console-web-phase2.md` says pause/cancel metrics are "not measured" (no read endpoints) |
| B2 | Trial -> paid conversion | converted within trial_end+3d / trials started (cohorted by start week) | Cohort bars | < baseline -20% | DATA-ONLY (states TRIALING->ACTIVE per spec §14) |
| B3 | Plus churn | Stripe-style subscriber churn (see §1): churned in 30d / (active 30d ago + new) ; voluntary vs involuntary (dunning day 1/3/7) split | Line + stacked reason | monthly churn > 8% (INFERENCE, tune) ; involuntary > 3% | DATA-ONLY |
| B4 | Savings delivered vs fee | per active member median(sum plus_savings_ledger) / fee paid; target >= 2x (spec §14) | Distribution (box/histogram) + median line; median hides the tail so show p25/p50/p75 | median < 2x | DATA-ONLY (`plus_savings_ledger` per spec) |
| B5 | Budget feature impact (AGGREGATE ONLY) | adoption = users with budget / MAU; return rate and 90d retention of budget users vs matched control; share under budget | Paired bars (treated vs control with CI) | n/a | SPEC. Privacy: P3 financial-behavior; consent `budget_insights`; per spec §12 the `promotions`/`ads` modules must not import budget tables; show only aggregates with k >= 50 and never per-user in Admin. REPO `modules/budget` exists |

### C. Price integrity

| # | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| C1 | Verified-claim share | SKUs with `price_claims.status`=allowed / SKUs showing any discount | Line | n/a | PARTIAL. REPO `modules/price-integrity`; admin page `(console)/price-integrity` |
| C2 | Auto-corrections | count of "claim exceeds VRP" corrections per day (enforcement ladder, spec §9.5) | Column + trend | spike 3x median | DATA-ONLY (`enforcement_actions`) |
| C3 | Appeals upheld | upheld / decided; target < 2% false positives (spec §9.7) | Line with target band | > 2% | DATA-ONLY |
| C4 | Fake-discount complaints | support tickets tagged price_complaint + `price_reported` events per 1k orders; target ~0 | Line | any week > 0.5/1k | NO ticket tagging seen |
| C5 | Evidence staleness | claims degraded to plain price because crawler evidence > 72h | Column | > 5% of SKUs | SPEC (crawler REPO `modules/price-crawler`, dark) |

### D. Logistics

| # | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| D1 | Dispatch on-time | SellerOrders `SHIPPED` within 48h of `ACCEPTED` / shipped | Line; seller scatter for outliers | < 90% | DATA-ONLY. REPO `modules/fulfillment`, `orders` |
| D2 | Delivery success | DELIVERED / (DELIVERED + RTO + DELIVERY_FAILED) per courier | Line per courier | < 90% | DATA-ONLY (courier events normalised, spec §21) |
| D3 | COD refusal rate by governorate | COD refusals / COD attempted deliveries; 27 governorates | Choropleth is attractive but ranks poorly; use sorted horizontal bar with CI + small map as secondary (INFERENCE) | any governorate > spec baseline +10pp (baseline unverified, VR row 12) | NO. grep for refusal logic in `apps/api/src` returned nothing |
| D4 | Cost per order by governorate | courier fee + COD fee + RTO cost / orders | Sorted bar or heatmap courier x governorate | +15% w/w | NO (needs courier remittance) |
| D5 | COD remittance aging | `cod_clearing` unreconciled by age | see G | > 3 days (spec T4) | PARTIAL REPO `modules/reconciliation` |

### E. Returns and refunds

| # | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| E1 | Return rate | returned units / delivered units, by category, seller, reason (taxonomy §22) | Sorted bar (category), scatter (seller rate vs volume), stacked bar (reason) | seller > 2x category median | PARTIAL. REPO `modules/returns`; admin page `(console)/returns`; list routes exist |
| E2 | Refund time p95 | p95(refund COMPLETED - return RECEIVED) ; SLO: initiated within 24h for 99% (spec T8) | Line p50/p95 + SLO line | burn-rate (see I) | DATA-ONLY. REPO `modules/refunds` |
| E3 | Dispute rate | disputes / rejected-inspection returns | Line | > 5% (INFERENCE) | PARTIAL REPO route `POST returns/:returnId/dispute` |
| E4 | Refund funnel | REQUESTED -> APPROVED -> PROCESSING -> COMPLETED/FAILED/MANUAL_REVIEW counts and dwell | Sankey or funnel with dwell time; Sankey shows leakage to FAILED/MANUAL | FAILED/MANUAL_REVIEW > 1% or any aged > 14d (legal deadline assumption, VERIFY) | DATA-ONLY |
| E5 | Refund-by-method mix and BNPL routing | share by RefundRouter route; BNPL refunds to wallet must be 0 (spec §B3) | Stacked bar | BNPL->credit > 0 pages Finance | DATA-ONLY |

### F. Fraud and risk

| # | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| F1 | COD refusal / RTO (risk view) | as D3 plus by risk band and decision (allow/OTP/prepay/block) | Stacked bar by band | refusal in `allow` band rising | NO. No `fraud` module in `apps/api/src/modules` listing (spec lists module `fraud`) |
| F2 | Chargebacks | count and piastres per 10k orders; PSP dispute feed | Line | > 0.5% (card-scheme norms, unverified) | NO. grep hit only ads/payouts commands |
| F3 | Referral fraud | rejected/(rewarded+rejected); cluster sizes | Bar + table | rejection spike | PARTIAL REPO `modules/referrals` |
| F4 | Promo abuse | redemptions flagged by velocity/multi-account / redemptions; refund-then-reuse blocks | Line | > baseline x2 | PARTIAL REPO `modules/promotions` |
| F5 | False-positive rate | good users blocked / blocked users, estimated from appeals+later good history; target < 0.5% (spec §20.7) | Line with target | > 0.5% | NO |
| F6 | Gift-card brute force | failed redemptions, 429s (spec §15.1) | Column | anomaly | spec notes "no read endpoint" (`admin-console-web-phase2.md` gap 1) |

### G. Supply health

| # | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| G1 | Seller KYC funnel | DRAFT -> SUBMITTED -> AUTO_CHECKS -> APPROVED/NEEDS_INFO/REJECTED counts, dwell | Funnel + dwell box | NEEDS_INFO aged > 5d | YES. REPO admin routes `kyc/queue`, `kyc/sellers/:id` in `modules/admin/adapters/admin.controller.ts` |
| G2 | Seller health distribution | histogram of Seller Health Score (0-100) + share under threshold | Histogram with threshold band | share below 50 up > 5pp | DATA-ONLY (`modules/sellers`) |
| G3 | Suspensions queue | open automatic suspensions awaiting human review; age vs 5 business-day SLA (spec §9.5) | Aging bars (0-1d,2-3d,4-5d,>5d) | any > 4 business days; breach at 5 | YES. REPO route `kyc/suspension-reviews`, page `(console)/suspensions` |
| G4 | Active sellers, listing quality, stock-outs | counts | Line | n/a | DATA-ONLY |

### H. Search, promotions, referral, notifications

| # | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| H1 | Search no-result rate | `search_no_result` / `search_performed`; target < 8% (spec §4) | Line + top no-result queries table (demand gaps) | > 8% | DATA-ONLY. REPO `modules/search/application/search.ts` references `search_no_result` |
| H2 | Search CTR; p95 latency | clicks / searches ; p95 < 150 ms | Line | latency burn | DATA-ONLY |
| H3 | Promo ROI | (incremental GMV vs holdout x CM% - promo_expense_platform - promo_receivable cost) / promo cost | Bar per campaign with CI (holdout based) | ROI < 0 after 7d | PARTIAL (promotions admin page; A/B framework Phase 2) |
| H4 | Promo abuse | see F4 | | | |
| H5 | Referral K-factor | invites per referrer x invite-to-converted rate; plus referral CAC | Line | n/a | DATA-ONLY. Events `referral_shared`, `referral_converted` in analytics-events.ts |
| H6 | Notifications | per channel opt-in rate, delivery, CTR, unsubscribe rate (guardrail) | Line per channel; unsubscribe as guardrail overlay | unsubscribe > 1% per send (INFERENCE) | PARTIAL. REPO `modules/notifications` |

### I. Money and ledger health (Finance/Security-critical; shown as status tiles + exceptions)

| # | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| I1 | Trial balance = 0 | sum(postings) per currency across all entries; must equal 0 | Binary status tile + last-run time; time series is flat 0 and wastes space | any non-zero = page Finance + Security immediately | YES (job). REPO `modules/ledger/application/integrity-job.ts` (`checkTrialBalance`); no admin read route seen, report returned from job only |
| I2 | Hash-chain verification | `verifyChain` from genesis, pages from one snapshot | Status tile + "verified up to entry N" | fail = page | YES (same file) |
| I3 | Store-credit projection drift | users where projection != postings; negative balances | Count tile + table of offenders (ids pseudonymised) | any > 0 | YES (`storeCreditDrift` in same file) |
| I4 | Reconciliation aging | unmatched lines by age bucket for PSP, COD, BNPL, ETA; target 0 older than 3 days (spec T4/T8) | Stacked aging bars per rail | any > 3d escalate to Finance | PARTIAL. REPO `modules/reconciliation/application/{ingest,run,queries}.ts`; PSP, COD, BNPL ports Unconfigured/partial (`docs/plan/status-2026-10.md`) |
| I5 | Payouts by state | counts and piastres: SCHEDULED, ON_HOLD, APPROVED, SENT, SETTLED, FAILED | Stacked bar by state + oldest-in-state | FAILED > 0; ON_HOLD aged | YES. REPO `modules/payouts` route `GET payouts`; admin page `(console)/finance` |
| I6 | DLQ depth and age | outbox/inbox DLQ messages, oldest age, by consumer | Line depth + table | depth > 0 for 15m page; growth | PARTIAL. REPO `apps/api/src/platform/db/outbox-store.ts`, `schema.ts` mention DLQ; admin page lacks it (`docs/specs/admin-console-web.md` lists DLQ depth as metric) |
| I7 | Webhook failures | signature failures, dedup hits, processing failures, replay lag by provider; webhook->PAID p95 < 5s | Line + table | sig failures spike (attack), p95 SLO burn | DATA-ONLY (`payment_events_raw`) |
| I8 | Checkout SLO | success >= 99.5% (28d); error-budget remaining | Burn-rate gauge + budget line | multi-window burn: 14.4x/1h&5m, 6x/6h&30m page; 1x/3d ticket (DOCUMENTED above) | SPEC (SLO defined spec T8) |
| I9 | Inventory integrity | oversell count (must be 0), reserve p95 < 150ms, expired-reservation auto-claim failures > 0.1% (spec §7) | tiles | any oversell page | DATA-ONLY |

### J. Tax, privacy, support, sustainability, war room, engineering

| # | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| J1 | ETA submitted/accepted/rejected | daily counts and piastres; reject reasons | Stacked column + reject-reason bars | reject > 1% or queue age > 24h | YES. REPO routes `admin/tax/documents`, `admin/tax/reconciliation`, `submissions/:id/requeue`; page `(console)/tax` |
| J2 | VAT report | output VAT 14% by month from `platform_vat_output` less credit notes | Table + monthly column (exact figures belong in tables) | variance vs ETA > 0 | PARTIAL (tax-eta module; report not confirmed) |
| J3 | DSAR queue and SLA | open requests by age vs 30-day SLA (statutory deadline VERIFY); export ready <= 72h | Aging bars + SLA line | any > 20 days; export > 48h | YES. REPO `modules/privacy`, routes `requests`, exports; page `(console)/privacy` |
| J4 | Consent stats | per purpose grant rate, withdrawals/day | Stacked bar per purpose | withdrawal spike | PARTIAL (`consent_changed` event) |
| J5 | Breach register + 72h clock | per open breach: time since detection, PDPC notice deadline (72h), subject notice (+3d), triage <= 4h | Countdown rows (not a chart) colour by remaining time | amber 24h left, red 12h left, breach of any clock | YES. REPO routes `breaches`, `breaches/:id/triage`, `/pdpc-notified`, `/subjects-notified`, `/close` |
| J6 | Transfer register | cross-border processors, TIA status, licence expiry | Table | licence expiring 60d | SPEC (ADR-0002 Proposed) |
| J7 | PII-view audit | PII views per actor per reason code; unusual volume | Bar per actor + table | actor > 3x peer median | YES. REPO `POST pii-views`, page `(console)/pii` |
| J8 | Support desk | open tickets, first-response and resolution vs SLA, backlog age; WhatsApp inbox volume/template rejection | Line + aging bars | first response SLA burn | PARTIAL. REPO route `GET tickets` (module not identified); WhatsApp adapter `production/adapters/comms/whatsapp.ts`; no ticket metrics |
| J9 | Sustainability | SCI per order = ((E x I) + M) per completed order (ISO/IEC 21031:2024); cost per order; cost per 1k sessions | Line pairing gCO2e and cost per order | +20% w/w | NO. Spec `admin-console-web-phase2.md`: shown as "Not measured" placeholders; grep for gco2 found none. SCI definition: [GSF](https://greensoftware.foundation/articles/sci-specification-achieves-iso-standard-status/) |
| J10 | Mega-event war room | live: traffic RPS, error rate, checkout success, stock-outs, PSP health per provider, queue depth, waiting-room admit rate, bot block rate | Dense live board of small multiples, 5s refresh, with last-hour sparkline each | per-SLO burn alerts; PSP success < 95% | SPEC; waiting room module exists (REPO `modules/waiting-room`) but admin read endpoints for queue depth/bot rate absent (`admin-console-web-phase2.md` gap 1) |
| J11 | DORA | deployment frequency, lead time, change-failure rate, recovery time, rework rate | Four small line/step charts with bands; show `basis` | CFR > 15%, recovery > 1h (spec T11) | YES (batch). REPO `tooling/dora/dora.mjs`; page `(console)/engineering` loads `dora-report.json`; no live pipe; proxy deployments noted |

## 3. Admin console IA

Current state (REPO `apps/admin-web/src/view-models/nav.ts`): flat list of 26 routes filtered by role; missing nav entries for metrics, war room, ledger health, support, search health, entity 360. Role set in code: ops, finance, trust_safety, support, marketing, dpo, security, super_admin.

### Proposed nav (INFERENCE) by group
- Home: Attention queue, My approvals.
- Commerce: Overview (A1-A9), Cohorts and LTV (A10-A14), Search health (H1-H2), Promotions (H3), Plus (B), Rewards, Referrals.
- Money: Ledger health (I1-I3, I9), Reconciliation (I4), Payouts (I5), Pipeline health (I6-I7), Tax/ETA (J1-J2), Margin (A2-A4).
- Supply: Sellers and KYC (G1), Seller health (G2), Price integrity (C), Catalog quality.
- Fulfilment: Logistics (D), Returns and refunds (E).
- Trust: Fraud and risk (F), Suspensions (G3), Moderation, Disputes.
- Support: Tickets, WhatsApp inbox (J8).
- Privacy: DSAR, consents, breaches, transfers (J3-J6), PII-view audit (J7).
- Platform: Flags and kill switches, War room (J10), Engineering/DORA (J11), Sustainability (J9), Audit log, Approvals and elevation.

### Role x metric visibility (R=read aggregate, E=entity-level read with PII reason code, A=act, -=none)
| Group | Ops | Finance | T&S | Support | Marketing | DPO | Security | Super-admin |
|---|---|---|---|---|---|---|---|---|
| A commerce (GMV, funnel, AOV) | R | R | R (risk slices) | - | R | - | - | R |
| A2-A4 margin, LTV, CAC | R | R | - | - | R (CAC, LTV only) | - | - | R |
| B Plus | R | R,A | - | R (own cases) | R | - | - | R |
| B5 budget impact | - | - | - | - | - | R (aggregate k>=50) | - | R (aggregate) |
| C price integrity | R,A | - | R,A | - | - | - | - | R |
| D/E logistics, returns | R,A | R (E, refunds) | R | R,E (case) | - | - | - | R |
| F fraud | R | R (chargebacks) | R,A | - | - | - | R | R |
| G supply | R,A | R (payout holds) | R,A | R (own seller cases) | - | - | R (suspensions) | R |
| H promos, search, notifs | R | R (promo cost) | R (abuse) | - | R,A | - | - | R |
| I ledger/recon/payouts | - | R,A | - | - | - | - | R (I1, I2 only) | R |
| J1-J2 tax | R | R,A | - | - | - | - | - | R |
| J3-J7 privacy | - | - | - | - | - | R,A | R (J7, audit) | R |
| J8 support | R | - | R | R,A | - | - | - | R |
| J9-J11 platform | R | R (cost) | - | - | - | - | R | R |

Basis: existing role assignments in `nav.ts` (e.g. `finance` only Finance; `privacy` only DPO; `engineering` ops/security/super_admin). Where the table departs (e.g. Security reading I1/I2, Marketing reading CAC), it is INFERENCE and needs owner approval. Spec §23 requires: passkey mandatory, IP allow-list for Finance and Super-admin, JIT elevation, every PII view logged with reason code (spec §23; REPO `elevation`, `pii` pages).

### PII reason codes (INFERENCE, to confirm vs `apps/admin-web/src/view-models/pii.ts`)
`support_case`, `fraud_review`, `dsar_fulfilment`, `legal_request`, `breach_investigation`, `payout_dispute`. Each requires a case/ticket ID, auto-expires, is rate-limited, and appears in J7. Aggregate dashboards never expose P2/P3; entity pages show masked values by default (phone last 4) with click-to-reveal that writes a `pii-views` audit row (REPO route `POST pii-views`).

### Home "attention needed" queue (INFERENCE; ordered by severity then deadline)
1. Page-level: ledger integrity fail (I1-I3), DLQ growing (I6), checkout burn alert (I8), oversell > 0.
2. Legal clocks: breach 72h/3d (J5), DSAR near 30d (J3), suspension review near 5 business days (G3).
3. Money: payout FAILED/ON_HOLD, recon aging > 3d (I4), ETA rejects (J1), refund FAILED/aged (E4).
4. Approvals waiting on me (dual approval) and elevations expiring (REPO `GET approvals`, `elevations`).
5. Trust: price-integrity appeals, KYC NEEDS_INFO aged, fraud cluster alerts.
6. Business anomalies: GMV, conversion, COD refusal deviations.
Each row: severity, owner role, age/deadline countdown, deep link, "claim" action (REPO has `:id/claim` routes in admin tooling, exact module not confirmed). Show only items the viewer's role may act on; counts for others hidden. REPO today: `(console)/page.tsx` is home, content not inspected.

### Entity 360 pages (INFERENCE)
- Seller 360: KYC state and documents, health score trend, Price Trust, orders/SLA, returns and disputes, payout balance and holds, enforcement actions, ledger accounts `seller_payable:{store}`, audit trail. Base: REPO `kyc/sellers/:sellerId`.
- Order 360 (OrderGroup): state machine timeline, payments/webhooks raw, reservations, ledger entries (balanced view), shipments, refunds, ETA doc, risk decision.
- User 360 (support/T&S/DPO): masked profile, consents, orders, wallet postings, sessions, risk flags, DSARs; PII reveal gated by reason code.
- Product/SKU 360: price events, VRP evidence, claims, stock units, return reasons.
- Shipment 360, Return/Refund 360, Payout 360 (REPO `GET payouts/:id`), Promotion 360, Drop 360.

### Dual approval and audit visibility
- Dual approval already built: REPO `POST approvals`, `:id/approve`, `:id/reject`; requester cannot approve (admin-console-web-phase2.md on Plus price change). Spec §23 scope: payouts above threshold, refunds above threshold, plan price changes, role grants, data exports. Show in UI: pending approvals tab, who requested/approved, thresholds in piastres, expiry.
- Audit log: append-only, hash-chained (spec A2.9); provide search by actor/target/request ID, "chain verified" tile (same pattern as I2), export is itself a dual-approval action. REPO admin has no audit-log read route in the route list seen (INFERENCE: gap).

## 4. Data gaps and build order (INFERENCE)

1. No metrics read API exists for most rows: spec says admin emits no analytics; `docs/specs/admin-console-web-phase2.md` gap list says many "no read endpoints". Add a `GET /v1/admin/metrics/{id}` contract: `{id, window, grain, series[], asOf, basis, suppressed}` with Zod schema, role scope, and `null` rendered as "Not measured" (the DORA page already follows this pattern).
2. Tier 1 (build first, data already exists): I1-I3 (surface existing IntegrityJob), I5, I4, J1, J3, J5, G1, G3, E1, J11 live pipe.
3. Tier 2 (needs derived aggregates from orders/ledger): A1-A9, B1-B4, D1-D2, E2-E5, C1-C3, H1-H2, I6-I7.
4. Tier 3 (needs new data or provider contracts): A4 (RTO and shipping cost postings), A12-A14 (channel attribution and spend), D3-D4, F1-F2, F5, J9, J10 admin feeds, J8 ticket metrics.

## Gaps
- Stripe Dashboard chart types and Shopify native funnel not verified from primary pages; DORA and SRE tier figures come from secondary summaries.
- Repo grounding is shallow: I did not read controllers beyond admin and route lists; "Exists?" for DATA-ONLY rows is inferred from module names and spec, not table schemas. Verify against `apps/api/src/platform/db/schema.ts` and migrations before building.
- Thresholds marked INFERENCE are starting defaults, not sourced; baselines (COD RTO, chargeback rate) are unverified per spec VR rows.
- Whether ClickHouse/dbt exists in the repo is unconfirmed (a grep errored).
