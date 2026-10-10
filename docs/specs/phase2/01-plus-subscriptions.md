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
