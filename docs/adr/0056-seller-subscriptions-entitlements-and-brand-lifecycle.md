# ADR-0056: Seller subscriptions as data-driven plans with typed entitlements; store lifecycle with orthogonal restrictions

- Status: **Proposed** (contains owner and counsel decisions D1 to D12; nothing is built)
- Date: 2026-10-18
- Deciders: Owner (commercial model, prices, commissions), Counsel (refunds, set-off, notice, brand authorization), Tax (VAT/ETA tax point), Architect (model). Chief-reviewer checkpoint required on the ledger builders, the commission resolver and seller billing before merge (money).
- Spec: `docs/specs/brand-and-owner-operating-model.md`
- Spec refs: master prompt 9, 14 (HAUL Plus is a different, consumer product), 15.6, 19, 19.1, 20.4, 23, T4, B1 to B5
- Related: ADR-0003 (closed-loop wallet), ADR-0021 (F-1 money design, accepted; deviation F-3 unchanged), ADR-0031 (brand onboarding), ADR-0049 (seller dashboard permissions), ADR-0019 (mutation policy); VR-03, VR-22, VR-INT-01, VR-PAY-12, VR-B4

## Context
The owner asked how each brand manages its account and brand, how the owner manages everything else, and for a seller subscription with five tiers. The repo has brand applications, KYC review, provisioning, seller auth (passkey/TOTP), team roles, store settings, payouts, seller e-invoices and ads top-ups. It has **no** seller plan, subscription, entitlement, seller billing, legal-entity grouping, store restriction or offboarding model, and **no production commission source** (`CommerceTermsPort` only has a 15% development fixture, VR-INT-01). The consumer HAUL Plus `plans` table (migration 0036) must not be reused: different payer, tax document, ledger accounts and legal regime.

## Decision (engineering design; commercial values are owner decisions)
1. **Plans are config.** `seller_plans` + effective-dated, immutable `seller_plan_versions` (price net, interval, trial, default commission, category rates) + `seller_plan_entitlements` rows typed by a code-owned `entitlement_definitions` catalogue (kind, unit, enforcement point, downgrade policy). Publishing a version is dual-approved (`plan_price_change`, always dual). Negotiated terms live in `store_entitlement_overrides` and `seller_commission_agreements`, effective-dated and dual-approved.
2. **Commission resolution** for production: store+category agreement > store agreement > plan category rate > plan default > fail closed. Snapshotted on `seller_orders.commission_rate_snapshot`.
3. **No entitlement weakens a legal or safety control** (return windows, price integrity, KYC, payout only after CLOSED, dual approval, Buy Box neutrality, sponsored labels).
4. **Seller billing is prepaid**: charge first, ETA `seller_einvoice` (new line `seller_subscription`, VAT 14% added once) on successful payment; bank transfer and Fawry get a non-tax payment request first. Anniversary periods, upgrade immediate with day proration (half-even, single point), downgrade at period end, dunning day 1/3/7 with 7-day grace, then the store moves to the fallback plan. Non-payment never deletes data, never blocks fulfilling, returning or refunding placed orders, and never holds payouts unless D7 allows set-off.
5. **Ledger:** new `deferred_seller_subscription_revenue:{store}` (liability) and `seller_subscription_revenue` (revenue) with `platform_vat_output`; recognition per period by largest remainder; refunds by reversing entry + ETA credit note.
6. **Store lifecycle** gains `ONBOARDING`, `OFFBOARDING`, `OFFBOARDED`; all independent constraints (billing, health, price integrity, risk, authorization expiry, offboarding) are rows in `store_restrictions`, each lifted by its own source.
7. **Tenant stays the store.** `seller_legal_entities` groups stores for KYC reuse and consolidated invoicing; an organisation-level tenant is deferred.
8. **Entitlement reads fail closed** to the fallback plan's values.

## Options compared
- **Tier representation.** (a) Tiers in code: simple, but every change is a deploy and history is lost. (b) Free-form JSON: flexible, untyped, a typo silently grants. (c) Typed catalogue + versioned rows: chosen; changes are audited data, values are Zod-validated, any past state is reproducible.
- **Restrictions.** (a) More status values: cannot express two causes at once. (b) Status + restriction rows: chosen; causes from different modules add and lift independently.
- **Tax point.** (a) Invoice at period start with a receivable: accrual-correct but brings bad debt and VAT on unpaid invoices. (b) Prepaid, invoice on payment: chosen; no receivable, matches the ads top-up precedent.
- **Tenant.** (a) Store as tenant, legal entity as attribute: chosen, no RLS rework. (b) Organisation tenant: better for large groups, high cost now.
- **Commercial model** (owner, D1): A subscription + commission ladder; B commission-only with performance-earned tiers; C hybrid. Engineering default if undecided: B with all fees 0 (no billing rail or VAT decision needed to launch; A or C later is a data change).

## Owner and counsel decisions (block acceptance)
D1 model A/B/C · D2 tier names, prices, commissions, limits · D3 trial and founding-partner terms · D4 who bears PSP, BNPL and COD fees · D5 subscription refund policy · D6 RTO and return-shipping cost bearer · D7 payout set-off mandate · D8 VAT/ETA tax point, bundled ad credit, credit notes · D9 notice period and grandfathering · D10 whether Z-OUTLET may hold seller funds (VR-03, VR-22, ADR-0021 F-3) · D11 brand authorization and parallel-import policy · D12 per-store vs per-legal-entity billing.

## Consequences
- New module `seller-subscriptions`, pure package `packages/domain/src/seller-billing`, migrations for plans, subscriptions, restrictions, legal entities, brand authorizations, ledger account types and the ETA line type; new admin approval kinds `commission_agreement` and `store_termination`.
- Every module with a limit (catalog, team, drops, ads, analytics, payouts, API) reads `EntitlementsPort`; each gets an enforcement PR and tests.
- Property tests for proration, recognition, downgrade and ledger balance; Stryker >= 80% on the billing calculator and the new ledger builders (ADR-0019) before merge.
- Kill switches `kill.seller_billing` and `kill.seller_plan_changes`, default blocked until the PSP recurring contract (VR-PAY-12) and D8 are closed.
- Research basis is thin (search snippets; no sourced seller-plan or commission benchmark for Egypt); every number in the spec is a placeholder.
