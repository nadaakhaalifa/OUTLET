# Brand and owner operating model (brand accounts, seller subscriptions, platform operations)

Status: **Draft design, not built.** Owner decisions open (ADR-0056, Proposed). Template: master prompt A3. Spec refs: 9, 15.6, 19, 19.1, 20.4, 22, 23, T4, B1 to B5. Builds on ADR-0003, ADR-0021 (accepted), ADR-0031, ADR-0049, specs `brand-onboarding.md`, `sellers-module.md`, `brand-review-and-provisioning.md`, `seller-auth.md`, `seller-settings.md`, `payouts.md`, `ledger-chart-of-accounts.md`, `tax-eta.md`, `reconciliation.md`.
Research input: `research_notes/Marketplace business model end to end/` (search snippets only, confidence Low to Medium, no tier or seller-billing source found). The report `reports/Marketplace business model end to end.md` did not exist when this was written.

**Not to be confused with HAUL Plus (spec 14).** Plus is a consumer subscription (shopper pays, `subscriptions` module, `plans` table, migration 0036). This spec is a **B2B seller subscription**: the brand pays Z-OUTLET for a Seller Center plan. Separate tables, module, ledger accounts and tax document kind. No code path is shared except pure helpers (proration rounding, largest-remainder recognition).

Every figure in this document is a development fixture or a placeholder. Nothing here is a price, a commission rate or a contract term.

---

## 1. Brand account lifecycle

### 1.1 What exists today (grep-verified, 2026-10-18)
| Area | Exists | Where |
|---|---|---|
| Application + KYC machine | DRAFT, SUBMITTED, AUTO_CHECKS, IN_REVIEW, NEEDS_INFO, APPROVED, REJECTED (appeal once, 30 d), WITHDRAWN, SUSPENDED | `packages/domain/src/sellers/machine.ts`, migration 0051 |
| Review queue, claim, cosign, audited document URLs | yes | `apps/api/src/modules/admin/brand-review`, admin-web `/brand-applications` |
| Provisioning: approved application -> one store (status ACTIVE), owner grant | yes | `apps/api/src/modules/stores/provisioning` |
| Store machine | DRAFT, ACTIVE, PAUSED, SUSPENDED (no RESTRICTED, OFFBOARDING, OFFBOARDED) | `apps/api/src/modules/stores/domain/store.ts:12,122` |
| Seller identity, passkey/TOTP mandatory, step-up | yes | `apps/api/src/modules/auth/seller`, migration 0053 |
| Roles owner, manager, catalog, warehouse, finance, support; invites (72 h, single use) | yes | `seller_memberships`, `seller-settings` |
| Settings: profile, vacation, payout IBAN (48 h hold on change), shipping, returns (>= statutory min), notifications, team, ETA enrolment | yes | migration 0055, seller-web `/settings/*` |
| Brand authorization evidence | ownership basis + trademark / authorization / proof of purchase at application time only | `brand-onboarding.md` R39 |
| Legal-entity (organisation) above store | **missing**: one application = one store; several brands = several applications | `brand-onboarding.md` line 37 |
| Commission source | **missing**: `CommerceTermsPort` has only `DevCommerceTerms` (15% fixture), VR-INT-01 | `apps/api/src/composition/checkout-adapters.ts:37` |
| Seller plans, subscription, entitlements, seller billing | **missing** (grep: no `seller_subscription`, no entitlement table) | n/a |
| Offboarding, store closure, data hand-back | **missing** | n/a |
| Authorization renewal (expiring brand letters), restricted-brand list | **missing** | n/a |

Seller Center pages present (`apps/seller-web/src/app`): apply, start, onboarding, dashboard, catalog (new, import), media, channels, drops, orders, returns, finance (payouts, statements, invoices from Z-OUTLET via `tax-eta` seller invoice routes), insights, forecasts, price-trust, ads, marketing, hub, resale, settings (profile, delivery, eta, notifications, payout, returns, shipping, team), team. **Missing pages:** plan and billing, usage against limits, restrictions and appeals, brand authorizations, store closure, legal-entity view.

### 1.2 Lifecycle (target)
Store lifecycle status stays a small machine; independent constraints become **restrictions** (orthogonal rows), not more statuses.

| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (a) One big status enum (ACTIVE, RESTRICTED_NONPAYMENT, RESTRICTED_HEALTH, ...) | low at first | poor: two causes at once cannot be expressed; lifting one clears the other | low | combinatorial |
| (b) Lifecycle status + `store_restrictions` rows (kind, source, reason, starts, ends) | medium | exact: each cause added and lifted on its own, audited | medium | linear in causes |

**Choice (b).** Price-integrity drop blocks (30 d), health penalties, non-payment, payout risk holds and authorization expiry already come from different modules at different times; only independent rows let each be lifted by its own source without clobbering the others.

