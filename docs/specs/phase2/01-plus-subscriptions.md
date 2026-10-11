# Spec 01: Z-OUTLET Plus subscriptions and entitlements

Refs: §14, §B6, §B7, ADR-0004 (Plan A, entitlement groups), ADR-0012 (age gate), ADR-0021 (ledger-first). Phase 2.

## Flow
1. Me -> Z-OUTLET Plus (or checkout delivery-fee nudge "Plus would save you X EGP", from the real fee only) -> paywall: plans, auto-renew disclosure, trial terms, price, cancellation path.
2. Age gate check (`age_policy.plus_min_age`, default 21). Under: soft gate "requires 21+" with help link.
3. Subscribe: choose plan (monthly 200 EGP, yearly 800 EGP, default selected yearly; prices come from versioned `plans`), PSP tokenised card via hosted/native SDK, 3-DS. Trial (14 days, once per person) if eligible.
4. Webhook confirms -> `subscriptions.status` moves, entitlements granted, outbox event, ETA e-receipt queued per charge.
5. Manage: pause (1-3 months), switch plan, cancel (at most 2 taps from Me -> Plus; no confirm-shaming; benefits until `period_end`).

## Rules
- State machine (domain, table-driven): `TRIALING -> ACTIVE -> PAST_DUE -> ACTIVE | EXPIRED`; `ACTIVE -> PAUSED -> ACTIVE`; `ACTIVE -> CANCELLED_AT_PERIOD_END -> EXPIRED`; `TRIALING -> CANCELLED_AT_PERIOD_END`. Invalid transition throws typed `InvalidSubscriptionTransition`.
- Dunning: charge fails -> `PAST_DUE`, retries day 1, 3, 7 (idempotent key `sub:{id}:cycle:{n}:attempt:{k}`); 7-day grace in which benefits continue; after grace -> `EXPIRED`, entitlements revoked at the grace end instant.
- Monthly -> yearly upgrade: immediate; credit = unused full days of the paid monthly period x (monthly price / days in period), integer piastres, banker's rounding at one documented point, applied against the 800 EGP charge; the credit is a ledger entry against `deferred_plus_revenue`. Yearly -> monthly downgrade takes effect at `period_end`.
- Refund: full refund within 14 days of a charge if `plus_savings_ledger` shows no benefit used since that charge (default policy, VR-F1 note: counsel to confirm CPL applicability, new row VR-P2-01). Otherwise no pro-rata unless counsel says so. Refund via RefundRouter to the original PSP method, never wallet unless the shopper chooses.
- Trial: one per person keyed on `(phone_hash, device_id, card_fingerprint)`; reminder 2 days before first charge (transactional).
- Price change: new `plans.version`; existing members notified at least 30 days ahead and kept on old price until the next period after notice.
- Plan A (ADR-0004): perks are commerce-only. Entitlement groups: `commerce_benefits` (free_delivery, early_access_24h, coins_plus_5pct, free_returns, plus_day, monthly_voucher, birthday_gift, priority_support) and `app_features` (empty by default; reserved for Plan B "Stylist Pro" IAP). Stylist is never gated by Plus (fair use applies to everyone).
- Revenue: charge posts `psp_clearing` Dr / `deferred_plus_revenue` Cr + `platform_vat_output`; monthly recognition entry moves deferred to `plus_revenue`. Posting recipes added to `ledger-chart-of-accounts.md` by the builder.
- Delivery fee: at checkout commit, the fee is recomputed with the entitlement state at that instant (shown if changed).

## Edge cases
- Free delivery used on an order later cancelled: no effect on subscription; savings ledger row reversed.
- Plus expires between checkout start and payment: fee recomputed and shown.
- Webhook before redirect return: server is source of truth; client polls.
- Duplicate subscribe taps: idempotency key returns the same subscription.
- Payment method deleted while ACTIVE: next charge fails into `PAST_DUE` normally.
- Same card fingerprint, new phone: no trial.
- Account deletion: blocked while ACTIVE unless cancelled; deletion request auto-offers cancel; remaining paid period refund per policy.
- Apple storefront US link-out: not in scope; flag reads `Storefront.current` (ADR-0004 item 5).
- DST/Cairo TZ: period boundaries stored UTC, shown Africa/Cairo.

## Data
| Table | Key columns | PII |
|---|---|---|
| `plans` | id, code, price BIGINT, interval, active, version, trial_days | P0 |
| `subscriptions` | id, user_id, plan_id, plan_version, status, period_start, period_end, trial_end, cancel_at, paused_until, psp_token_ref, grace_ends_at | P2 |
| `subscription_invoices` | id, subscription_id, cycle, amount, vat, status, psp_ref, eta_receipt_id, attempt | P2 |
| `plus_savings_ledger` | id, user_id, order_group_id, benefit, amount_saved, reversed_at | P2 |
| `entitlements` | user_id, group, key, source_subscription_id, valid_from, valid_to | P2 |
| `trial_claims` | person_key_hash, claimed_at | P2 (hashed) |
Indexes: `subscriptions(user_id, status)`, `subscriptions(status, period_end)` for the renewal sweeper, `subscription_invoices(subscription_id, cycle, attempt)` unique.

