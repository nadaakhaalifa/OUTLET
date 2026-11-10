# ADR-0008: Seller plans (SaaS) are configuration; commission is open

- Status: **Proposed — owner accepted recommendation 2026-11-07; needs counsel/contract confirmation before anything real** (depends on D1 and D3). **No price, fee or commission number is decided here.**
- Date: 2026-11-07
- Deciders: Owner, Finance, CTO
- Sources: `docs/outlet-nk-vision-addendum.md` C2, C4, §6; `reports/Outlet NK SaaS and defects.md` ("Brands pay when they sell, so tiers must be light"); `docs/open-questions.md` Q3, Q5; `docs/plan-and-risks.md` risks 1–3; master prompt §B4, §7 (`commission_rate_snapshot`), §19, §T4

## Context

- Brands are **SaaS customers** with plans, separate from shopper Plus (addendum C2). The usual pattern: a free plan with higher commission, paid plans with lower commission and more tools.
- **D1 is undecided** until about 15 brand interviews. The evidence puts the practical commission ceiling at about **15%** (Noon charges 15% on apparel in Egypt from February 2026, per the SaaS report). Every fee and commission figure in the SaaS report is a **placeholder**, not a benchmark.
- The market trend is "no upfront fees, pay when you sell" (ThredUp 2025; Wuilt went free in 2025; per the SaaS report). The report suggests **pure commission for launch brands for 3–6 months**, then plans once the tools prove their value.
- **D3 accepted as default:** public verified % by default; a brand may choose **member-only** or **hidden** display. Unverified discounts are never shown in any mode (addendum C4).
- VAT treatment of plan fees is open (V24). The master prompt says the platform issues ETA e-invoices to sellers for commission and fees (§B4, V6).

## Options considered

| Option | Good | Bad |
|---|---|---|
| A. Hard-coded tiers (Start / Growth / Pro) with fixed numbers | Fast to build | Every pricing test is a code change and a deploy; numbers are not decided (D1) |
| B. Pure commission only, no plan model | Easiest to sell to the first brands | A rewrite when plans arrive; no place for entitlements (sync, AI credits, display modes) |
| **C. Plans, commission rules and entitlements as versioned configuration (chosen)** | Supports pure commission now and tiers later with no code change; testable; per market | More upfront modelling |

**Choice (2–3 lines):** C, because D1 is open and the right model may change after interviews and beta data. A launch plan with zero fee and one commission rate is just one configuration row, so we can start with pure commission and add tiers later without touching code.

## Decision

### Model (names indicative; the ERD in `docs/data-model.md` is authoritative)
- `seller_plans(id, code, version, market_id, name_ar, name_en, monthly_fee_minor, currency, billing_interval, status draft|active|retired, effective_from, effective_to)`: versioned; a new price = a new version, never an edit in place.
- `commission_rules(id, plan_id, plan_version, category_id NULL, rate_bp, min_fee_minor NULL, effective_from)`: commission in **basis points**; category-specific rows allowed (multi-category, D6).
- `plan_entitlements(plan_id, plan_version, key, value)`: keys such as `channel_sync`, `ai_listing_credits_per_month`, `team_seats`, `analytics_level`, `payout_speed`, `b2b_lot_portal`, `display_modes_allowed`.
- `seller_plan_subscriptions(id, store_id, plan_id, plan_version, status, period_start, period_end, next_plan_id NULL)`.
- Every order line stores `commission_rate_snapshot` (bp) and `plan_version` at payment time. Later plan changes never change past orders.

### Rules
- **Launch default:** one plan "Launch partner" with fee 0 and a single commission rate entered by the owner after D1. Until D1 is decided, the rate field is empty and **checkout for real money stays off** (it is also blocked by D5, ADR-0003).
- **Ceiling guard:** a config value `max_commission_bp` per market (initial value to be set by the owner; the evidence suggests ~1,500 bp). Saving a rule above it needs dual approval in Admin. It is a guard, not a hard-coded number.
- **Plan changes:** upgrade takes effect at the next billing period by default (or immediately if the owner configures it); downgrade at period end. Entitlement checks go through the central `policy` package, never `if (plan === 'pro')` in code.
- **Fee billing (default):** plan fees are **netted from the seller's payable** when a balance exists, otherwise invoiced for bank transfer. No card recurring for sellers in Phase 1. Each fee and each commission produces an ETA e-invoice (B2B, VAT per V24/V6).
- **Ledger:** fees post to `seller_plan_revenue` and `platform_vat_output`; commission to `platform_commission`. Same chart of accounts in both settlement models (ADR-0003).
- **Price changes** to a live plan: ≥ 30 days' notice to subscribed sellers (proposed default; the Seller Agreement sets the binding rule).
- **Penalties** from Price Watch (e.g. a commission surcharge after 3 violations) are a separate, time-boxed `commission_rules` row with a reason and expiry. Its enforceability is V28.

### Display modes (D3)
- `display_mode` per store (or per event): `public` (default), `member_only`, `hidden`.
  - `public`: verified % and verified reference price shown; indexable.
  - `member_only`: verified % shown only to signed-in shoppers. **In Phase 1, "member" means a signed-in, age-verified shopper**, because Plus does not exist until Phase 2 (ADR-0004). Those pages and JSON-LD carry no reference price for anonymous users and crawlers.
  - `hidden`: no % and no reference price anywhere; plain price only. Hidden-brand events may also be login-only and `noindex` (SaaS report).
- **In no mode is an unverified discount shown** (Price Watch decides).
- Whether `member_only`/`hidden` need a paid plan is an owner decision. Default: **allowed on every plan** (it lowers brand fear, plan-and-risks risk 3), controlled by the `display_modes_allowed` entitlement so it can change by config.

## Consequences

**Good**
- Pricing experiments after the 15 interviews need no code.
- Past orders keep their commission; finance reports stay correct.
- The same model serves new markets (ADR-0006).

**Bad / risks**
- More modelling and admin UI now.
- Without D1, real-money checkout cannot start (also blocked by D5).
- VAT on plan fees (V24) may change invoices.

## Verify-register rows
- **V6** ETA e-invoices for commission and fees; VAT
- **V24** VAT on seller plans and B2B lots
- **V28** enforceability of a commission surcharge as a penalty

## Related
ADR-0003 (ledger and settlement), ADR-0004 (Plus is separate), ADR-0006 (per market), ADR-0009 (condition grading is a free tool on every plan by default), `docs/specs/price-watch.md` §3.