```
INVITED (optional, admin curated) -> APPLIED (application DRAFT..IN_REVIEW, existing machine)
APPROVED -> PROVISIONED (store row, status ONBOARDING) -> ACTIVE (checklist complete: legal identity, payout account, shipping, return policy, Arabic profile, >= 1 size chart if apparel)
ACTIVE <-> PAUSED (seller vacation, existing)          ACTIVE|PAUSED -> SUSPENDED (admin or 9.5 ladder, human review <= 5 business days)
SUSPENDED -> ACTIVE (reinstate) | OFFBOARDING          ACTIVE|PAUSED -> OFFBOARDING (seller closure request, or termination)
OFFBOARDING -> OFFBOARDED (all obligations closed)     OFFBOARDED is terminal (a returning brand re-applies)
```
- New store status values: `ONBOARDING`, `OFFBOARDING`, `OFFBOARDED` (expand-only migration; `DRAFT` kept for compatibility, mapped to `ONBOARDING` in new code).
- Restriction kinds (initial): `no_new_listings`, `no_drops`, `no_ads`, `listing_cap`, `payout_hold`, `delisted_brand:{brandId}`, `no_new_orders`. Sources: `billing`, `health`, `price_integrity`, `trust_safety`, `risk`, `authorization_expiry`, `offboarding`. Effective restriction set = union of active rows; checks read one cached projection per store (invalidated by outbox).
- **Invariants:** a restriction never deletes data; a restriction never blocks fulfilling, returning or refunding an order already placed (CPL 181/2018); `payout_hold` only from `risk` or `trust_safety` with a reason code, never from `billing` unless the Seller Agreement has a set-off clause (Decision D7).

### 1.3 Offboarding
1. Request (owner, step-up 5 min) or termination (trust_safety, reason code, dual approval). Notice period configurable (placeholder 30 d; termination for cause: immediate).
2. `OFFBOARDING`: restrictions `no_new_orders`, `no_new_listings`, `no_drops`, `no_ads`; listings unpublished (kept); open orders fulfil; return windows run from `delivered_at` (14/30 d); disputes resolve.
3. Final settlement: last payout after the latest line is `CLOSED` + 3 d; a negative `seller_payable` becomes a receivable invoice (collections process, never auto-debit without mandate). Prepaid ads balance: refunded to original method or offset per ads terms (VERIFY); subscription ends at period end, no proration refund unless Decision D5 says otherwise.
4. `OFFBOARDED`: team memberships revoked, sessions revoked, store hidden, slug reserved 12 months. Data retention: orders, invoices, ledger, payouts, tax documents kept for the tax period (5 to 7 y, VERIFY, `orders_tax_records`); KYC records contract end + 5 y (B1); buyer PII access already ends 30 d after delivery/return closure (B1); catalogue content and images kept 90 d for an export download, then deleted except images referenced by order snapshots. Seller data export (CSV: catalogue, orders, statements, invoices) offered during OFFBOARDING.

### 1.4 Permissions matrix (deny by default, store-scoped, foreign store = 404)
`R` read, `W` write. **Bold** = proposed (not in `packages/policy/src/rules.ts` today). Every seller session is FULL only with passkey or TOTP (existing). Step-up (strong factor asserted within 5 min) required where marked `S`.

| Resource / action | owner | manager | catalog | warehouse | finance | support |
|---|---|---|---|---|---|---|
| store_product (catalogue, drops ride on it today) | RW | RW | RW | R | R | R |
| store_inventory | RW | RW | R | RW | - | - |
| store_order | RW | RW | - | RW | R | R |
| store_return | RW | RW | - | RW | - | RW |
| store_payout (statements, payouts) | R | R | - | - | R | - |
| payout bank account | W S | - | - | - | W S | - |
| store_settings | RW | R (W proposed, existing ADR candidate) | - | - | - | - |
| store_staff (invite, role, remove) | RW S | R (invite non-managerial, existing service) | - | - | - | - |
| **store_drop** (split from store_product) | RW | RW | R | - | - | - |
| **store_ads** | RW | RW | - | - | R | - |
| **store_subscription** (view plan, usage) | R | R | - | - | R | - |
| **store_subscription change / cancel** | W S | - | - | - | - | - |
| **store_billing** (invoices, payment method) | RW S | R | - | - | RW S | - |
| **store_restriction appeal** | W | W | - | - | - | - |
| **store_closure** (offboarding request) | W S | - | - | - | - | - |
| **brand_authorization** (upload, renew) | RW | RW | R | - | - | - |
| analytics read / export (ADR-0049) | R / R | R / R | - | - | R / - | - |

Last-owner protection (existing) extends to closure: the request needs an owner; a store must always have >= 1 owner until OFFBOARDED.

### 1.5 Multi-store brands
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (a) Store is the only tenant; group stores by `legal_entity_id` attribute only | low | good for RLS, consolidated invoice possible | low | fine |
| (b) New `seller_accounts` org tenant owning stores, memberships at org level | high (RLS, policy, every route) | best for big groups | high | best |

**Choice (a) now, (b) deferred.** Add `seller_legal_entities(id, legal_name_ar, legal_name_en, commercial_register_no, tax_registration_no, kyc_application_id)` and `stores.legal_entity_id`. One KYC per legal entity reused by its next brand application (fast-track: documents already verified unless expired). Subscription is **per store** (the tenant key everywhere), with an optional consolidated e-invoice per legal entity per cycle (one document, one line per store). Memberships stay per store; an owner of several stores switches store in the header (existing token carries several brand grants).

