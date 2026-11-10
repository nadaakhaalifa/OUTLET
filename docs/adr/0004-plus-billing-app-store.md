# ADR-0004: Shopper Plus billing (Phase 2) under app store rules

- Status: **Proposed — owner accepted recommendation 2026-11-07; needs counsel/contract confirmation before anything real** (depends on the age rule: 18 to shop, 21 for contracts). Plus price (D2) stays **open**. Nothing is built before Phase 2.
- Date: 2026-11-07
- Deciders: Owner, Product, counsel, CTO
- Sources: master prompt §B6, §B7, §14; `docs/outlet-nk-vision-addendum.md` C1, §6 (D2); `reports/Outlet NK SaaS and defects.md` ("The Apple subscription risk … matters less at first, because the web launches first"); `docs/plan-and-risks.md` Stage 4; `docs/open-questions.md` Q4, Q9

## Context

- **Plus** is the shopper subscription (free delivery with no minimum, early access to drops, free returns, and more, master prompt §14). Price is an open owner decision (D2): keep 200/800 EGP, or test 59–99/month and 499–599/year. It is **not** a seller plan; seller plans are ADR-0008.
- The master prompt was iOS-first and designed Plan A / Plan B around Apple rules: physical goods and services consumed outside the app may use non-IAP payment (Guideline 3.1.5(a)); subscriptions that unlock in-app features or content need IAP (3.1.1).
- **Web-first changes the picture** (ADR-0007). Plus is a Phase 2 item, and Phase 2 ships Android and iOS **together** (addendum C1). Before the apps exist, Plus can only be sold on the website, where App Store and Play rules do not apply. The Apple question comes back when the iOS app ships, and a **Google Play** question appears at the same time (the master prompt did not cover Google, because Android was later).
- Our reading (⚠ V10, check the guideline text at submission): Apple's multiplatform rule (3.1.3(b)) lets an app honour a subscription bought on the web **only if** the same item is also offered as IAP in the app, **unless** the item falls under 3.1.5(a) physical goods and services. So a commerce-only Plus is the safest design on every platform.
- Recurring charges through Egyptian PSPs, especially on mobile wallets, are unverified (V4).
- Plus is an auto-renewing contract, so it uses the **21+** contract age until counsel confirms otherwise (V8).

## Options considered

| Option | Good | Bad |
|---|---|---|
| **Plan A: commerce-only Plus, billed through the PSP on every platform (chosen default)** | Keeps full revenue; one billing system; a simple story for Apple and Google | Apple or Google may still reject it; recurring through PSPs is unverified (V4) |
| Plan B: commerce perks on PSP billing + an optional IAP "Pro" subscription for any premium in-app feature | Lowest review risk if a digital feature is ever bundled | A second billing system and a split paywall; store commission on that part |
| Plan C: all of Plus through IAP / Play Billing | No review risk | Store commission on a low-price Egyptian subscription; two more billing stacks; web members and app members diverge |

**Choice (2–3 lines):** Plan A, because every Plus benefit is a physical-commerce perk and the web launches first, where no store rule applies. Plan B is designed in (entitlement groups) so a review rejection is a configuration change, not a rewrite.

## Decision

1. **Phase 1 (web MVP): no Plus.** Free delivery uses the per-store threshold only (shipping spec §3). Nothing in Phase 1 assumes Plus exists. Brand "member-only" display mode (D3) does not depend on Plus in Phase 1 (see ADR-0008).
2. **Phase 2 web launch of Plus first**, sold through the PSP with tokenised recurring charges, before or together with the apps.
3. **Plus benefits are commerce-only:** free delivery, early access to drops, free returns, monthly voucher or sale, priority support. Any AI assistant or stylist stays **free with fair-use limits for everyone** and is never gated by Plus.
4. **Entitlements are modelled in two groups:** `commerce_benefits` and `app_features`. Today `app_features` is empty. Plan B moves `app_features` to an IAP / Play Billing SKU by configuration.
5. **Apps (Phase 2):** before the first App Store and Play submission that shows Plus, submit a test build with the Plus screen and record the review outcome in V10 and V66. Egypt and other non-US storefronts get no anti-steering relief; any US link-out stays out of scope and behind a flag.
6. **Disclosure and cancel:** full auto-renew disclosure before purchase and in every receipt; cancel in ≤ 2 taps; pause instead of cancel offered, never forced; no confirm-shaming (master prompt §14, §18).
7. **Billing mechanics** follow master prompt §14: the state machine `TRIALING → ACTIVE → PAST_DUE → (ACTIVE | EXPIRED)`, `ACTIVE → PAUSED → ACTIVE`, `ACTIVE → CANCELLED_AT_PERIOD_END → EXPIRED`; dunning day 1/3/7 with 7-day grace; prorated upgrade; downgrade at period end. Each charge produces an ETA e-receipt (V6).
8. **Prices are config** (`plans` table, versioned, per market and currency, ADR-0006). No price is hard-coded. Members get ≥ 30 days' notice of a price change.
9. **Age:** Plus needs **21+** by default via the `age_policy` table; admin-switchable to 18 only after counsel sign-off (V8).

## Consequences

**Good**
- The web MVP is not blocked by store rules or by D2.
- One billing system on all platforms if Plan A is accepted.
- A rejection is handled by configuration (Plan B).

**Bad / risks**
- If recurring charges are not available through the PSP (V4), Plus may be card-only or yearly-only.
- If Apple or Google reject Plan A, Plan B adds IAP/Play Billing integration and store commission.
- The 21+ default excludes 18–20-year-olds from Plus until counsel confirms.

## Verify-register rows
- **V4** PSP tokenisation and recurring (cards, wallets)
- **V6** ETA e-receipt for Plus charges; VAT
- **V8** age of majority 21 vs 18; contracts with 18–20-year-olds
- **V10** Apple: Plus via PSP (3.1.5(a)) vs IAP (3.1.1, 3.1.3(b)); current guideline text; US link-out status
- **V66 (new)** Google Play payments policy: whether a commerce-only Plus sold through a PSP is allowed in the Android app without Play Billing

## Related
ADR-0007 (web first), ADR-0008 (seller plans are separate), ADR-0006 (prices per market), master prompt §14.