## API
| Endpoint | Auth | Idem | Rate limit |
|---|---|---|---|
| `GET /v1/plus/plans` | shopper | no | 60/min |
| `POST /v1/plus/subscribe` | shopper, App Attest | yes | 5/10 min |
| `POST /v1/plus/cancel` | owner | yes | 10/10 min |
| `POST /v1/plus/pause` | owner | yes | 10/10 min |
| `POST /v1/plus/switch-plan` | owner | yes | 5/10 min |
| `GET /v1/me/plus` | owner | no | 60/min |
| `POST /v1/webhooks/{provider}/recurring` | HMAC + IP allow-list + timestamp | dedup by PSP event id | provider |
| `CRUD /v1/admin/plus/plans` | admin finance, dual approval on price | yes | 30/min |

## Events
Outbox: `plus.subscribed`, `plus.renewed`, `plus.payment_failed(attempt)`, `plus.expired`, `plus.paused`, `plus.cancel_requested`, `plus.refunded`, `entitlement.granted/revoked`. Analytics: `plus_paywall_viewed`, `plus_started(plan, trial)`, `plus_cancelled(reason)`.

## Failure handling
PSP timeout 10 s, 3 idempotent retries; recurring webhook DLQ with replay; renewal sweeper (pg_cron) is idempotent per cycle; ETA receipt submission retried by `tax-eta` queue; if PSP recurring unsupported for a method (VR-04), that method is hidden by kill switch `plus_recurring_<method>`. Kill switch `plus_sales` stops new subscriptions; renewals continue.

## Security and abuse
BOLA: subscription readable only by owner. Trial abuse graph (device, card fingerprint, phone). Price comes from server `plans`, never client. Savings-ledger writes system only. Card data never touches Z-OUTLET (SAQ A). Admin plan price change needs dual approval and 30-day notice job. OWASP API6 (sensitive flow) limits and attest on subscribe.

## Metrics
Penetration, trial -> paid, monthly churn, yearly mix, median savings >= 2x fee, dunning recovery rate. SLO: renewal success processing p95 < 5 s from webhook; guardrail: refund-within-14-day rate.

## Acceptance
```
Given a 20-year-old user and plus_min_age 21, When they subscribe, Then 403 age_gate and no charge.
Given yearly plan, Then paywall shows "Pay 4 months, get 8 free", saving 1,600 EGP, and 800 = 4 x 200 is unit-tested.
Given a monthly member 10 days into a 30-day period, When they switch to yearly, Then credit = 20 days unused, charge = 800 minus credit, ledger balances to zero.
Given a failed renewal, Then retries on day 1, 3, 7, benefits continue to day 7, and entitlements revoke at grace end.
Given cancel tapped, Then benefits remain until period_end and end exactly then; Cancel is reachable in 2 taps.
Given a charge 5 days ago with no benefit used, When refund requested, Then full refund to original method.
Given the same card fingerprint on a new phone, Then no trial.
Given any Plus entitlement of group app_features, Then the stylist endpoints do not check it (Plan A contract test).
```

## Build notes

Built in `apps/api/src/modules/subscriptions` (hexagonal: domain bridge, application, adapters), pure rules in `packages/domain/src/subscriptions`, migration `packages/db/migrations/0036_subscriptions.sql`. Everything runs on ports with in-memory fakes; no PSP, no ledger and no ETA code is real.

### Algorithm choices (2 options each)
- **Proration.** (a) continuous by seconds: exact, but the credit shown on the paywall moves while the member reads it; (b) whole unused days x (price / days in the paid period): stable and explainable ("20 days unused"). Chosen (b). The credit is based on what the member actually paid for the monthly period (the invoice), not on today's list price, so a grandfathered price is prorated correctly. One half-even rounding via `divideRoundHalfEven` (money.ts).
- **Entitlement truth.** (a) rely on the materialized `entitlements` rows and a sweeper to expire them: simple reads but benefits can outlive `period_end` by one sweep; (b) compute `isEntitled(subscription, now)` at read time and keep the rows as a projection with `valid_to` = paid-through instant. Chosen (b): "ends exactly at `period_end`" and "fee recomputed at commit with the entitlement state at that instant" hold without waiting for the sweeper. Other modules read through `PlusEntitlements.forUser` (token `PLUS_ENTITLEMENTS`).
- **Renewal driver.** (a) event driven per subscription (delayed jobs): precise but one more queue to lose; (b) a pull sweeper over `subscriptions.next_action_at` (partial index), idempotent per `sub:{id}:cycle:{n}:attempt:{k}`, overlapping runs resolved by the optimistic `version`. Chosen (b), matching the spec's pg_cron sweeper.
- **Trial uniqueness.** One HMAC hash per identifier (`card:`, `phone:`, `device:`) rather than a hash of the tuple: a tuple hash would let a changed phone dodge the check ("same card, new phone: no trial" must hold). Any claimed key denies the trial.