### 1.6 Brand authorization evidence (ongoing, not only at application)
`brand_authorizations(id, store_id, brand_id, basis brand_owner|authorized_distributor|third_party_reseller, document_ids[], territory, valid_from, valid_to, status PENDING|VERIFIED|EXPIRED|REVOKED, verified_by)`. Rules: a listing of brand X needs a VERIFIED row for X (or X is the store's own brand); third-party resellers carry counterfeit review flags (spec 27) and proof-of-purchase per batch; expiry -> 30 d reminder -> restriction `delisted_brand:{X}` at `valid_to`. Brand-owner notice-and-takedown (48 h, spec 27) can revoke. Restricted-brand list (brands that require owner authorization for any reseller) is admin config. Parallel-import policy is Decision D11.

---

## 2. Seller subscription and entitlements

### 2.1 Model choice
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (a) Tiers in code (enum + switch per feature) | low | changes need deploys, no history | engineering per change | poor |
| (b) Free-form JSON entitlements per plan | low | no typing, typos silently grant | low | medium |
| (c) Typed entitlement catalogue + effective-dated plan versions with one row per (version, entitlement) | medium | Zod-typed values, audit per change, point-in-time reproducible | medium | good |

**Choice (c).** Tiers are config: adding a sixth tier, renaming one or changing a limit is a dual-approved data change; the entitlement catalogue (the set of keys and their types) is code, because each key needs an enforcement point.

### 2.2 Data
| Table | Key columns | PII |
|---|---|---|
| `seller_plans` | `id, code UNIQUE, rank smallint (1..n, ordering for upgrade/downgrade), is_fallback bool, status ACTIVE|RETIRED` | P0 |
| `seller_plan_versions` | `id, plan_id, version, name_ar, name_en, price_net_minor BIGINT, currency, interval month|year, trial_days, commission_default_bps, effective_from, effective_to, approved_by, approval_id`; EXCLUDE overlap per plan; immutable once effective | P0/P1 |
| `seller_plan_commission_rates` | `plan_version_id, category_id, commission_bps` | P1 |
| `entitlement_definitions` (seeded by migration, code-owned) | `key, kind bool|int|enum, unit, enforcement_point, downgrade_policy block_new|freeze_excess_after_grace|immediate, grace_days` | P0 |
| `seller_plan_entitlements` | `plan_version_id, key, value jsonb` (validated by the definition's Zod schema at write) | P1 |
| `store_entitlement_overrides` | `store_id, key, value, reason, valid_to, approval_id` (negotiated deals, founding partners) | P1 |
| `seller_commission_agreements` | `store_id, commission_bps, category_id NULL, valid_from, valid_to, approval_id, seller_agreement_version` | P1 |
| `seller_subscriptions` | `id, store_id UNIQUE (one live), plan_version_id, status, period_start, period_end, anchor_day, trial_end, pending_plan_version_id, cancel_at, pause_until, collection_method psp_token|invoice_transfer|fawry_invoice|payout_setoff, psp_token_ref, dunning_attempt, version` | P1 (token ref P2) |
| `seller_billing_documents` | `id, subscription_id, kind charge|proration|credit_note|refund, period, net, vat, gross, tax_document_id, status, idempotency_key UNIQUE` | P1 |
| `seller_subscription_events` | append-only history + outbox in the same tx | P1 |
| `entitlement_usage` | `store_id, key, period, used int` (counters such as drops per month) | P1 |

### 2.3 Entitlement catalogue (initial keys; values are per plan version)
| Key | Kind | Enforcement point | Downgrade policy |
|---|---|---|---|
| `catalogue.max_active_listings` | int | catalog publish | block_new (existing stay live) |
| `team.max_seats` | int | team invite/accept | freeze_excess_after_grace 14 d (newest non-owner seats become inactive, never deleted; owner never) |
| `drops.per_month` | int | drop schedule | block_new |
| `drops.types` | enum set | drop create | block_new (scheduled drops already published run) |
| `ads.included_credit_minor` | int (piastres of ad value per period) | ads spend: consumed before the prepaid balance; not cash, not carried over | immediate (next period) |
| `analytics.depth` | enum basic|advanced|full | seller-analytics read routes | immediate (history kept, view narrowed) |
| `analytics.export` | bool | export route | immediate |
| `api.access` | enum none|read|read_write | channel/API keys | 30 d read-only then none |
| `api.rate_per_min` | int | API gateway | immediate |
| `support.sla_hours` | int | support desk routing | immediate |
| `fulfilment.options` | enum set ship_by_seller|fbh | shipment create | block_new |
| `payout.cycle` | enum weekly|twice_weekly | payout scheduler | next cycle |
| `payout.buffer_days_after_close` | int (>= 0, default 3) | `PAYOUT_HOLD_AFTER_CLOSE_MS` becomes per-store | next cycle |
| `commission.override_allowed` | bool | commission resolver | n/a |
| `storefront.customisation` | enum standard|branded|custom_sections | storefront builder | immediate (content kept, rendering falls back) |
| `price_integrity.channel_connections` | int | `POST /v1/seller/channels` | block_new |

**Hard rule: no entitlement may weaken a legal or safety control.** Not plan-dependent for anyone: return windows (B5), price integrity rules and the 9.5 ladder (fully automatic, spec 9), KYC, seller legal identity on listings, payouts only after `CLOSED` (the return window), dual approval, Buy Box fairness (a plan never adds a Buy Box weight; spec 20.4 weights stay plan-blind), "Sponsored" labelling. Payout speed can shorten only the post-close buffer and the cycle, never pay before `CLOSED`; risk holds override it.

### 2.4 Commission resolution (closes VR-INT-01 for production)
Production `CommerceTermsPort.commissionBps(storeId, categoryId, atMs)`: first match of (1) active `seller_commission_agreements` for store+category, (2) same for store, any category, (3) plan version category rate, (4) plan version default, (5) fail closed (checkout refuses the line: `commission_terms_missing`). The resolved bps is snapshotted on `seller_orders.commission_rate_snapshot` (column exists, migration 0019), so later changes never re-price old orders. Commission changes for existing sellers take effect after the notice period (D9).

### 2.5 Five-tier structures: options for the owner (placeholders only)
All three use the same model; they differ only in data. `P1..P5` = monthly net fee placeholders, `c1..c5` = commission bps placeholders. Research found **no sourced commission or seller-plan benchmark** for Egypt (notes: "Commission/margin structures ... not found"); the unit-economics notes give an **assumption-only** break-even commission of about 13.5% of kept GMV in a base case (range unknown, every input unsourced). Treat that as a sanity check, not evidence.

**Option A: subscription + commission ladder.** Fee rises, commission falls.
| Tier | Fee | Commission | Listings | Seats | Drops/mo | Ad credit | Analytics | API | Payout | Support |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 0 | c1 (highest) | small cap | 2 | 0 to 1 | 0 | basic | none | weekly | 72 h |
| T2 | P2 | c2 | medium | 5 | 2 | small | basic | none | weekly | 48 h |
| T3 | P3 | c3 | large | 10 | 4 | medium | advanced | read | weekly | 24 h |
| T4 | P4 | c4 | very large | 25 | 8 | large | advanced + export | read_write | twice weekly | 8 h |
| T5 | P5 or negotiated | c5 / agreement | unlimited | 50 | negotiated | negotiated | full | read_write | twice weekly, buffer reduced | dedicated manager |
Pros: predictable recurring revenue, rewards scale. Cons: fee is a barrier at cold start (research: supply acquisition is the launch bottleneck).

**Option B: commission-only, free tiers by performance.** Fee 0 for all; tier is earned from trailing 90-day GMV and Seller Health Score; higher tiers get lower commission and more limits. Pros: no billing friction, no dunning; aligns with cold start. Cons: no recurring revenue; tier churn when sales dip (needs hysteresis: promote after 1 qualifying quarter, demote after 2).

**Option C: hybrid.** T1 to T2 free (performance-earned like B), T3 to T5 paid add-on bundles (analytics, API, FBH, ad credit, faster payout) with a commission discount. Pros: free entry plus monetised power features. Cons: two tier mechanics to explain.

Founding-partner terms (any option): `store_entitlement_overrides` + `seller_commission_agreements` with `valid_to`, e.g. top tier free for N months for the 30 launch brands (P1 checklist), dual-approved. Engineering default if the owner does not choose before build: **Option B data with fees all zero**, because it needs no billing rail and no VAT decision to launch, and A or C become a data change later.

### 2.6 Billing mechanics
**Tax point and documents.** Seller subscription is a B2B supply by Z-OUTLET: net-quoted price, VAT 14% added once (`addVatToNet`, existing single rounding point), ETA `seller_einvoice` with a new line type `seller_subscription` (tax-eta kinds already include `commission`, `fee`, `ads`, `fbh_service`). Seller needs a tax registration number (existing rule).
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (a) Invoice at period start, receivable, dunning on the invoice | high: receivable, bad debt, VAT on unpaid invoices | standard accrual | VAT paid on uncollected fees (VERIFY relief) | fine |
| (b) Charge first, e-invoice on successful payment (prepaid), like the ads top-up module | low | exact: no receivable, no write-off | none | fine |
**Choice (b)** for card and wallet; for bank transfer and Fawry a non-tax payment request is issued and the e-invoice follows receipt. Matches the existing ads precedent ("the advance payment is the tax point", VERIFY VR-B4).

**Collection methods.** PSP card-on-file token (recurring, VERIFY Paymob recurring: VR-PAY-12), bank transfer against a reference, Fawry invoice reference, and **payout set-off** (deduct from the next payout) only if the Seller Agreement contains a signed set-off mandate (D7). Set-off is a ledger transfer from `seller_payable`, never a withdrawal from a pooled account.

**Rules.** Anniversary billing (period from the start date; day 29 to 31 anchors clamp to month end). Trial: `trial_days` from the plan version, one per legal entity (commercial register hash), card not required for paid-tier trial; trial end without payment -> fallback plan. Upgrade: immediate, prorated by days (2.7). Downgrade: at period end, no refund. Pause: not offered for paid tiers (the brand can drop to the fallback tier); store vacation (existing) is separate. Cancel: at period end -> fallback plan; the store keeps selling on the fallback plan unless it also requests closure. Price change: a new plan version; existing subscribers move at the first renewal after a notice of >= 30 d (placeholder, D9); grandfathering is a per-version flag. Refund: only for billing error, platform outage beyond SLA credit policy, or a first-charge cooling-off if D5 adopts one; always a reversing entry plus ETA credit note.

**Dunning and grace.** Renewal attempt on `period_end`; retries day 1, 3, 7 (same cadence as Plus); entitlements continue during a 7-day grace (`PAST_DUE`); after grace -> `DOWNGRADED_NONPAYMENT`: effective plan = fallback, downgrade policies of 2.3 apply, restriction `billing` adds nothing else (store stays sellable, orders, returns, payouts continue). Paying the outstanding renewal restores the plan from payment time (new period). Never delete data; over-limit content is frozen (unpublished or inactive), never removed.

### 2.7 Proration (pure function, property-tested, mutation >= 80%)
`prorate(netOld, netNew, periodDays, remainingDays) -> { creditNet, chargeNet, deltaNet }` with `creditNet = halfEven(netOld * remaining / period)`, `chargeNet = halfEven(netNew * remaining / period)`, `deltaNet = chargeNet - creditNet`. Upgrade charges `deltaNet + VAT(deltaNet)`; one e-invoice for the delta (or a credit note + new invoice if ETA requires separate documents, VERIFY). Monthly <-> yearly switches use the same formula on days. Properties: `0 <= creditNet <= netOld`; `remaining = 0 => delta = 0`; `remaining = period => delta = netNew - netOld`; delta is monotone in `netNew`; for any split of a period into consecutive switches, revenue recognised + deferred + credited = cash net received (no piastre created or lost); downgrade never yields a negative charge (downgrades are period-end only).

### 2.8 Seller subscription state machine
```
PENDING_PAYMENT --paid--> ACTIVE            PENDING_PAYMENT --start_trial--> TRIALING
TRIALING --paid--> ACTIVE                    TRIALING --trial_end_unpaid--> ON_FALLBACK
ACTIVE --renewal_failed--> PAST_DUE          PAST_DUE --paid--> ACTIVE
PAST_DUE --grace_elapsed--> ON_FALLBACK      ON_FALLBACK --paid(upgrade)--> ACTIVE
ACTIVE --cancel--> CANCELLED_AT_PERIOD_END   CANCELLED_AT_PERIOD_END --reactivate--> ACTIVE
CANCELLED_AT_PERIOD_END --period_end--> ON_FALLBACK
ACTIVE --upgrade(paid delta)--> ACTIVE (new version)   ACTIVE --schedule_downgrade--> ACTIVE (pending_plan_version_id)
any --store_offboarded--> ENDED (terminal)
```
`ON_FALLBACK` is a live subscription on the `is_fallback` plan (fee 0). Guards: a paid plan needs a collection method; upgrade needs `rank(new) > rank(current)`; owner role + step-up. Invalid transitions throw the shared typed error; every edge unit-tested; property test: no reachable state outside the table.

### 2.9 Ledger (new account types, forward INSERT into `ledger_account_types` like migration 0074)
`deferred_seller_subscription_revenue:{store}` (liability), `seller_subscription_revenue` (revenue), existing `platform_vat_output`, `psp_clearing:{psp}`, `bank_settlement:{account}`, `seller_payable:{store}`. Worked examples (fixture: net 100,000 piastres per 30-day month, VAT 14%):

| # | Event | Dr | Cr |
|---|---|---|---|
| S1 | Monthly charge by card | `psp_clearing:psp1` 114,000 | `deferred_seller_subscription_revenue:S` 100,000; `platform_vat_output` 14,000 |
| S2 | Period end recognition | `deferred_...:S` 100,000 | `seller_subscription_revenue` 100,000 |
| S3 | Upgrade on day 11 to net 250,000 (20 of 30 days left): credit 66,667, charge 166,667, delta 100,000; first recognise days 1 to 10 | `deferred_...:S` 33,333 | `seller_subscription_revenue` 33,333 |
| S3b | Delta charge | `psp_clearing:psp1` 114,000 | `deferred_...:S` 100,000; `platform_vat_output` 14,000 |
| S3c | Period end (deferred now 66,667 + 100,000) | `deferred_...:S` 166,667 | `seller_subscription_revenue` 166,667 |
| S4 | Payout set-off (only with mandate, D7) | `seller_payable:S` 114,000 | `deferred_...:S` 100,000; `platform_vat_output` 14,000 |
| S5 | Refund of S1 (billing error) | `deferred_...:S` 100,000; `platform_vat_output` 14,000 | `psp_clearing:psp1` 114,000 (+ ETA credit note) |
| S6 | Yearly charge net 1,000,000 | `psp_clearing` 1,140,000 | `deferred_...:S` 1,000,000; VAT 140,000; then 12 monthly recognitions by largest remainder (83,334 x 4, 83,333 x 8) |
Check S3: cash net 200,000 = recognised 33,333 + 166,667. Commission (existing, unchanged): order recognition credits `platform_commission` and `platform_vat_output` per `ledger-chart-of-accounts.md` R3; included ad credit posts nothing at grant or use (bundled in the subscription; VAT on bundled allowance VERIFY).
Idempotency keys: `seller_sub_charge:{subscriptionId}:{period}:{attempt}`, `seller_sub_recognise:{subscriptionId}:{period}:{seq}`, `seller_sub_refund:{billingDocumentId}`.

### 2.10 Reconciliation (adds to `reconciliation.md`)
Nightly: (1) every `seller_billing_documents` row with status PAID has one journal entry and one ACCEPTED ETA document; (2) PSP settlement lines for subscription charges match `psp_clearing` (existing matcher, new ref type); (3) `deferred_seller_subscription_revenue:{store}` equals the schedule's unrecognised remainder; (4) the sum of deferred balances for ENDED subscriptions is 0; (5) every subscription whose effective plan is not the fallback has a PAID document covering today. Any break -> finance ticket, aging > 3 d -> escalation.

---

## 3. Owner (platform) operating model

### 3.1 Admin console modules: exists vs missing (`apps/admin-web/src/app/(console)`)
| Module | Today | Missing |
|---|---|---|
| Brand applications (queue, claim, cosign, documents) | `/brand-applications` | sweeper for parked provisioning, reviewer identity directory |
| Sellers (KYC state, suspend, reinstate) | `/sellers`, `/suspensions` | restrictions view, health score, offboarding, legal entities, brand authorizations |
| **Seller plans, entitlements, commission config** | none (only `/plus` for the consumer plan) | full module (WP-5) |
| **Seller subscriptions ops** (status, dunning, overrides, founding deals) | none | full module |
| Approvals (dual control) | `/approvals`, `/elevation` | new approval kinds `seller_plan_change`, `commission_agreement`, `store_termination` |
| Finance (payouts, holds) | `/finance` | reconciliation console with break list, seller billing |
| Tax (ETA) | `/tax` | seller subscription line, credit notes (tax-eta gap) |
| Price integrity, matching, ranking | `/price-integrity`, `/price-matching`, `/ranking` | none for this spec (automatic) |
| Trust and safety, moderation, returns | `/moderation`, `/returns` | counterfeit takedown queue, brand-owner portal |
| Support desk | none | tickets, WhatsApp inbox, macros (spec 23) |
| Privacy (DPO), PII view | `/privacy`, `/pii` | none here |
| Flags and kill switches | `/flags` | new switches `kill.seller_billing`, `kill.seller_plan_changes` |
| Analytics, engineering, calendar | `/`, `/engineering`, `/calendar` | seller-economics KPIs (3.4) |

### 3.2 Staff role matrix and segregation of duties
Existing roles: ops, finance, trust_safety, support, marketing, dpo, security, super_admin (`packages/domain/src/admin/roles.ts`); passkey mandatory, JIT elevation, reason-coded PII views, hash-chained audit.
| Action | Requests | Approves (different person) |
|---|---|---|
| Create or change a seller plan version, entitlement values | finance | finance or super_admin (reuse `plan_price_change`, ALWAYS dual) |
| Commission agreement or founding-partner override | marketing or ops (commercial owner) | finance |
| Payout above threshold | finance | finance or super_admin (existing) |
| Refund above threshold, subscription refund | support or finance | finance (existing `refund`) |
| KYC approve; high-risk cosign | ops or trust_safety | second ops or trust_safety (existing) |
| Store suspension (non-price) / termination | trust_safety | ops lead; termination also super_admin |
| Role grant | super_admin | security or super_admin (existing) |
| Kill switch flip | ops | none at launch (speed), audited, alert to security |
| Break-glass | super_admin | security, time-boxed, drilled quarterly |
SoD rules: the person who configures a plan cannot approve a payout for a store on a negotiated agreement they requested; nobody approves their own request (domain + DB CHECK, existing); support cannot see bank details; finance cannot edit KYC decisions.

### 3.3 Launch-stage staffing (assumption, no sourced benchmark found)
Owner + 1 ops/KYC (brand applications, sellers), 1 finance (payout approvals, reconciliation, tax), 2 support (AR/EN, WhatsApp), trust and safety shared with ops, DPO named (B1, may be external), security on call shared with engineering. Must be automatic: price integrity and the 9.5 ladder (no manual review except suspension review), auto-checks, payout scheduling, dunning, entitlement enforcement, reconciliation matching, SLA auto-cancel (24 h accept), ETA submission and retry, restriction lifting on payment.

### 3.4 KPIs reviewed weekly
GMV, take rate (commission + subscription + ads over GMV), contribution margin per order, seller count by tier and status, activation time (approval to first sale), seller churn, subscription MRR and dunning recovery, payout success, reconciliation breaks, COD refusal, return rate, Health Score distribution, KYC SLA breaches.

---

## 4. End-to-end business flows

### 4.1 Prepaid order to payout
```
Shopper -> PSP (card/wallet/InstaPay) --capture--> Dr psp_clearing (gross)
  order recognised per seller order: Cr seller_payable:{store} (merch - commission - VAT on commission)
                                     Cr platform_commission, Cr platform_vat_output, Cr shipping_revenue (+VAT)
PSP settlement T+n --> Dr bank_settlement, Dr provider_fee_expense / Cr psp_clearing
delivered_at -> return window (14 d change of mind, 30 d defect) -> SellerOrder CLOSED
CLOSED + buffer (3 d default, plan-adjustable down) -> weekly payout (Sun 10:00 Cairo)
  Dr seller_payable / Cr bank_settlement (ledger-first), dual approval >= threshold, IBAN name match
ETA: seller_einvoice to seller for commission and fees; seller issues goods e-receipt to shopper
```
Caveat: ADR-0021 deviation F-3 stands: the chart models "Z-OUTLET collects and pays out" (`bank_settlement`) pending VR-03/VR-22; a PSP sub-merchant product would add `psp_submerchant_balance:{store}`. This spec does not change that.

### 4.2 COD
Placement posts nothing. Delivery: Dr `cod_clearing:{courier}` / Cr seller payable, commission, VAT, shipping. Remittance: Dr bank, Dr `courier_fee_expense` / Cr `cod_clearing`; aging > 3 d escalates. Refusal: no recognition, RTO cost per refusal policy (who bears it is D6).

### 4.3 Returns and refunds
Return approved -> RefundRouter (15.6): mirror postings on the cumulative refunded value (commission and VAT returned to the seller, existing R4). After payout -> `seller_payable` negative -> netted oldest-first next cycle (existing payouts R3). BNPL -> provider cancellation only.

### 4.4 Subscription revenue
Charge (S1) -> e-invoice -> monthly recognition (S2) -> reconciliation (2.10). Non-payment -> fallback plan, never a payout hold unless mandate (D7).

### 4.5 Weekly operating rhythm (Africa/Cairo; Friday and Saturday weekend)
| Day | Activity |
|---|---|
| Daily 06:00 | Reconciliation report (PSP, COD, BNPL, ETA, store credit, seller billing); breaks triaged by finance |
| Daily | KYC queue (5 business-day SLA), seller acceptance SLA monitor, dunning job, restriction expiry job |
| Sunday 10:00 | Payout cycle scheduled; holds reviewed; approvals Sunday to Monday |
| Monday | KPI review (3.4); drops calendar for the next 2 weeks locked (`SCHEDULED` freezes price and stock) |
| Wednesday | Merchandising and promotions sign-off for the weekend; seller-facing newsletter |
| Monthly 1st | Subscription MRR, churn, tier migrations (Option B hysteresis run), commission agreement expiries |
| Before mega events | 48 h release freeze, 20x load test, intraday reconciliation |

---

## 5. Module contracts (A3) for new modules

### 5.1 `seller-subscriptions` (API module) + `packages/domain/src/seller-billing` (pure)
**API** (audience `seller_api`, store-scoped, foreign = 404, Problem+JSON, writes need `Idempotency-Key`):
| Route | Roles | Idem | Limit |
|---|---|---|---|
| `GET /v1/seller/plans` (published versions, AR/EN) | any member | n/a | 60/min |
| `GET /v1/seller/stores/{storeId}/subscription` (plan, status, period, usage vs limits) | owner, manager, finance | n/a | 60/min |
| `POST .../subscription/quote` (pure: proration, VAT, effective date) | owner | n/a | 30/min |
| `POST .../subscription/change` (upgrade now / downgrade at period end), step-up | owner | yes | 10/min |
| `POST .../subscription/cancel`, `/reactivate`, step-up | owner | yes | 10/min |
| `PUT .../billing/payment-method` (PSP hosted tokenisation only, SAQ A), step-up | owner, finance | yes | 10/min |
| `GET .../billing/documents`, `/{id}` (links to ETA PDF) | owner, finance | n/a | 60/min |
| `GET .../restrictions`, `POST .../restrictions/{id}/appeal` | owner, manager | appeal yes | 10/min |
| Admin: `GET/POST /v1/admin/seller-plans`, `POST /v1/admin/seller-plans/{id}/versions` (dual approval) | finance | yes | 30/min |
| Admin: `POST /v1/admin/stores/{id}/commission-agreements`, `/entitlement-overrides` (dual approval) | marketing/ops request, finance approve | yes | 30/min |
| Admin: `GET /v1/admin/seller-subscriptions?status=` , `POST .../{id}/retry-charge` | finance | yes | 60/min |
| Webhook: `POST /v1/webhooks/{provider}/recurring` (existing pattern: HMAC, raw body, dedup) | provider | yes | n/a |

**Events (outbox, same tx):** `seller_subscription.started|trial_started|renewed|payment_failed|past_due|downgraded_nonpayment|changed|cancel_scheduled|ended`, `seller_plan_version.published`, `entitlements.changed(storeId)` (consumers: catalog, team, drops, ads, analytics, payouts, API gateway invalidate their projection), `store_restriction.added|lifted`. Analytics: `seller_plan_viewed`, `seller_plan_changed(from_rank,to_rank)`. Payloads ids, ranks, enums and amounts only.

**Entitlements read port** (public `index.ts`): `EntitlementsPort.forStore(storeId, atMs) -> Readonly<{ [key]: value }>` resolved as override > effective plan version > fallback plan; cached per store, invalidated by `entitlements.changed`; on cache or DB failure **fail closed to the fallback plan's values**, never to unlimited.

**Failure handling:** PSP timeout 10 s, idempotent retry x3 keyed by charge key; webhook DLQ + replay; ETA submission via the existing queue; a charge succeeded but the state write lost -> reconciler finds PSP line without document and completes it (idempotent). User-visible: "payment pending" banner, no loss of entitlements during grace.

**Security and abuse (API Top 10 2023):** API1/API5 store-scoped + role per route, negative tests per route; API3 strict Zod allow-lists (client cannot send price, VAT, period or plan version id other than a published one); API6 plan-change flapping capped (3 changes per period), trial abuse keyed by commercial register hash + tax number; API4 rate limits above; dual approval for plan versions and agreements (requester != approver, DB CHECK); an entitlement value outside its definition schema is refused at write; audit row for every admin write (hash chain). Threat notes STRIDE: spoofing (seller token, step-up), tampering (immutable effective versions, ledger), repudiation (audit), information disclosure (another store's agreement terms = 404), DoS (quote endpoint pure and rate limited), elevation (a manager cannot change plan; admin cannot approve own).

**Metrics:** MRR, paid share by tier, trial to paid, dunning recovery rate, involuntary downgrade rate, entitlement denials by key (guardrail: support tickets about limits), reconciliation breaks = 0. SLO: change and charge p95 < 2 s; entitlement read p95 < 20 ms.

### 5.2 Migrations (next free numbers after 0097, check `packages/db/migrations` before writing)
M1 `seller_plans`, `seller_plan_versions`, `seller_plan_commission_rates`, `entitlement_definitions` (seed), `seller_plan_entitlements`, `store_entitlement_overrides`, `seller_commission_agreements` + RLS (sellers read published plans and own rows; staff by role). M2 `seller_subscriptions`, `seller_billing_documents`, `seller_subscription_events`, `entitlement_usage`. M3 ledger account types (forward INSERT). M4 `stores` status values `ONBOARDING|OFFBOARDING|OFFBOARDED`, `store_restrictions`, `seller_legal_entities`, `stores.legal_entity_id`, `brand_authorizations`. M5 tax-eta line type `seller_subscription` + credit note kind. All expand-only; `data_inventory.yaml` tags for every column (CI gate).

### 5.3 Work packages (file ownership, tier)
| WP | Scope (files) | Tier |
|---|---|---|
| WP-0 | Owner decisions D1 to D12; ADR-0056 accepted | owner + counsel |
| WP-1 | `packages/domain/src/seller-billing/*` (proration, recognition schedule, state machine, entitlement resolution, downgrade policy) | architect writes signatures and properties, builder implements, tester property + mutation |
| WP-2 | Ledger account types and builders `sellerSubscriptionCharged|Recognised|Refunded|SetOff` in `packages/domain/src/chart-of-accounts` + migration M3 | builder; **chief-reviewer checkpoint** (money) |
| WP-3 | `apps/api/src/modules/seller-subscriptions` (routes, repos, jobs: renewal, dunning, recognition), migrations M1, M2 | builder |
| WP-4 | Production `CommerceTermsPort` (commission resolver) in `apps/api/src/composition/checkout-adapters.ts` + `seller_commission_agreements` | builder; chief-reviewer (money) |
| WP-5 | Admin web: seller plans, versions, agreements, subscriptions ops pages under `apps/admin-web/src/app/(console)/seller-plans`, approvals kinds in `packages/domain/src/admin/approval.ts` and `packages/policy` | builder; architect reviews policy change |
| WP-6 | Seller web: `/settings/plan`, `/settings/billing`, usage meters, restrictions and appeal, store closure | builder (UX principles, AR/EN, RTL) |
| WP-7 | Enforcement points (catalog publish, team invite, drop schedule, ads spend, analytics depth, payout buffer) reading `EntitlementsPort` | builder, one PR per module owner |
| WP-8 | Store lifecycle extension, `store_restrictions`, offboarding saga, legal entities, brand authorizations, migration M4 | architect (saga) + builder |
| WP-9 | tax-eta `seller_subscription` line and credit notes (M5); reconciliation checks 2.10 | builder; chief-reviewer (tax/money) |
| WP-10 | Tests: authz matrix rows for every new route, Pact for recurring PSP, Maestro/Playwright flows | tester |

### 5.4 Acceptance (Gherkin, become tests)
- Given a store on T3 with 40 listings and T2 allows 30, when it downgrades, then at period end all 40 stay live, publishing a 41st or a new one is refused with `entitlement_limit`, and nothing is deleted.
- Given renewal fails 3 times, when 7 days of grace elapse, then the store is `ON_FALLBACK`, orders, returns and payouts continue, and no `payout_hold` restriction exists.
- Given an upgrade on day 11 of 30 from net 100,000 to 250,000, then the charge is 114,000 gross and the ledger matches S3 to S3c exactly.
- Given a plan version change requested by finance user A, when A approves it, then it is refused; when B approves, it is published effective at its `effective_from`, and existing subscribers move only after the notice period.
- Given a seller order placed under a 1,500 bps agreement, when the agreement changes, then that order's commission is unchanged (snapshot).
- Given entitlement storage unavailable, then entitlement reads return fallback values (fail closed).
- Given seller A's staff requesting store B's subscription, then 404, byte-identical to a missing store; a catalog role on own store gets 403.
- Given an OFFBOARDING store with an order delivered 10 days ago, then a change-of-mind return is accepted until day 14 and the final payout waits for `CLOSED` + buffer.

### 5.5 Test plan
Property (fast-check): proration properties of 2.7; recognition sums (largest remainder) equal net for any period count; ledger balance and trial balance zero for random sequences of charge, upgrade, downgrade, refund, set-off; entitlement downgrade never deletes a row and never leaves an over-limit store able to create; commission resolution precedence is total and deterministic; state machine reachability. Mutation (Stryker) >= 80% on `seller-billing` (billing calculator, A2.10) and the new ledger builders (ADR-0019). Integration: every route with negative authz rows (seller A/B, role matrix, admin roles). Contract: Pact for recurring charge and webhook (fake until Paymob contract). E2E: Playwright seller web (change plan, billing documents) and admin web (publish version with dual approval).

---

## 6. Open owner and counsel decisions (also in ADR-0056)
| # | Decision | Owner |
|---|---|---|
| D1 | Monetisation model: Option A, B or C (2.5); engineering default B with all fees 0 | Owner |
| D2 | Tier names (AR/EN), prices, commission per tier and category, limits | Owner / Finance |
| D3 | Trial length; founding-partner terms for the 30 launch brands (duration, tier, commission) | Owner |
| D4 | Who bears PSP fees, BNPL merchant discount, COD handling fee: absorbed, passed through, or in commission | Owner / Finance |
| D5 | Seller subscription refunds: none except error, or a first-charge cooling-off window | Owner / Legal |
| D6 | Who bears RTO and return shipping cost per case (seller, platform, shopper), per tier | Owner / Ops |
| D7 | Payout set-off for subscription and negative balances: allowed by Seller Agreement mandate or never | Legal / Finance |
| D8 | VAT and ETA: tax point for prepaid seller subscriptions, bundled ad credit, credit-note form (VR-B4) | Tax |
| D9 | Price and commission change notice period (placeholder 30 d) and grandfathering | Owner / Legal |
| D10 | Whether Z-OUTLET may hold seller funds at all, or must use PSP sub-merchant payouts (ADR-0003, ADR-0021 F-3, VR-03, VR-22) | Legal / Finance |
| D11 | Brand authorization policy: accepted evidence, third-party resellers and parallel imports, restricted-brand list | Legal / Trust and safety |
| D12 | Subscription per store vs per legal entity billing; whether multi-brand groups get a group plan | Owner |
