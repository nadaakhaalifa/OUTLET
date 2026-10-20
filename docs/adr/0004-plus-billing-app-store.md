# ADR-0004: Plus subscription billing under App Store rules

- Status: **Proposed, blocked on open questions 5, 6 and 7**
- Date: 2026-10-10
- Deciders: Product, Legal, CTO
- Spec refs: §B7, §B6, §14, §T2, register rows 4, 8, 10

## Context and problem statement

Z-OUTLET Plus is an auto-renewing subscription (default 200 EGP/month, 800 EGP/year, admin-configurable). Apple requires in-app purchase (IAP) for subscriptions that unlock app features or content (3.1.1), but allows non-IAP payment for physical goods and services consumed outside the app (3.1.5(a)). Plus is designed as physical-commerce perks, yet the draft spec also lists in-app premium features that could pull it into 3.1.1.

## Decision drivers

- Avoid a review rejection late in the schedule.
- Keep the 15–30% IAP commission out of a low-price Egyptian subscription where legitimate.
- Keep the model flexible: switching plans must not be a rewrite.
- Age and capacity: a recurring contract may be riskier for 18–20-year-olds.

## Considered options

1. **Plan A: commerce-only Plus sold through the PSP** (default).
2. **Plan B: IAP for any premium in-app feature**, with commerce perks still on PSP billing.
3. Sell all of Plus through IAP.

## Decision

**Plan A, with Plan B designed in.**

1. **Plus benefits are commerce-only:** free delivery with no minimum, 24h early access to drops, +5% coin cashback, free returns, monthly voucher/sale, priority support. The stylist stays **free with fair-use limits for everyone** and is never gated by Plus.
2. **Billing via PSP tokenized recurring charges.** The paywall carries full auto-renew disclosure before purchase and in receipts, and cites 3.1.5(a) in App Review notes. Cancellation is ≤ 2 taps from Me → Z-OUTLET Plus.
3. **Entitlements are modelled in two groups** (`commerce_benefits`, `app_features`). Plan B then moves `app_features` to a "Stylist Pro" IAP SKU (StoreKit 2, optionally RevenueCat) by configuration.
4. **Early App Review exposure:** submit a TestFlight build that includes the Plus paywall and ask App Review in advance. Track the outcome in the verify register (row 10).
5. **Storefront:** Egypt and all non-US storefronts get no anti-steering relief. US link-out is out of scope for launch and, if ever enabled, sits behind a flag that reads `Storefront.current`.
6. **Age gate:** Plus requires 21+ by default (admin-switchable to 18 after counsel sign-off), via the `age_policy` table.
7. **Billing mechanics** (state machine, dunning on day 1/3/7 with 7-day grace, proration on monthly → yearly, 14-day full refund if no benefit used) follow §14. Each charge produces an ETA e-receipt.

## Consequences

**Good**
- Keeps full revenue on Plus and a simple story for Apple, with a quick pivot available.
- Fair-use stylist keeps the best feature in the funnel for everyone.

**Bad / risks**
- Apple may reject Plan A. Then Plan B costs one more integration and a split paywall.
- Recurring billing through Egyptian PSPs, especially wallets, is unverified (register row 4). If recurring is unavailable, Plus may need to be card-only or yearly-only.
- Fair-use limits on the stylist cost money with no direct revenue.
- Capacity risk for 18–20-year-olds is the reason for the 21+ default (row 8).

## Needed to finalize

PSP recurring/tokenization confirmation (question 5), the age-of-majority answer (question 6), and the owner's choice on Plan A versus Plan B and on US link-out (question 7).