### Where the build differs from, or adds to, the spec
- **State machine.** Reuses the shared `subscriptionMachine` unchanged. It has no `PAUSED -> CANCEL` edge, so cancelling a paused member resumes (no charge, period shifted by the paused time) and cancels in one step. It has no `TRIALING -> PAST_DUE` edge, so a failed first charge at trial end is `TRIAL_ENDED_UNPAID -> EXPIRED` (no dunning) and the member is told. The typed error is the machine's `InvalidTransitionError`, re-exported as `InvalidSubscriptionTransition`.
- **Paid start.** Modelled as a zero-length trial converted at once, so every status change goes through the one machine.
- **First charge and 3-DS.** `POST /v1/plus/subscribe` takes a PSP token reference (never card data), creates a `plus_signups` row keyed by `plus:signup:{user}:{Idempotency-Key}` and charges with that key, so a replay or a second tap cannot double charge. `requires_action` answers 201 with `status: requires_action` and the `client_action`; the verified webhook `signup.charge_succeeded` creates the subscription. If a charge succeeds but a second subscription already exists (race) the charge is refunded through `PlusRefundPort` and the existing subscription is returned.
- **Extra routes** (needed for the acceptance list and for the UI): `POST /v1/plus/resume`, `POST /v1/plus/reactivate` (undo cancel before `period_end`), `POST /v1/plus/refund` (14 day full refund), `GET /v1/admin/plus/plans`, `PATCH /v1/admin/plus/plans/{planId}` (activate or deactivate a version). Request bodies are strict; no price or amount is ever accepted from the client.
- **Column names.** `plans.price` (BIGINT) and `billing_interval` (avoids the reserved word), `entitlement_group` and `entitlement_key` (avoid `group` and `key`). Added: `subscriptions.plan_code/plan_version/billing_interval/paused_at/grace_ends_at/failed_at/dunning_attempts/cycle/next_action_at/pending_plan_code/trial_reminder_sent_at/version`; `subscription_invoices.kind/attempt/vat/credit_applied/net_recognition/periods_*/psp_provider`; `plans.effective_from/notified_at`. `trial_claims` holds one row per identifier hash, keyed `person_key_hash`.
- **Dunning keys.** Renewals and recoveries use `sub:{id}:cycle:{n}:attempt:{k}`. `cycle` increments when the renewal fails, so recovery attempts 1-3 carry the cycle being recovered. The very first charge uses the signup key (there is no subscription id yet).
- **Price versions.** Instead of tracking a per-member notice, a new plan version carries `effective_from >= publish + 30 days` (enforced) and members are notified at publish; a period starting before `effective_from` bills the old version, the first period starting at or after it bills the new one. Price changes require an approved dual approval (`PlanPriceApprovalPort.consume`, wired by the integrator to the admin module's `DualApprovals`) because the central policy rule for `plan_price` has `dualApproval: always` and the guard does not carry approvals; the route is guarded as `admin_console` plus a handler role check (finance, super_admin), the same pattern as review moderation.
- **Ledger.** Charge: `plusCharged` (Dr psp_clearing, Cr deferred_plus_revenue net, Cr platform_vat_output), idempotency key `plus:{subscriptionId}:cycle:{n}:attempt:{k}:charged`, posted before the state commit (a retry re-posts the same key). Monthly recognition: `plusRevenueRecognised` per invoice month from `planPlusRecognition`, key `plus:invoice:{id}:recognise:{k}`, run by `RecognizeDeferredRevenue`. Upgrade: the used share of the monthly net is recognised at once; the unused share stays in `deferred_plus_revenue` and rolls into the yearly invoice's `net_recognition`, so no extra "credit" entry exists and deferred revenue is conserved (the credit's VAT was booked at the original charge). Refund within 14 days: `reverseEntry` of the charge entry (nothing is recognised that early) and PSP refund to the original method through `PlusRefundPort`. VAT 14% (`PLUS_VAT_BPS`) is a config value, VERIFY with tax (VR row for gift cards/coins/vouchers VAT base applies to Plus too).
- **Savings ledger.** Written by the system only (`RecordBenefitUsed`, `ReverseBenefit`, no HTTP route). The 14 day refund checks for any non-reversed row since the charge.
- **Flags.** `kill.plus.sales` (new subscriptions only; renewals continue) and `kill.plus.recurring.<card|mobile_wallet|apple_pay>`, read through `FeatureGatePort` (fail closed). They are not yet in `packages/feature-flags` (not an owned path); see integrator needs.
- **Plan A.** `APP_FEATURE_KEYS` is empty; a contract test scans any `stylist` directory for imports of this module or entitlement reads.
- **Account deletion.** The module exposes cancel and refund; the privacy module's "blocked while ACTIVE, offer cancel" rule must call `GET /v1/me/plus` semantics through `PlusEntitlements`/`CancelPlus` (integrator).

### Mutation testing
`packages/domain/stryker.subscriptions.mjs` (break 80) covers `billing.ts`, `rules.ts`, `lifecycle.ts` (374 mutants). The run could not be executed in this environment: Stryker aborts with `spawn pgrep EAGAIN` (process limit) on Node v25.9, with concurrency 1 as well. No score is claimed. Run on Node 24 in CI: `cd packages/domain && pnpm exec stryker run stryker.subscriptions.mjs`.
