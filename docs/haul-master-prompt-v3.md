# HAUL master prompt v3: production-grade by design

**Bottom line.** v3 turns the v2 prompt from a feature wish-list into a production specification. Every feature now has a full contract covering flow, rules, edge cases, entities, endpoints, events, failure handling, abuse controls, metrics and acceptance tests, and three regulatory facts now drive the architecture. **First, Egypt's PDPL executive regulations (Ministerial Decision 816/2025) must be fully met by 1 November 2026**, before any 2026–27 launch. That brings a mandatory DPO, PDPC licensing, 72-hour breach notification and licensed cross-border transfers ([CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins)). **Second, a cash-redeemable wallet is e-money under Law 194/2020**, which needs a CBE license with EGP 30m capital for a full EMI ([Andersen via Mondaq](https://www.mondaq.com/fintech/1755348/electronic-money-institution-licensing-in-egypt)). The HAUL wallet is therefore redesigned as closed-loop, non-withdrawable store credit, with a licensed-partner path kept open. **Third, Consumer Protection Law 181/2018 requires 14-day no-reason returns (30 days for defects), a 7-day distance-selling cancellation window and Arabic invoices and contracts** ([Mondaq](https://www.mondaq.com/Article/820956/New-Egyptian-Consumer-Protection-Law)), so return windows count from delivery and every customer document is Arabic-first.

On the engineering side, v3 replaces v2's Redis-hold inventory with Shopify's 2025 row-per-unit reservation pattern (`FOR UPDATE SKIP LOCKED` in the same ACID database as the ledger) ([Shopify Engineering](https://shopify.engineering/scaling-inventory-reservations)). It also moves the security baseline to ASVS 5.0, MASVS v2, API Top 10 2023 and LLM Top 10 2025. It targets the Expo SDK 55+ New Architecture, adds SCI (ISO/IEC 21031) carbon-per-order budgets, and grounds the fit and stylist engines in Zalando and Pinterest production evidence. Items the research could not confirm are tagged **VERIFY BEFORE LAUNCH**. Everything below the line is the paste-ready prompt.

---

# HAUL — MASTER SYSTEM PROMPT (v3, production-grade)
### Multi-vendor off-price fashion marketplace · Egypt first · iOS first, then Android
> Paste this whole file into Claude Code as the **single source of truth**. It fully supersedes v2 and every earlier brief. Build in the order of §P3. Nothing ships without the Definition of Done (§P4). Items tagged **⚠ VERIFY BEFORE LAUNCH** are assumptions that need written confirmation from counsel, a provider contract or a primary source before go-live. Track them in `/docs/compliance/verify-register.md` (one row each: owner, evidence link, status).

---

## TABLE OF CONTENTS
- **PART A — How you (the builder) must work**: A1 Role · A2 Engineering rules · A3 Feature spec template · A4 When uncertain
- **PART B — Regulatory & platform baseline (drives architecture)**: B1 PDPL · B2 CBE/e-money · B3 FRA BNPL · B4 Tax/ETA/VAT · B5 Consumer protection · B6 Age policy (18 vs 21) · B7 Apple App Store · B8 PCI DSS
- **PART C — Product & feature specifications (end-to-end)**: §1–§33
- **PART D — Technology, security, reliability, sustainability**: §T1–§T12
- **PART E — Delivery**: §P1 Launch checklist · §P2 Verify register · §P3 Phases · §P4 Definition of Done · §P5 First task
- **Appendix**: Sources

---

# PART A — HOW YOU (THE BUILDER) MUST WORK

## A1. Role
Act as one team made up of a principal engineer, staff product designer, ML engineer, security architect, SRE and privacy engineer. The priority order is **correctness → security & privacy → legal compliance → reliability → performance → delight**. Use boring, proven technology for money, stock and personal data. Save novelty for experience and ML.

## A2. Engineering rules (non-negotiable)
1. **Types.** TypeScript `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`, `ts-ignore` or non-null `!` outside tests. Python ML services use type hints, `mypy --strict`, `ruff` and `pydantic` v2.
2. **Monorepo.** Use pnpm + Turborepo with remote cache. Shared packages hold domain types, Zod schemas, the generated API client, design tokens, i18n, analytics events and config.
3. **Hexagonal modular monolith.** Layers run domain (pure) → application (use cases) → adapters. Module boundaries are enforced in CI with dependency-cruiser as **architecture fitness functions**: no cross-module imports except through a module's public `index.ts`, and no infra imports in `domain/`.
4. **Money is integer piastres** (`bigint` in TS, `BIGINT` in Postgres). Every amount carries a `currency` field. Never use floats. All rounding is explicit, uses banker's rounding at a single documented point, and is property-tested.
5. **Idempotency.** Every money, stock or order write and every webhook carries an `Idempotency-Key` (client-generated UUIDv7). The server stores `(key, route, actor, request_hash, response)` for 24h. Same key with a different hash returns 422 ([Stripe idempotency](https://docs.stripe.com/api/idempotent_requests)).
6. **Explicit state machines** (XState-style tables in `domain/`) for: OrderGroup, SellerOrder, Shipment, Return, Refund, Payout, Subscription, Drop, PriceClaim, GiftCard, KYC, Dispute, and Price-drop auto-buy. Invalid transitions throw a typed error. Every transition is unit-tested, plus a property test that the machine never reaches an unreachable state.
7. **Transactional outbox + inbox.** A domain event is written in the same transaction as the state change. A relay publishes it to the queue. Each consumer records `message_id` in `inbox_processed` inside the same transaction as its side effect. Delivery is at-least-once and every consumer is idempotent; never claim exactly-once ([microservices.io outbox](https://microservices.io/patterns/data/transactional-outbox.html)).
8. **Sagas.** Checkout, refund, payout and the cancellation cascade are **orchestrated sagas** with explicit compensations: release the reservation, void or refund, reverse the ledger entry ([microservices.io saga](https://microservices.io/patterns/data/saga.html)).
9. **Audit.** Every sensitive action goes to an append-only, hash-chained `audit_log`: actor, action, target, before/after diff (PII-redacted), IP, device and request ID. Retention follows §B1.
10. **Tests.**
    - Domain ≥ 90% line coverage.
    - **Mutation score ≥ 80% (StrykerJS)** on ledger, pricing/VRP, promotions, reservation, refunds and the subscription billing calculator ([Stryker](https://stryker-mutator.io/)).
    - An integration test for every endpoint, **including a negative authorization test** (seller A → seller B object = 404; shopper → admin route = 403).
    - **Pact consumer-driven contracts** between the mobile app, the web apps and the API, and for every external adapter (PSP, BNPL, courier, ETA) ([Pact](https://docs.pact.io/)).
    - Property-based tests (fast-check / Hypothesis) for the promotions stacking matrix, the ledger balance and the outfit optimizer budget constraint.
    - E2E: Maestro on iOS (Android from Phase 2) and Playwright on the web apps.
    - Load: k6.
11. **Spec-first.** Each module gets `spec.md` following template A3, plus a data model, an OpenAPI contract and a threat model, before code. Major decisions get an ADR in `/docs/adr` (MADR format).
12. **Feature flags** (OpenFeature with a self-hosted provider) on every non-trivial feature. **Kill switches** exist for each payment method, BNPL, COD, drops, games, the stylist LLM, ML ranking, crawlers, referral payouts and gift-card sales.
13. **Never fake data shown to users** (stock, viewers, sales, reviews, timers, discounts). This is a legal rule (CPL 181/2018) and a product rule. CI lints UI copy for hard-coded numeric social proof.
14. **Delivery metrics.** Track DORA (deployment frequency, lead time, change-failure rate, recovery time, rework rate) on the Admin engineering dashboard ([DORA](https://dora.dev/guides/dora-metrics-four-keys/)).
15. **Arabic-first.** Every customer-facing string, invoice, contract and notification exists in Arabic. CI fails when an AR key is missing (§B5).

## A3. Feature spec template (use for every feature; §§ in Part C follow it)
| Block | Content required |
|---|---|
| **Flow** | Happy path step by step, entry points, screens |
| **Rules** | Business rules, limits, configurable parameters (admin-editable with audit) |
| **Edge cases** | Concurrency, partial failure, offline, locale/RTL, zero/negative/max values, deleted/suspended actors |
| **Data** | Entities + key columns + indexes + PII class (P0 public, P1 internal, P2 personal, P3 sensitive → field-encrypted) |
| **API** | `METHOD /v1/path` · auth scope · idempotent? · rate limit |
| **Events** | Outbox domain events and analytics events (Zod-typed) |
| **Failure handling** | Timeouts, retries (exp. backoff + jitter, max N), compensations, DLQ, user-visible fallback |
| **Security & abuse** | AuthZ rule, OWASP API/LLM mapping, abuse vectors and controls |
| **Metrics** | Product KPI + SLI/SLO + guardrail |
| **Acceptance** | Gherkin-style criteria that become E2E tests |

## A4. When uncertain
Choose the safest professional default, record it in an ADR, and continue. **Stop and ask** only for irreversible or legally binding decisions: pricing, legal text, payment/BNPL/courier contracts, data residency and cross-border transfer, wallet licensing model, age thresholds, and anything tagged ⚠ VERIFY BEFORE LAUNCH.

---

# PART B — REGULATORY & PLATFORM BASELINE (THIS DRIVES ARCHITECTURE)
> Egyptian counsel must review every item here and every legal text. The citations below are a starting point, not legal advice.

## B1. Personal Data Protection Law 151/2020 + Executive Regulations (Decision 816/2025)
**Facts.** The executive regulations were issued on 1 November 2025, with **full compliance due by 1 November 2026**. They require:
- PDPC licensing or registration, with fees by activity type and data volume.
- A **mandatory DPO** registered with the PDPC.
- **Breach notification to the PDPC within 72 hours, then to affected individuals within 3 days.**
- **Cross-border transfers only with a licence or authorization**, an adequate level of protection and a transfer impact assessment.
- Consent that is explicit, informed, specific, freely given and easy to withdraw.

Sources: [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins), [Al Tamimi](https://www.tamimi.com/news/from-policy-to-practice-egypt-issues-executive-regulations-of-the-personal-data-protection-law), [Kennedys](https://www.kennedyslaw.com/en/thought-leadership/article/2026/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins).

**Build requirements**
| Requirement | Implementation |
|---|---|
| Lawful basis + granular consent | `consent_records(user_id, purpose, version, granted bool, method, ts, ip_hash)`. Purposes: `marketing_push`, `marketing_whatsapp`, `marketing_email`, `analytics`, `personalization`, `budget_insights`, `measurements`, `location_precise`, `cross_border_ml`. Consent is never pre-ticked, and withdrawal is one tap in Settings → Privacy. The SDKs (PostHog, Sentry, ads) initialise **only after** the matching consent. |
| Records of processing (RoPA) | `/docs/privacy/ropa.md` generated from a `data_inventory.yaml` that tags every column with its PII class, purpose, retention and processor. CI fails when a new column has no tag. |
| DPO & PDPC licence | Admin role `dpo`. A Privacy dashboard covers DSAR queue, breach register, consent stats and the transfer register. **⚠ VERIFY BEFORE LAUNCH:** PDPC licence category, fee and DPO qualification status. |
| Data subject rights | `POST /v1/me/privacy/export` (async ZIP in AR/EN, ready ≤ 72h, signed URL valid 24h) · `POST /v1/me/privacy/delete` (§2) · `PATCH /v1/me/privacy/consents` · rectification via profile. Default SLA 30 days. **⚠ VERIFY** the statutory deadline. |
| Breach response | Runbook `/docs/runbooks/breach.md`: detect → triage ≤ 4h → DPO decision → **PDPC notice ≤ 72h → subject notice ≤ 3 days** → post-mortem. Pre-drafted AR/EN templates. Quarterly tabletop exercise. |
| Data residency / cross-border | **Default: primary data plane in a region that does not require a transfer licence, or an obtained PDPC transfer licence with TIA.** ADR-0002 must choose between (a) an Egypt-hosted provider, (b) a nearby region (e.g. AWS me-central-1 UAE / eu-south-1) plus a transfer licence, or (c) a hybrid where P2/P3 stays in-country and the catalog/CDN is global. External LLM/ML APIs receive **no P2/P3 data** unless `cross_border_ml` consent and a licence exist. **⚠ VERIFY BEFORE LAUNCH.** |
| Retention | Orders and invoices: tax-law period (**⚠ VERIFY**, assume 5–7 years) · KYC: contract + 5y · analytics events: 25 months, then aggregated · measurements: until deletion · support chats: 2y · raw webhooks: 7y (financial). Nightly purge jobs, each with a metric. |
| Minors | No accounts under 18 (B6). Children's size profiles hold only measurements and a nickname, never DOB or photo. |
| Sellers as controllers/processors | The Seller Agreement includes a Data Processing Addendum. Sellers receive only the delivery data they need (name, phone **masked through a relay number** where the courier supports it, address) and lose access 30 days after delivery or return closure. |

## B2. CBE e-money licensing → wallet design
**Facts.** Issuing e-money or providing payment services needs CBE authorization under Law 194/2020. A full EMI requires EGP 30m paid-up capital and a decision arrives within 90 (+90) days ([Andersen via Mondaq](https://www.mondaq.com/fintech/1755348/electronic-money-institution-licensing-in-egypt)). The research found no explicit closed-loop exemption.

**Decision (default, ADR-0003):** the **HAUL Wallet is closed-loop store credit**, not e-money.
- **No top-up with cash or card.** Value enters only through refunds the customer chose to take as credit, gift-card redemption, cashback coins, referral credit and goodwill.
- **No withdrawal to bank or mobile wallet, and no P2P transfer.** The only exception is a refund the law requires to be paid to the original payment method, and that goes through the PSP, never out of the wallet.
- Usable **only on HAUL** for goods sold on HAUL.
- **Merchant-of-record money (seller payables) never sits in a HAUL-pooled account.** Collections go through the licensed PSP or aggregator, and HAUL's ledger records allocations (§T4). **⚠ VERIFY BEFORE LAUNCH:** whether HAUL collecting as an aggregator and paying sellers out needs a PSP licence or must use the PSP's marketplace or sub-merchant product. Paymob's split/sub-merchant capability is unverified.
- **Phase 3 option:** a licensed EMI or bank partner provides a real wallet (top-up, withdraw) behind `WalletProviderPort`. The domain model already separates `StoreCreditAccount` from `PartnerWalletAccount`.
- **⚠ VERIFY BEFORE LAUNCH:** written CBE/counsel confirmation that closed-loop store credit and gift cards fall outside e-money.

## B3. FRA consumer finance (BNPL / installments)
**Facts.** Consumer finance is governed by Law 18/2020 ([Mondaq](https://webiis10.mondaq.com/financial-services/1777326/translation-of-law-no-18-of-2020)). On **6 September 2026** the FRA issued its first consolidated consumer-finance guide ([Amwal Al Ghad](https://en.amwalalghad.com/?p=230558)). It covers:
- Disclosure of terms, schedules, costs, fees and risks, with marketing kept consistent with those disclosures.
- Creditworthiness checks and I-Score reporting.
- **Anti-cash-conversion controls.**
- Life and disability insurance to age 65.

**Build requirements**
- HAUL is the **merchant**. valU, Sympl, Aman, Contact, Souhoola, Halan and bank plans are the **lenders**. HAUL holds no FRA licence and never shows its own credit decision.
- Installment copy ("from X EGP/month") comes **only from the provider's quote API**, together with the provider name, tenor, admin fees and a link to the provider's terms. It is never computed by HAUL. **⚠ VERIFY** each provider's API and their merchant marketing rules.
- **Refunds on BNPL orders always go back through the provider** (cancel or partial cancel of the loan). They are never paid as wallet credit or cash. This is enforced in the `RefundRouter`.
- Anti-cash-conversion signals for the fraud model: BNPL order → quick return request → asks for wallet credit; high-resale-value SKUs; repeated BNPL plus cancellations. The model can block BNPL for the user.
- The budget suite's installment calendar uses provider schedules and labels them "estimated from provider".
- **Age:** BNPL eligibility is decided by the provider's KYC (often 21+; **⚠ VERIFY** per provider). HAUL shows "eligibility checked by {provider}".

## B4. Tax: ETA e-invoice / e-receipt and VAT 14%
**Facts.**
- B2B e-invoicing is mandatory.
- **B2C e-receipts** are being rolled out in waves; the 8th sub-phase began **15 September 2025** (Decision 281/2025). Receipts are real-time XML/JSON with unique IDs and digital signatures through the ETA portal ([RTC Suite](https://rtcsuite.com/egypt-widens-b2c-e-receipt-mandate-new-taxpayers-required-as-of-september-2025/), [KPMG](https://kpmg.com/us/en/taxnewsflash/news/2025/01/tnf-egypt-taxpayers-required-comply-mandate-electronic-receipts-b2c-transactions.html)).
- **Standard VAT is 14%** ([Avalara](https://www.avalara.com/vatlive/en/country-guides/africa-and-middle-east/egypt-vat/egyptian-vat-rates.html)).
- E-commerce VAT collections rose 101% to EGP 21bn, and the Ministry of Finance is targeting platforms ([Enterprise](https://enterpriseam.com/egypt/2025/09/24/finmin-to-introduce-new-tax-incentives-targeting-e-commerce-platforms/)).

**Build requirements**
- `TaxEngine` module: VAT rates per tax category (default 14%, with admin-editable exemptions). Prices shown to shoppers are **VAT-inclusive**. Line-level `net`, `vat` and `gross` are stored in piastres.
- **HAUL issues an ETA e-invoice to each seller** for commission, fees, ads and Fulfilled-by-HAUL services (B2B, VAT 14%). **HAUL issues an ETA e-receipt to the shopper** for its own B2C supplies: delivery fees it charges, HAUL Plus, and gift-card sales (gift cards are typically taxed at redemption, **⚠ VERIFY** treatment).
- **Seller goods:** the seller is the supplier and must issue the e-receipt. HAUL offers an optional **"ETA e-receipt as a service"** adapter that signs on the seller's behalf using the seller's ETA credentials (with a seller-uploaded signing token or HSM integration; **⚠ VERIFY** delegation rules). The shopper's order page shows each seller's e-receipt UUID/QR when available.
- `EtaAdapter`: submission queue, retry with idempotent internal IDs, status polling, storage of the signed document, and a **daily reconciliation report** (submitted vs accepted vs rejected).
- **⚠ VERIFY BEFORE LAUNCH:** whether marketplaces must withhold or report for sellers; HAUL's own e-receipt wave or obligation date; VAT treatment of coins, vouchers and gift cards; and the VAT base when the platform funds a discount.

## B5. Consumer Protection Law 181/2018 (+ Executive Regulation, PM Decree 822/2019)
**Facts** ([Mondaq](https://www.mondaq.com/Article/820956/New-Egyptian-Consumer-Protection-Law)):
- **14-day no-reason exchange/return** (item in original condition, with invoice). **30 days for defective or non-conforming goods.**
- For distance selling, a **7-day cancellation window** and **refund within 14 days from delivery**.
- **Arabic is mandatory** for ads, product data, invoices and contracts, including electronic ones, along with supplier identity.
- Invoice breaches are fined **EGP 30k–1m or double the product value**.
- Executive regulations: PM Decree 822/2019 ([Digital Policy Alert](https://digitalpolicyalert.org/event/28035-executive-regulation-for-consumer-protection-law-no181-of-2018-prime-ministers-decree-no-822-of-2019-including-usersubject-right-entered-into-force)).

**Build requirements**
- All windows count from the **courier-confirmed `delivered_at`**, never from the order date.
- The HAUL policy is **at least the legal minimum**: 14 days no reason, 30 days for defects. **⚠ VERIFY** how the 7-day cancel window and the 14-day return right combine, the refund-payment deadline, and the statutory exclusions (underwear, hygiene, personalized).
- **Every listing shows seller legal identity**: legal name, commercial register number, tax card, governorate. The Arabic title and description are mandatory, with English optional. The invoice and e-receipt are in Arabic.
- Misleading-discount rules (Art. 9 is cited in v2 but the text is unverified, **⚠ VERIFY**) are met by the Price Integrity Engine (§9).
- **Joint liability risk** (unverified): seller KYC and counterfeit controls are mandatory, not optional.

## B6. Age policy: 18 vs 21
**Facts.** The Civil Code age of majority is **21**. In January 2015 the Cabinet approved lowering it to 18, but ratification is **unconfirmed** ([Ahram Online](https://english.ahram.org.eg/News/120441.aspx)).

**Policy (configurable per capability in `age_policy` table):**
| Capability | Minimum age (default) | Why |
|---|---|---|
| Create account, browse, wishlist, cart | 18 | Product rule ("HAUL is 18+") |
| Buy with card / Apple Pay / COD / InstaPay / Fawry | 18 | Ordinary low-value purchases; **⚠ VERIFY** capacity for minors 18–20 |
| HAUL Plus (auto-renewing contract) | **21** default, admin-switchable to 18 after counsel sign-off | Recurring contract; capacity risk |
| BNPL / installments | Provider rule (typically 21) | Lender KYC |
| Gift card **purchase** > 5,000 EGP, corporate/B2B, seller account signatory | 21 | Contract capacity |
| Creator/affiliate payouts | 21 | Contract + tax |
- DOB is collected at onboarding together with an attestation checkbox. Users aged 18–20 are flagged `limited_capacity=true`. A **soft** gate shows "this feature requires 21+" and links to help. ID checks happen only where a provider requires them (BNPL) or for sellers (KYC).
- **⚠ VERIFY BEFORE LAUNCH:** the current age of majority and the validity of contracts with 18–20-year-olds.

## B7. Apple App Store
- **Physical goods use non-IAP payment** (Guideline 3.1.5(a)): cards, Apple Pay, wallets, COD ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)).
- **HAUL Plus risk.** Its benefits are physical-commerce perks (free delivery, early access to buy stock, cashback), but it also unlocks **in-app premium features** (unlimited stylist, capsule planner). Apple requires IAP for subscriptions that unlock app features or content (3.1.1).
- **Decision (ADR-0004):**
  1. **Plan A (default):** Plus benefits are **commerce-only**, and the stylist is free with fair-use limits for everyone. Plus is sold through the PSP with a full disclosure, citing 3.1.5(a). **Submit to App Review early via a TestFlight build and keep the risk register updated.**
  2. **Plan B:** if Apple rejects Plan A, keep commerce perks on PSP billing and sell an optional **"Stylist Pro" IAP auto-renewable subscription** through RevenueCat/StoreKit 2 (or put premium stylist features inside a StoreKit Plus SKU).
  3. **US storefront:** since 2 May 2025, link-outs to web purchase are allowed without an entitlement ([Michael Tsai](https://mjtsai.com/blog/2025/05/02/app-review-guidelines-updated-for-epic-anti-steering)). The Ninth Circuit (11 Dec 2025) allows only a limited cost-based fee on linked purchases ([Cravath](https://www.cravath.com/news-insights/epic-games-ninth-circuit-win-affirming-civil-contempt-finding.html)), and the rate and the Supreme Court cert were unresolved as of June 2026 ([MacRumors](https://www.macrumors.com/2026/06/11/apple-fights-back-against-epic/)). The app reads `storefront` (StoreKit `Storefront.current`) and enables link-out **only** for US, behind a flag.
  4. Egypt and other storefronts get no anti-steering relief.
- Required: account deletion in-app, Sign in with Apple whenever Google sign-in is offered, privacy nutrition labels generated from `data_inventory.yaml`, a privacy manifest (`PrivacyInfo.xcprivacy`) with required-reason APIs, an App Tracking Transparency prompt only if cross-app tracking ever exists (default: none), and a demo reviewer account. **⚠ VERIFY** the current guideline text at submission.

## B8. PCI DSS v4.0.1
- **Card data never touches HAUL.** Use the PSP's hosted page, iframe or native SDK only, so HAUL stays in **SAQ A** scope.
- The **Jan 2025 SAQ A revision** removed 6.4.3/11.6.1/12.3.1 but **added an eligibility criterion: the merchant site must not be susceptible to script attacks** ([Report URI](https://blog.report-uri.com/pci-dss-4-0-1-saq-a-and-client-side-security-a-plain-english-faq/), [SecurityMetrics](https://chat.securitymetrics.com/blog/guidance-on-saq-a-updates)). Under FAQ 1588, HAUL meets it by **applying the 6.4.3/11.6.1 techniques anyway**:
  - Strict CSP with nonces on every web page that embeds or redirects to payment.
  - SRI on all scripts.
  - A script inventory with a business justification per script.
  - Tamper/change detection (CSP `report-to` plus a synthetic monitor that hashes the payment page DOM every 5 min).
- Alternative: written confirmation from the PSP (Option 2). Keep both on file.
- Mobile: the PSP native SDK runs in its own view. Payment screens set `FLAG_SECURE` on Android and blur on iOS app-switch. No screenshots of card entry.
- Saved cards are **PSP tokens only** (`psp_token`, `brand`, `last4`, `exp_month/year`, `fingerprint`).

---

# PART C — PRODUCT & FEATURE SPECIFICATIONS (END-TO-END)

## 0. Vision, roles, platforms
**HAUL** sells clearance, end-of-season, overstock and sample stock from local and global brands at **real, machine-verified discounts**. Shoppers browse many stores, fill **one bag**, **pay once**, get **perfect sizing**, a **personal AI stylist** that builds complete outfits **within budget**, and a **budget tracker** that keeps shopping guilt-free.
- **Promises:** Real deals · Perfect fit · One bag, one payment · Shopping that feels good.
- **North star:** monthly purchasing customers × 90-day repeat rate.
- **Guardrails:** return rate, COD refusal rate, complaint rate, contribution margin per order, gCO2e per order.

**Benchmark lens.** Veepee is the off-price scale reference: €3.3B turnover in 2024, ~7,000 brands, 22,000 sale events, and a "Re-turn" lane that resells returned products ([Il Sole 24 Ore](https://en.ilsole24ore.com/art/veepee-group-closes-2024-33-billion-italy-flash-sales-grow-twice-as-fast-as-europe-AGPsLRyD)). HAUL copies the **time-boxed brand events** and **returns-resale lane**. On loyalty, SHEIN's points for reviews and logins beat Temu's ad-driven acquisition on churn ([Sensor Tower](https://sensortower.com/blog/e-commerce-app-battle-temus-rising-star-challenged-by-sheins-loyalty-game)), so HAUL rewards **fit feedback and photo reviews**, which also train the fit model.

**Roles:**
- Shopper · HAUL Plus member.
- Brand owner · Brand staff: Manager, Catalog, Warehouse, Finance, Support.
- Creator/affiliate.
- Platform admin: Ops, Finance, Trust & Safety, Support, Marketing, **DPO**, **Security**, Super-admin (break-glass only, dual approval).
- Courier/hub operator.

**Platforms & order:**
1. iOS app (Expo, §T2) — launch.
2. Seller Center (Next.js) — launch.
3. Admin Console (Next.js) — launch.
4. Android — +6–8 weeks after iOS is stable.
5. Shopper web (Next.js, SEO for public drops and product pages) — Phase 3.

**Tabs:** Home · Explore · Stylist ✨ · Bag · Me.
**Me:** Orders, Wallet (store credit), Budget, Wishlists, Size Profile, Style Profile, History, HAUL Plus, Rewards, Referrals, Gift Cards, Addresses, Settings, Privacy Center, Help.

---

## 1. Identity, onboarding & 18+ gate
**Flow.** Phone OTP / Sign in with Apple / Google / **passkey** → DOB + "I am 18 or older" attestation → language (AR default in EG / EN) → granular consents (§B1, nothing pre-ticked) → style vibes → sizes (or "measure later") → favorite brands → monthly budget (optional) → notification permission prompt **after** a value screen. Target ≤ 60 s. Every step after DOB is skippable.

**Rules.**
- Accounts require age ≥ 18 by DOB. Capabilities are gated per §B6.
- An under-18 DOB gives a polite block, and the device is soft-blocked from retrying with a different DOB for 30 days (device ID + DOB hash).
- One account per phone number. The phone must be verified before the first order, a wallet use, a referral or a COD order.
- OTP: 6 digits, valid 5 min, max 5 attempts, 3 sends per 15 min per phone, 10 per day per device. Exponential resend timer. WhatsApp OTP is a fallback channel.

**Edge cases.**
- An Apple private-relay email is valid.
- Recycled phone numbers: an OTP login on a number unused for more than 180 days on a new device needs a second factor (email link or passkey) before any stored value is shown.
- DOB edits are allowed once through support, with audit.
- Account merge between Apple and phone identities only after both are verified.

**Data.**
- `users(id, phone_e164 P3-enc, phone_hash, email P2-enc, dob P3-enc, age_band, limited_capacity bool, locale, status, created_at)`.
- `identities(user_id, provider, subject)`.
- `devices(id, user_id, platform, attest_status, push_token, last_seen)`.
- `sessions(id, device_id, refresh_hash, family_id, expires_at, revoked_at)`.
- `consent_records`.
- `age_attestations`.

**API.**
- `POST /v1/auth/otp/request` (captcha-less, but App Attest token + rate-limit).
- `POST /v1/auth/otp/verify`.
- `POST /v1/auth/apple`, `/google`, `/passkey/{register|assert}`.
- `POST /v1/auth/refresh` (rotating refresh, reuse detection → revoke family).
- `POST /v1/auth/logout`.
- `GET/DELETE /v1/me/sessions/{id}`.

**Events.** `user.registered`, `user.age_blocked`, `consent.changed`, `session.revoked`. Analytics: `onboarding_step_completed(step)`.

**Failure handling.**
- SMS provider down → automatic failover to a second provider, then to WhatsApp.
- Apple/Google outage → phone OTP path stays available.

**Security & abuse.**
- **SMS pumping protection:** allow-list EG country codes for OTP at launch, anomaly alerts on international prefixes, per-prefix budget caps, App Attest/Play Integrity required.
- Credential stuffing is not applicable (passwordless).
- Access token: JWT, 10 min, audience-scoped, includes `amr`. Refresh token: opaque, device-bound, 30 days, rotated on every use ([ASVS 5.0](https://softwaremill.com/whats-new-in-asvs-5-0/), [API2](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)).

**Metrics.** Onboarding completion ≥ 75%, OTP delivery p95 < 10 s, SMS cost per verified user, age-block rate.

**Acceptance.**
- *Given* a DOB under 18, *when* the user submits, *then* registration is refused and no PII beyond the device hash is stored.
- *Given* a reused refresh token, *then* all sessions in the family are revoked and the user is notified.

## 2. Account deletion, data export, Privacy Center
**Flow.** Me → Privacy Center: consents, download my data, delete account, history pause/clear, personalization toggle, active sessions.

**Rules.**
- Deletion is blocked while orders, returns or disputes are open. The UI shows exactly why.
- Store-credit balance is shown with a forfeiture warning, and refund-to-original is offered where legally required.
- After a 14-day cooling period: PII is erased or pseudonymized, while financial and tax records are kept under legal retention in pseudonymized form.

**API.** `POST /v1/me/privacy/delete` · `DELETE /v1/me/privacy/delete` (cancel during cooling) · `POST /v1/me/privacy/export` · `GET /v1/me/privacy/export/{id}`.

**Events.** `privacy.deletion_requested/completed`, `privacy.export_ready`.

**Acceptance.** Apple 5.1.1(v) compliant (deletion in-app). The export contains every P2/P3 field tagged in `data_inventory.yaml` for the user.

---

## 3. Navigation & "Choose your world"
**Flow.** A segmented control `Local 🇪🇬 | Global 🌍 | Shop Everything | My Stores ⭐`, remembered per device and account.
- **Local / Global:** store directory with logo, cover, "up to X% off **verified**", rating, followers, live-drop badge and ⭐. Sort by trending, biggest verified discounts, new drops, fastest delivery or A–Z. CTA: "Shop all Local stores together".
- **Shop Everything:** merged catalog. Every card has a seller chip. Identical items from several sellers are grouped under a Buy Box (§20.4).
- **My Stores:** 1–30 favorite stores. Feed, search and stylist can all be scoped to them. "New since last visit" counters per store (server-side `last_seen_at` per user per store).

**Rules.** "Local" means seller registered and stock held in Egypt. "Global" means an international brand, whether via a local distributor or cross-border (cross-border is Phase 3 and is shown with duties and ETA).

**Edge cases.**
- A favorite store that gets suspended is hidden with an explanation.
- My Stores scope with zero results → suggest widening, with one tap.

**Data.** `stores(id, seller_id, kind local|global, slug, status, health_score, verified_badge)` · `user_favorite_stores(user_id, store_id, position, last_seen_at)`.

**API.** `GET /v1/stores?world=local&sort=…&cursor=` · `PUT /v1/me/favorite-stores` · `GET /v1/me/favorite-stores/new-counts`.

**Metrics.** World switch rate, My Stores adoption, scoped-session conversion.

**Acceptance.** The counters are correct after a cross-device visit, and scope persists across app restarts.

---

## 4. Search & filters
**Flow.** Search bar → instant suggestions (queries, stores, categories) → results with a filter sheet that shows a live count → save as **Saved Search** with alerts.

**Engine.**
- Typesense (default, ADR) with Arabic normalization (alef/ya/ta-marbuta folding, diacritics stripping), **Franco-Arabic transliteration** (e.g. "fostan" → فستان), synonyms (AR/EN/Franco), typo tolerance, and hybrid lexical + vector retrieval (pgvector or Typesense vectors).
- Voice search via on-device speech recognition.
- **Visual search** in Phase 3 (§28).
- **NL query parsing:** an LLM converts the text into a `SearchFilter` JSON validated by Zod. Free text is never executed. Unparseable fields fall back to keywords.

**Filters.**
- Budget: "I have ___ EGP", chips, and "Fits my remaining budget" (§12).
- Payment-aware: installments available, monthly ≤ X (from provider quotes, cached 24h), payable with store credit, COD available to my address.
- **My size only** and "recommended size in stock".
- Local/Global, stores, My Stores.
- Category tree, verified discount %, price, color, material, pattern, fit, occasion, vibe, modest, season.
- **Condition:** new with tags / new without tags / sample / minor defect (defect photos required).
- Delivery speed, free-delivery eligible, Fulfilled-by-HAUL.
- Rating, **Verified discount only**, **Lowest price in 30 days**, ending soon, new arrivals.

**Rules.**
- Sponsored results are labeled "Sponsored", capped at 2 in the top 10, and must pass the same filters.
- Search index sync goes through outbox events with a staleness SLO under 60 s. **Stock and price are rechecked from Postgres** on the product page and in the bag.

**Edge cases.**
- Mixed-script queries.
- Zero results → relax the least important filter, show "did you mean", and log `search_no_result` for demand gaps.
- Typesense down → Postgres trigram/FTS fallback with reduced features (kill switch).

**Data.** `saved_searches(id, user_id, filter_json, alert_enabled, last_run_at)` · `search_queries` (analytics, PII-free).

**API.** `GET /v1/search?q=&filters=&cursor=` (rate limit 30/10 s per user) · `POST /v1/search/parse` (LLM, 10/min per user) · `CRUD /v1/me/saved-searches`.

**Security.**
- Filter JSON is schema-validated, with a max of 30 facets and a max page size of 50 (API4).
- LLM parser: the user text is untrusted, the output is schema-constrained, there are no tools, and cost is capped (LLM01/05/10, [OWASP LLM Top 10](https://genai.owasp.org/2024/11/17/owasp-reveals-updated-2025-top-10-risks-for-llms-announces-new-llm-project-sponsorship-program-and-inaugural-sponsors/)).

**Metrics.** Search p95 < 150 ms, no-result rate < 8%, search CTR, saved-search alert CTR.

**Acceptance.**
- "فستان ابيض لينين تحت ١٥٠٠" and "white linen dress under 1500" return equivalent filters.
- Eastern Arabic numerals are parsed.

---

## 5. Product page
**Content.**
- Gallery (AVIF/WebP, blurhash), video, zoom.
- Seller chip + health badge + **seller legal identity** (§B5).
- **PriceBlock:** current price, VRP label (§9), verified % off, "Lowest in 30 days", price-history sparkline, installment line from the provider quote.
- Size selector with "**Your size: M (91% confidence)**" and community fit ("runs small — 64% of 210 buyers").
- Condition + defect photos.
- Delivery ETA to the default address (courier SLA by governorate).
- Return eligibility (per §15 category rules).
- "Complete the look" (§11), "Similar for less", "Fits your budget ✅ / ⚠ 300 over".
- Reviews (verified purchase only) with photo/size info, plus Q&A.
- Actions: Add to bag / Buy now / Save with intent / Share (deep link + referral) / Notify on restock or price drop.

**Rules.**
- A stock hold is placed **only when checkout starts** (§7). The PDP shows real stock ("2 left in M") only when ≤ 5.
- Price and stock are read from the primary within 5 s staleness, via cache invalidated by the outbox.

**Edge cases.**
- SKU paused mid-view → disabled CTA plus a "notify me" option.
- Variant out of stock → recommend the nearest size with a fit warning.
- Seller on vacation → ETA adjusted.

**API.** `GET /v1/products/{id}` (ETag) · `GET /v1/products/{id}/price-history` · `GET /v1/products/{id}/fit?profile_id=` · `POST /v1/products/{id}/alerts`.

**Events.** `product_viewed`, `size_recommended(confidence)`, `price_badge_viewed(type)`.

**Metrics.** PDP → bag rate, size-recommendation acceptance, PDP p95 render < 1 s on 4G.

**Acceptance.** A product with no verified evidence shows **no** strike-through or % off, ever (contract test against the §9 output).

---

## 6. Bag
**Flow.** One bag grouped **by store**. Each group shows its subtotal and a **free-delivery progress bar: free shipping on ≥ 2,000 EGP from the same store**, with the threshold configurable per store and by admin. **HAUL Plus = free delivery on every order, no minimum.**

**Smart helpers.**
- "Add X EGP from {store} to unlock free delivery" plus the cheapest compatible in-size items from the same store (the optimizer prefers stylist-compatible items).
- "Price dropped since you added" and "price rose since you added" (both are shown honestly).
- Save for later; move to wishlist with intent; bundle suggestions.

**Rules.**
- The threshold applies to the **merchandise subtotal after item-level discounts and before vouchers and store credit** (ADR; shown in the tooltip). **⚠ VERIFY** that product and legal agree.
- Max 50 lines and max 10 units per SKU. Drop SKUs have their own per-user limit.
- The bag syncs across devices (server-side). Guest bag is not supported: an account is required (18+ gate).

**Edge cases.**
- Item sold out → group shows "unavailable", and checkout continues for the remaining items.
- Store suspended → its group is locked and removed, and the user is told.
- Currency is always EGP at launch.
- A threshold change between add-to-bag and checkout → the checkout-time value applies and the change is shown.

**Data.** `carts(id, user_id, updated_at)` · `cart_lines(id, cart_id, sku_id, qty, price_at_add, added_at, source)`.

**API.** `GET /v1/cart` · `POST /v1/cart/lines` (idem) · `PATCH/DELETE /v1/cart/lines/{id}` · `GET /v1/cart/free-delivery-suggestions?store_id=`.

**Events.** `add_to_bag`, `free_delivery_unlocked(store_id)`, `cart.line_unavailable`.

**Metrics.** Multi-store bag rate, free-delivery unlock rate, AOV uplift attributable to the progress bar (A/B).

**Acceptance.**
- Store A at 1,950 EGP + a 60 EGP item from A → shipping fee for A becomes 0.
- Store B at 2,100 EGP alone → free.
- Plus member → all shipping 0.

---

## 7. Checkout — multi-store, one payment
**Flow (one page).**
1. Address: map pin + structured Egyptian address (governorate → city/district → street, building, floor, apartment, landmark), validated against a courier coverage table.
2. Delivery option per shipment.
3. Payment.
4. Vouchers (auto-best) + store credit + gift card.
5. Review with "**You saved X EGP**" (verified reference savings only).
6. Place order.

**Payment methods.**
- Cards with 3-DS, Apple Pay, Meeza.
- Mobile wallets (Vodafone Cash etc.), **InstaPay** (QR / request-to-pay).
- **Fawry reference code** (pay at outlet, 24h expiry).
- **Installments** via valU, Sympl, Aman, Contact, Souhoola, Halan and bank plans; monthly amounts come from provider quotes.
- **Store credit** and **gift card**.
- **COD** (risk-gated, §20.7).
- **Split tender:** store credit/gift card + one external method.

Kashier documents hosted checkout, iframe, Apple Pay, InstaPay, recurring charges, authorize/capture and webhooks ([Kashier docs](https://developers.kashier.io/docs/accept-payments)). Fawry offers Apple Pay with Banque Misr ([MEA TechWatch](https://meatechwatch.com/2025/10/30/fawry-launches-apple-pay-in-egypt-in-partnership-with-banque-misr/)). Integrate **two PSPs** (primary + failover) behind `PaymentProviderPort`. **⚠ VERIFY** fees, settlement T+n, the split/sub-merchant API and Paymob's tokenization and recurring support in the contracts.

**Domain model.** One **OrderGroup** (one payment intent) → many **SellerOrders** → **OrderLines**. Shipments sit per SellerOrder (Phase 2: hub consolidation produces one Shipment across SellerOrders). The ledger allocates per seller (§T4).

**Saga (orchestrated).**
1. `ValidateCart`: prices, stock, promotions and age gates are recomputed server-side. The client total is never trusted.
2. `ReserveInventory` (§20.2, row-per-unit, TTL 10 min, one reservation per OrderGroup).
3. `ApplyStoreCredit / GiftCard` → a ledger **hold** (pending entries).
4. `CreatePaymentIntent` at the PSP for the remainder, with `Idempotency-Key = order_group_id`.
5. The shopper authenticates (3-DS / Apple Pay / redirect).
6. **Webhook** `payment.succeeded`: HMAC-verified, raw body stored, dedup by PSP event ID → `ClaimInventory` + post ledger + emit `order_group.paid` → SellerOrders become `PAID`.
7. Failure or timeout → compensate: release reservations, release credit holds, void the intent.

For COD the saga skips 4–6. The order becomes `CONFIRMED_COD` after the risk check plus an optional OTP/WhatsApp confirmation, and is claimed immediately.

**Rules.**
- One payment intent per OrderGroup. Partial seller acceptance is handled by **partial refunds** (§15.6), never by re-charging.
- **Price-lock:** the price at checkout start holds for 10 min. If the price changed at commit, show the delta and ask for re-confirmation.
- Vouchers are evaluated by the deterministic engine (§17). Fees are shown before payment and drip pricing is forbidden: every fee appears on the first checkout render.
- Fawry, InstaPay request-to-pay and the wallet-redirect methods hold their reservation until the payment window closes (configurable, default 30 min for wallets, 24h for Fawry using a **separate non-drop stock pool**; drop SKUs are excluded from Fawry).

**Edge cases.**
- Webhook arrives before the redirect returns → the app polls `GET /v1/order-groups/{id}` and the server stays the source of truth.
- Duplicate taps → one OrderGroup (idempotency).
- Payment succeeded but the reservation expired → **auto-claim if stock is available, else automatic refund + apology voucher**. Alert if the rate exceeds 0.1%.
- Network drop after 3-DS → resume from the Orders tab.
- A split-tender external payment fails → the credit hold is released.
- PSP outage → failover to the secondary PSP, or hide the method via kill switch.

**Data.**
- `order_groups(id, user_id, status, totals…, payment_intent_id, idempotency_key)`.
- `seller_orders(id, order_group_id, store_id, status, subtotal, shipping, discount, vat, commission_rate_snapshot)`.
- `order_lines(id, seller_order_id, sku_id, unit_price, vrp_snapshot, qty, discount_alloc, vat)`.
- `payment_intents(id, provider, provider_ref, method, amount, status)`.
- `payment_events_raw(id, provider, event_id UNIQUE, signature_ok, body jsonb, received_at)`.
- `reservations`.

**API.** `POST /v1/checkout/quote` (pure, no side effects) · `POST /v1/checkout` (idem; returns `client_action`) · `GET /v1/order-groups/{id}` · `POST /v1/webhooks/{provider}` (IP allow-list + HMAC + timestamp ±5 min).

**Events.** `checkout_started`, `payment_selected(method)`, `order_group.placed/paid/failed`, `inventory.reserved/claimed/released`.

**Failure handling.**
- PSP calls: timeout 10 s, retry idempotently ×3.
- Webhook processor DLQ with a replay tool.
- **Nightly reconciliation** against PSP settlement files: unmatched lines → finance alert, auto-ticket.

**Security & abuse.**
- **BOLA:** an OrderGroup is readable only by its owner and admins with scope.
- **Sensitive business flow (API6):** checkout is rate-limited per user, device and IP; App Attest is required on `POST /v1/checkout`.
- 3-DS is mandatory on cards; card testing is detected (many small auths across BINs → block).

**Metrics.** **Checkout success ≥ 99.5%** (SLO), payment-method mix, 3-DS drop-off, COD share, time to confirmation p95 < 5 s.

**Acceptance.**
- Cart with stores A, B, C → one charge equal to the sum. The ledger shows three seller payables, a platform commission and VAT, and it balances to zero.
- Killing the API process mid-saga causes neither a double charge nor oversell (chaos test).

---

## 8. Wishlists with intent
**Flow.** Save → sheet with intents: **Need · Want · Treat · Buy later this month · On my birthday 🎂 · Eid/Ramadan · Gift for someone** (person nickname, occasion, date) · custom lists.

**Rules.**
- Lists can have a target date and a budget.
- Birthday and gift lists are shareable through an unguessable link with optional expiry. Friends can buy items (the gift-wrap flag hides prices from the recipient) or **chip into a group gift card** (§15.1).
- Alerts: price drop (verified only), back in size, low stock (≤ 3), date approaching (7 days and 1 day before).
- *Want* items can carry an optional **24h cool-off**: "Buy" turns into "Remind me tomorrow".

**Edge cases.**
- Item delisted → kept as a ghost entry with "find similar".
- A shared list viewer must be 18+ to purchase.
- A gift purchase for a list owner ships to the owner's **hidden** address through an address token. The buyer never sees the address.

**Data.** `wishlists(id, user_id, intent, title, target_date, budget, share_token_hash, visibility)` · `wishlist_items(id, wishlist_id, product_id, sku_pref, added_price, note)`.

**API.** `CRUD /v1/me/wishlists` · `POST /v1/wishlists/{id}/items` · `GET /v1/shared/wishlists/{token}` (rate-limited, no PII except nickname).

**Events.** `wishlist_added(intent)`, `wishlist_alert_sent(type)`, `gift_purchase_from_list`.

**Security.** Share tokens are 128-bit, stored hashed, and revocable. Enumeration is limited to 20/min per IP.

**Metrics.** Save → purchase conversion by intent, cool-off regret reduction (return rate of cool-off purchases vs control).

**Acceptance.** A gift buyer completes the purchase without ever seeing the recipient's address or phone.

---

## 9. PRICE INTEGRITY ENGINE (fully automatic, zero manual review)

### 9.1 Principle
Sellers **never type a "was" price that is shown blindly**. HAUL computes a **Verified Reference Price (VRP)** from evidence. When evidence is insufficient, the price is shown **without** a % off and **no human is asked**. This satisfies CPL 181/2018's misleading-discount prohibition (Art. 9, text **⚠ VERIFY**) and follows the EU 30-day prior-price model.

### 9.2 Evidence sources
1. **Internal price ledger.** Every price change is an immutable `price_events(sku_id, price, valid_from, valid_to, source, actor)`. A materialized view keeps `low_30d`, refreshed on each event.
2. **Seller channel integrations.**
   - OAuth APIs first: Shopify Admin API, WooCommerce REST, Odoo (P3).
   - Fallback: a **polite crawler** that respects robots.txt and terms, uses a per-domain rate limit (≤ 1 req/5 s), takes daily snapshots of price, availability and DOM hash, and runs a headless pool.
   - Consent to monitoring is in the Seller Agreement.
3. **Product matching waterfall** (hybrid, following product-matching literature: [ProMap](https://arxiv.org/pdf/2309.06882), [ensemble text+image](https://www.csie.ntu.edu.tw/~fuh/personal/SolvingProductMatchingProblembyEnsembleMethod.pdf)):
   1. GTIN/EAN/seller SKU exact match.
   2. pHash/dHash near-duplicate images ([pHash comparison](https://ssojet.com/compare-hashing-algorithms/phash-vs-spectral-hash)).
   3. CLIP/SigLIP image+text embeddings via ANN.
   4. LLM attribute extraction and check (brand, color, material, size run).
   5. A calibrated classifier producing `match_conf`.
   Only `match_conf ≥ τ` (start at 0.92, tuned to precision ≥ 0.98 on a labeled set) counts. **⚠ VERIFY**: no published fashion accuracy figure exists, so build a 2,000-pair labeled Egyptian set before trusting τ.
4. **Brand RRP** (Phase 2): the official regional site price, a separate evidence class labeled "Brand RRP".
5. **Document evidence:** an invoice or tag photo goes through OCR + LLM extraction and is scored. It can support a claim, but alone it can never justify more than 30% off.

### 9.3 VRP algorithm
```
candidates = {
  internal_low_30d            if history ≥ 30d,
  external_low_30d            if match_conf ≥ τ and channel_history ≥ 30d,
  brand_rrp                   if match_conf ≥ τ   (labelled separately, never mixed),
  document_price              if doc_conf ≥ τd and age ≤ 180d (support only) }
VRP = min(internal_low_30d, external_low_30d)          # strictest wins
if VRP is null: show plain price (or "Launch price" if listing age < 30d)
discount_pct = floor((VRP - price) * 100 / VRP)        # integer math on piastres
claim_allowed = VRP ≠ null and discount_pct ≥ 5
```
**Rules.**
- **Anti-inflation:** any increase within the 30 days before a discount resets the reference to the lowest price in that window.
- **Successive discounts** keep the starting reference only while the price never goes back up.
- **Cross-channel parity:** if `external_current < HAUL price` → ranking demotion, seller notified, 48 h to fix, then the SKU is auto-paused.
- **Launch price:** the label for new items with no history, never "% off".
- **Snapshots:** every order line stores `vrp_snapshot`, `evidence_ids` and the claim type (evidence trail for Consumer Protection Agency inquiries).

### 9.4 Fraud & anomaly detection
- Per-category isolation forest / robust z-score on claimed vs VRP discount.
- Pre-drop spike detection, ping-pong pricing, duplicate listings that reset history (matched via pHash plus attributes), image reuse across sellers (counterfeit signal), and sudden discounts on low sell-through SKUs before mega events.
- Output is a **Price Trust Score (0–100)** that feeds display and ranking.

### 9.5 Enforcement ladder (automatic)
| Event | Automatic action |
|---|---|
| Insufficient evidence | Hide % off; plain price |
| Claim exceeds VRP | Display auto-corrected to VRP; seller notified with evidence |
| Pre-drop inflation | Badge removed 30 days; ranking penalty |
| Cross-channel cheaper | Demotion; 48 h to fix; auto-pause |
| 3 violations / 90 days | Lose "Verified" badge; commission surcharge; drops blocked 30 days |
| Severe / repeat | Store auto-suspended; payouts held per Seller Agreement |
**Appeals:** the seller connects an API integration or uploads machine-readable evidence, and the claim is **re-scored automatically**. If the score is still disputed, an Ops queue exists **only for suspensions** (a legal fairness requirement: a human reviews a suspension within 5 business days). **⚠ VERIFY** with counsel that fully automatic suspension without human review is acceptable.

### 9.6 Transparency
Badges: ✅ **Verified discount** · 📉 **Lowest price in 30 days** · 🆕 **Launch price** · plain. Tapping a badge opens the price-history chart and a "How we verify prices" explainer. "Report price" feeds the model as a signal and is rate-limited.

### 9.7 Data / API / events / metrics / acceptance
- **Data:** `price_events`, `channel_connections(seller_id, type, oauth_token_ref KMS, status)`, `channel_snapshots(partitioned daily)`, `product_matches(haul_sku, external_ref, method, conf, model_version)`, `price_claims(sku_id, vrp, evidence_ids[], trust_score, status)`, `enforcement_actions`.
- **API:** `GET /v1/products/{id}/price-evidence` (public summary) · `POST /v1/seller/channels` · `POST /v1/seller/price-claims/{id}/appeal` · `GET /v1/seller/price-trust`.
- **Events:** `price.changed`, `price_claim.scored`, `price_enforcement.applied`, `channel_snapshot.ingested`.
- **Failure handling:** crawler failure → evidence goes stale after 72 h → the claim degrades to "plain price" (fail closed). An OAuth token is revoked → seller alert.
- **Security:** crawler egress goes through a dedicated proxy, never with internal credentials. **SSRF protection** (API7): only seller-verified domains, no private IPs, DNS-rebinding guard. Seller text is untrusted to the LLM (LLM01).
- **Metrics:** % listings with verified claims, auto-corrections, false-positive appeals upheld (target < 2%), complaints about fake discounts (target ≈ 0).
- **Acceptance:** a property test asserts that a price raised and then cut within 30 days never yields a claim above the true 30-day minimum.

---

## 10. Size & fit system
**Evidence base.**
- About **one-third of Zalando's returns are size-related**, and items with size advice show about **10% fewer size-related returns** ([Zalando](https://corporate.zalando.com/en/node/10416)).
- Zalando combines article-level size flags (brand measurements, return reasons, fitting models), personalized history-based recommendations and, since July 2023, **body measurements from two phone photos** ([Zalando](https://corporate.zalando.com/en/node/10477)).
- Stitch Fix's **latent size** (IRT-style hierarchical Bayesian: user latent size × item "size difficulty") is the cold-data blueprint ([Stitch Fix](https://multithreaded.stitchfix.com/blog/2017/12/13/latentsize/)).

**Flow.**
- **Guided measurement** in AR/EN with looping illustrations and tips. With no tape: string + ruler, printable paper tape (scale check by measuring an A4 or a bank card), A4 foot method, ring-sizer printable.
- Measurements: height, weight (optional), bust/chest, under-bust, waist, high hip, hip, shoulders, sleeve, inseam, thigh, neck, foot length & width, wrist, ring, head.
- **Quick start:** height + weight + usual size in a known brand.
- **Multiple profiles:** me, partner, kids. Kids exist only under the adult account and hold no DOB/photo.
- Phase 3: photo-based estimation, processed **on-device** where possible. Images are never stored without explicit consent.

**Fit engine (4 layers).**
1. **Structured size charts** are required per product type: a seller template with garment measurements and validated ranges (monotonic across sizes, plausible deltas). Listings without charts cannot show a size recommendation.
2. **Item flags** "runs small/large" learned from return reasons plus fit feedback (Beta-Binomial with a minimum of n=20, shown with the count).
3. **Per-user latent size** via a hierarchical Bayesian/IRT model across brands, updated on keep/return/fit feedback.
4. **Brand-level size bias** learned from returns.

**Output.** `{size, confidence 0–1, explanation[], alternatives}`. Confidence < 0.6 → the UI says "We're not sure — check the chart". **Fit preference** (snug/regular/loose) and **modest fit** are inputs.

**Edge cases.**
- Between sizes → recommend based on fit preference and fabric stretch.
- Unisex or kids charts.
- A seller chart in inches → normalize to cm.
- An impossible measurement (waist > 250 cm) → reject.

**Data.** `size_profiles(id, user_id, label, measurements P3-enc, fit_pref, updated_at)` · `size_charts(id, store_id, product_type, rows jsonb, unit, validated)` · `fit_feedback(order_line_id, rating too_small|ok|too_large, area)` · `fit_model_params(user_id|item_id|brand_id…)`.

**API.** `CRUD /v1/me/size-profiles` · `GET /v1/fit/recommend?sku_group=&profile_id=` · `POST /v1/orders/lines/{id}/fit-feedback`.

**Events.** `size_recommended`, `fit_feedback_submitted`, `return_requested(reason=size)`.

**Privacy.** Measurements are P3, field-encrypted and **never visible to sellers**. Sellers see only aggregated size demand with k ≥ 50. Feeding measurements to the ML model requires the `measurements` consent.

**Metrics.** Size-related return rate (target −10% vs control, the Zalando benchmark), recommendation coverage, calibration (ECE < 0.05).

**Acceptance.** A user who returned "too small" twice in brand X gets a recommendation shifted up for X, with an explanation that cites it.

---

## 11. AI personal stylist ✨
**What it does.**
- **"Build me an outfit":** occasion (work, wedding guest, date, Eid, beach, gym, university), vibe, weather/season, modesty level, **budget** → 3–5 **complete outfits** (top + bottom/dress + shoes + bag + accessory) **mixed from different stores**, all in the user's size, in stock and within budget. One tap adds the whole outfit to the bag.
- **"Complete the look"** from a PDP, the bag or past purchases.
- **"Shop my wishlist":** turns Need/Want lists into coordinated outfits.
- **Capsule planner:** "10 pieces, 20 outfits, under 5,000 EGP".
- **Chat mode** (Phase 3).
- **Respects My Stores and Local/Global** scopes.

**Algorithm (production-proven pattern).**
- **Item understanding:** vision + LLM attribute extraction (category, palette, pattern, formality, season, silhouette, material, coverage) plus a CLIP/SigLIP embedding, computed once per product image version.
- **Compatibility:** follows Pinterest *Complete the Look*, which learns scene–product and product–product compatibility in a shared embedding ([Kang et al., CVPR 2019](https://openaccess.thecvf.com/content_CVPR_2019/papers/Kang_Complete_the_Look_Scene_Based_Complementary_Product_Recommendation_CVPR_2019_paper.pdf)). It is **bootstrapped without labeled outfits** from curated and heuristic outfits ([Pinterest KDD 2020](https://arxiv.org/abs/2006.10792v1)). Because off-price stock turns over fast, compatibility comes from **embeddings + category templates**, not SKU co-purchase. Rule constraints cover color harmony, formality match, season and modest coverage.
- **Personal affinity:** a user style vector (latent style embeddings, cf. [Stitch Fix](https://multithreaded.stitchfix.com/blog/2018/06/28/latent-style/)).
- **Constrained optimization:** maximize `compat + affinity + verified_discount_value − price_penalty` subject to `Σ price ≤ budget`, size-in-stock, delivery to the address and age gates. Solved by beam search (width 50) with a knapsack bound, under a 300 ms budget. Prefer combinations that unlock same-store free delivery when cost-neutral.
- **Diversity:** outfits differ in ≥ 2 slots; a store fairness cap of ≤ 2 items per store per outfit unless the user scoped to one store.
- **Feedback:** like/dislike/swap updates the style vector online.

**Rules.**
- Outfits show **total price, per-store delivery and the budget fit**.
- Every item is re-validated for stock and price at add-to-bag.
- No budget → default to the remaining monthly budget if one is set, else no constraint.
- **Fair use:** 30 outfit generations/day free; capsule planner and chat are free with limits (see §B7 Plan A).

**Edge cases.**
- Budget too low for a complete outfit → return the best partial outfit with "add X EGP for shoes".
- No items in size → explain and suggest sizes elsewhere.
- Modest mode excludes items with sleeve length or neckline below the threshold.

**LLM safeguards (OWASP LLM Top 10 2025).**
- **LLM01:** seller text is untrusted and passed as data in delimited fields; the system prompt forbids following instructions found inside product data.
- **LLM02:** no P3 data in prompts; size is passed as a label, not raw measurements.
- **LLM05:** outputs are JSON product IDs validated against the catalog; prices are **never** generated by the LLM.
- **LLM06:** tools are read-only (search, stock, size, budget); add-to-bag needs a user tap.
- **LLM07:** no secrets in the system prompt.
- **LLM08:** vector store per tenant scope, no user data in shared indexes.
- **LLM09:** the UI states "AI suggestions".
- **LLM10:** per-user token budgets, a global cost circuit breaker and a cache by (filters hash).

**Data.** `product_attributes(product_id, attrs jsonb, model_version)` · `product_embeddings(product_id, vec vector(768))` · `outfits(id, user_id, request jsonb, items[], scores, created_at)` · `stylist_feedback`.

**API.** `POST /v1/stylist/outfits` (rate 10/min) · `POST /v1/stylist/complete-look` · `POST /v1/stylist/capsule` · `POST /v1/stylist/outfits/{id}/add-to-bag` (idem) · `POST /v1/stylist/feedback`.

**Events.** `stylist_outfit_generated(n, budget, latency)`, `outfit_added_to_bag`, `stylist_feedback`.

**Failure handling.**
- ML service down → rule-based fallback (template + popularity + color rules).
- LLM down → structured UI without chat.

**Metrics.** Outfit add-to-bag rate, stylist-driven GMV share, multi-store outfit share, p95 latency < 1.5 s, cost per generation.

**Acceptance.**
- Budget 3,000 EGP, size M, wedding guest, modest → 3–5 outfits, each total ≤ 3,000, every item in stock in M and modest-compliant.
- Running the budget property test over 10k random catalogs never exceeds the budget.

---

## 12. "What can I afford now?" & budget suite
**Flow.**
- Set a **monthly budget** (total + optional per category) and a **payday** (budget resets on payday).
- The **Affordability view** filters the feed, search and stylist to the **remaining budget now**: `remaining = budget − spent_this_cycle − bag_total(optional toggle) − installments_due_this_cycle`.
- **Affordable now vs later** on wishlists: "You can buy 3 Need items now; the dress fits after payday on the 25th".
- **Plan my purchases:** a scheduler assigns wishlist items to cycles by priority (Need > dates > Want > Treat) and watches for price drops to buy earlier.
- **Installment-aware:** "This bag = 4 × 620 EGP/month (provider estimate); after it, your monthly commitments = 1,450 EGP (within your 2,000 limit)".
- **Dashboard:** spent, remaining, savings vs **verified** references only, category donut, month-over-month, top stores, average discount captured, Plus savings.
- **Savings goals** with a monthly report.
- **Wellbeing:** spending-cap lock (soft: requires a 10 s hold to override; hard: blocks checkout until payday, with a 24h delayed unlock), no-spend days, hide trending, impulse cool-off.

**Rules.**
- Spending counts **net of refunds** on the order's cycle.
- COD counts at placement and is reversed on refusal.
- Installment commitments come only from provider data or the user's own entry, labeled "estimate".
- **This is not financial advice:** HAUL never shows credit scoring or loan recommendations (FRA).

**Edge cases.**
- Payday on the 31st → last day of the month.
- Budget changed mid-cycle → recomputed.
- Multi-currency is out of scope.
- A refund in the next cycle → credited to the original cycle in reports, and to "available now" in the current one.

**Data.** `budgets(user_id, amount, per_category jsonb, payday, cap_mode)` · `budget_cycles(user_id, start, end, spent, refunded)` · `installment_commitments(user_id, provider, monthly, start, end, source)` · `savings_goals`.

**API.** `PUT /v1/me/budget` · `GET /v1/me/budget/summary` · `GET /v1/me/affordability?context=feed|search|stylist|wishlist` · `POST /v1/me/budget/plan`.

**Events.** `budget_set`, `budget_warning_shown`, `affordability_view_opened`, `budget_cap_blocked_checkout`.

**Privacy.** P3 financial-behavior data: opt-in (`budget_insights` consent), **never shared with sellers, excluded from ads, ranking and promo targeting** (enforced by a lint rule that budget tables cannot be imported by the `promotions` or `ads` modules).

**Metrics.** Adoption, % users under budget, return rate of budget users vs control, retention uplift.

**Acceptance.** With a hard cap reached, checkout is blocked with a clear explanation, and unlocking takes 24h.

---

## 13. History & personalization
- **History:** viewed, searched, saved, bought, returned (with reasons), outfits generated. Pause or clear anytime (clear also wipes the derived recommendation features within 24h).
- **Modules:** "Because you bought…", "Similar to what you viewed", "Similar for less" (verified only), "Goes with your purchase", "Restock reminders" for basics, "Price dropped on items you viewed".
- **Recently viewed** syncs across devices.
- **Personalization toggle:** off = non-personalized ranking (popularity + freshness), required for transparency.
- **Data:** `user_events` (partitioned, 25-month retention), `user_features` (feature store).
- **API:** `GET /v1/me/history?type=` · `DELETE /v1/me/history` · `PATCH /v1/me/settings {personalization:false}`.
- **Acceptance:** with personalization off, the feed request carries `personalized=false` and the ranking model receives no user features (verified in an integration test).

---

## 14. HAUL Plus subscription (admin-configurable prices)
| Plan | Price | Message |
|---|---|---|
| Monthly | **200 EGP / month** | Flexible, cancel anytime |
| Yearly | **800 EGP / year** | **"Pay 4 months, get 8 FREE" — save 1,600 EGP (67%)** vs 12 × 200 = 2,400 · default selected · "Best value" |
| Free trial | 14 days (one per person: phone + device + card fingerprint) | Reminder 2 days before the first charge |
| Family (P2) | 1,200 EGP / year, up to 4 adults (each 18+, own account) | |
| Student (P2) | Discounted with verification (university email / ID via a third-party verifier) | |
| Gift Plus | Buy for a friend (1, 3 or 12 months; non-renewing) | |

**Benefits (commerce-only per §B7 Plan A):**
- Free delivery on every order, no minimum.
- 24h early access + members-only drops.
- +5% coins cashback.
- Free returns.
- Monthly Plus Day sale.
- Monthly surprise voucher.
- Birthday gift.
- Priority support & delivery slots.
- Price-drop auto-alerts with "buy at target price" (auto-checkout opt-in, Phase 3, §28.1).
- The stylist stays free with fair use. "Stylist Pro" is IAP only if Plan B is triggered.

**Conversion (ethical):** checkout delivery-fee nudge ("Plus would save you 65 EGP on this order"), "you'd have saved X" after the 3rd order, savings meter on Me and on renewal receipts, **pause instead of cancel** (1–3 months), win-back offers. **Cancellation is ≤ 2 taps from Me → HAUL Plus**, with no confirm-shaming.

**Billing.**
- PSP tokenized recurring charges (Kashier documents recurring; **⚠ VERIFY** the Paymob/Fawry recurring + mobile-wallet recurring rules).
- Dunning on day 1/3/7 with a 7-day grace period (benefits continue during grace), then `PAST_DUE → EXPIRED`.
- Upgrade monthly → yearly: **prorated credit** of the unused monthly days against 800.
- Downgrade takes effect at period end.
- **Auto-renew disclosure** before purchase and in the receipt.
- Refunds: cancel anytime, benefits until period end. **Pro-rata refund** where the law requires (**⚠ VERIFY** CPL applicability to subscriptions), and **full refund within 14 days if no benefit was used** (default policy).
- ETA e-receipt issued for each charge (§B4).
- Age: 21+ by default (§B6).

**State machine:** `TRIALING → ACTIVE → PAST_DUE → (ACTIVE | EXPIRED)`, `ACTIVE → PAUSED → ACTIVE`, `ACTIVE → CANCELLED_AT_PERIOD_END → EXPIRED`.

**Edge cases.**
- A free-delivery benefit used on an order that is then cancelled → no effect.
- Trial abuse via a new phone with the same card fingerprint → no trial.
- Family member leaves → seat freed at the next cycle.
- Plus expires between checkout start and payment → the fee is recomputed at commit and shown.

**Data.** `plans(id, code, price, interval, active, version)` · `subscriptions(id, user_id, plan_id, status, period_start, period_end, psp_token_ref, trial_end, cancel_at)` · `subscription_invoices` · `plus_savings_ledger`.

**API.** `GET /v1/plus/plans` · `POST /v1/plus/subscribe` (idem) · `POST /v1/plus/cancel` · `POST /v1/plus/pause` · `POST /v1/plus/switch-plan` · `POST /v1/webhooks/{provider}/recurring`.

**Events.** `plus_paywall_viewed`, `plus_started(plan, trial)`, `plus_renewed`, `plus_payment_failed(attempt)`, `plus_cancelled(reason)`.

**Metrics.** Penetration, trial→paid, monthly churn, yearly mix, savings delivered vs fee (target savings ≥ 2× fee for the median active member), LTV uplift.

**Acceptance.** The yearly price shows "Pay 4, get 8 free". The math is unit-tested: 800 = 4 × 200 and the saving = 1,600. Cancel is reachable in 2 taps, and the benefits end exactly at `period_end`.

---

## 15. Money features

### 15.1 Gift cards (closed-loop, §B2)
**Flow.**
- Choose a design (Birthday, Eid, Ramadan, Wedding, New baby, Graduation, Thank you), amount (100–10,000 EGP, custom), message/photo/video (moderated), and delivery (WhatsApp/SMS/email/in-app, scheduled).
- Scope: platform-wide or store-specific.
- **Group gift:** contributors pay into a pot. The card issues when the pot closes, and unfunded contributions are refunded.
- **Corporate bulk:** B2B portal, invoice, CSV recipients, ETA e-invoice.

**Rules.**
- Codes: ≥ 16 chars from a CSPRNG (Crockford base32), stored as an **HMAC hash + last 4**.
- Redemption converts the card to **store credit** (gift-card sub-balance). Partial use is allowed.
- **Expiry:** default 3 years, clearly shown. **⚠ VERIFY** Egyptian limits on gift-card expiry and the VAT point.
- **Not redeemable for cash**, not usable to buy other gift cards or Plus (prevents laundering loops).

**Abuse controls.**
- Brute force: 5 failed redemptions/hour/account, 20/day/device, global anomaly alerts.
- Purchases with new cards above 2,000 EGP need 3-DS. Velocity limits on buying.
- Card-testing and fraud model screening on gift-card purchases.

**Data.** `gift_cards(id, code_hash, last4, amount, currency, scope_store_id, status, expires_at, purchaser_id, recipient_contact P2-enc, design, scheduled_at)` · `gift_card_redemptions`.

**API.** `POST /v1/gift-cards` (idem) · `POST /v1/gift-cards/redeem` · `GET /v1/me/gift-cards` · `POST /v1/b2b/gift-cards/bulk`.

**States:** `PENDING_PAYMENT → ISSUED → DELIVERED → REDEEMED(partial|full) → EXPIRED | VOIDED`.

**Metrics.** Gift-card GMV, redemption rate, breakage (reported, never optimized against users), fraud loss rate < 0.1%.

**Acceptance.** A redemption attempt with the 6th wrong code in an hour returns 429, the right code still works afterwards, and the audit log records all attempts.

### 15.2 Wallet = HAUL Store Credit (closed-loop)
- **Sub-balances**, each with rules and expiry shown: `refund_credit` (no expiry), `gift_card` (per card), `cashback_coins` (12 months rolling), `referral_credit` (6 months), `goodwill` (90 days).
- **Spend order:** soonest-expiring first, with refund credit last (so that it can still go back to original if needed).
- **No top-up, no withdrawal, no P2P transfer** (§B2). The UI never uses "cash" or "money"; it says "HAUL credit".
- **Double-entry only** (§T4). A balance is derived from postings, with a cached projection reconciled nightly.
- **API:** `GET /v1/me/wallet` (balances + expiring soon) · `GET /v1/me/wallet/transactions?cursor=`.
- **Acceptance:** for every user, the sum of postings equals the projection balance (nightly job, alert on any drift).

### 15.3 Vouchers
Covered by the promotions engine (§17). Each voucher has a code or is auto-applied, and has a single-use or per-user cap.

### 15.4 Referrals & creators
**Flow.** The user shares a code or deep link. The friend gets e.g. **150 EGP off a first order ≥ 600**. The referrer gets **100 EGP referral credit after the friend's return window closes** and the order is not refunded. Milestone: 10 referrals = 1 free Plus month.

**Rules.**
- The friend must be a new phone + new device + new payment fingerprint + 18+.
- The referrer must have at least one delivered order.
- Max 50 rewarded referrals/year.

**Creator program:** affiliate links, curated looks, commission (paid as payouts via KYC, 21+, tax form; **⚠ VERIFY** creator VAT above EGP 500k, cf. [Enterprise](https://enterpriseam.com/egypt/2025/09/24/finmin-to-introduce-new-tax-incentives-targeting-e-commerce-platforms/)), and a dashboard.

**Fraud.** A device/IP/instrument/address graph, self-referral blocking, a cluster detector (connected components above N), and COD-first-order referrals reward only after delivery and the window closes.

**Data.** `referral_codes`, `referrals(referrer_id, referee_id, status, order_id)`, `creator_accounts`, `affiliate_clicks(partitioned)`, `commissions`.

**API.** `GET /v1/me/referral` · `POST /v1/referrals/attribute` · `GET /v1/creator/dashboard`.

**Metrics.** K-factor, referral CAC, fraud rejection rate.

**Acceptance.** A self-referral on the same device is rejected silently (no reward) and logged.

### 15.5 Rewards
- **HAUL Coins** are earned for purchases (on delivered and not-returned items), **photo reviews with size info**, size-profile completion, fit feedback, referrals, streaks and challenges.
- 1 coin = 1 piastre of store credit when converted (config). Coins expire after 12 months.
- **Tiers by 12-month net spend:** Bronze → Silver → Gold → Black, each with benefits.
- **Light games** (daily spin, scratch card after delivery) have **disclosed odds**, are **free to play**, have no paid chance mechanics, and award only coins or vouchers, never cash (**⚠ VERIFY** Egyptian promotional/lottery rules).
- Coins earned on an order are clawed back if the order is returned.

### 15.6 Refunds (router)
**RefundRouter rules:**
- Card / Apple Pay / Meeza → PSP refund to the original (5–14 business days shown).
- Mobile wallet / InstaPay → PSP reverse where supported, else bank transfer to a verified IBAN of the payer (**⚠ VERIFY** per PSP).
- Fawry → refund to store credit, or a Fawry refund voucher, per contract.
- **BNPL → provider cancellation only** (§B3).
- COD → store credit **instantly** (default, with the shopper's choice) or a bank/wallet transfer within the legal deadline.
- Store credit/gift card portion → back to the same sub-balance.
- **The shopper chooses** between original method and instant store credit wherever both are legal. The default is the original method.

**Partial refunds** are allocated per line, including the proportional voucher share and the delivery fee where the seller is at fault. **All refunds are ledger-first** (reversing entries).

**States:** `REQUESTED → APPROVED → PROCESSING → COMPLETED | FAILED(retry) | MANUAL_REVIEW`.

**SLO:** refund initiated within 24h of return receipt; **paid within the legal deadline (assume 14 days from return receipt; ⚠ VERIFY)**.

---

## 16. Feed, drops & social
**Explore feed:** vertical cards and video (expo-video), double-tap to save, share with referral link, shop-the-look hotspots.

**Drop types:** Public · Members-only (Plus early access 24h) · Flash hour · Mystery box (contents value range disclosed, minimum value guaranteed; **⚠ VERIFY** lottery rules) · Price ladder (price decreases on a published schedule) · Last chance. Veepee-style time-boxed brand events are the core rhythm.

**Waiting room & admission (flash drops).**
- An edge waiting room (Cloudflare Waiting Room or equivalent; **⚠ VERIFY** vendor) issues a signed token (JWT, 15 min) → access to the drop PDP and checkout.
- A token queue in Redis (sorted set, FIFO, with fairness across devices).
- **Waitlist with a 15-min purchase window.**
- **Per-user and per-device purchase limits** per SKU. App Attest/Play Integrity are required, and bot scoring runs (API6, [OWASP API Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)).
- Inventory uses the row-per-unit pool (§20.2), with Redis acting only as a "sold-out" pre-filter.

**Truthful social proof only:** "212 bought today" and "38 viewing now" are computed from real events with a 1-min refresh and shown only when ≥ a threshold. "2 left in M" is real.

**Social:** follow stores and friends (opt-in, friend graph private by default), shareable wishlists, photo reviews (verified purchase, moderated by image classifier + text toxicity AR/EN), "worn by the community" looks (consented). **Live shopping (P3)** has pinned products and a moderated chat.

**Drop states:** `DRAFT → SCHEDULED → EARLY_ACCESS → LIVE → SOLD_OUT | ENDED → ARCHIVED`. A seller cannot edit price or stock after `SCHEDULED` except to increase stock.

**Metrics.** Drop sell-through, waiting-room abandonment, bot block rate, checkout success during drops ≥ 99%.

**Acceptance.** A k6 test with 50k virtual users on a 500-unit drop gives **zero oversell**, ≤ 500 claimed units, and the waiting room honors FIFO within ±1%.

## 17. Promotions engine
**Types:** % / fixed / free shipping / BOGO / tiered / bundle / first order / birthday / win-back / payment-partner / Plus-only / store follower.

**Funding:** platform, seller or co-funded (split %), recorded per line for the ledger and the VAT base.

**Targeting:** segment, store, category, product, city/governorate, tier, Plus. **Budget data is never used** (§12).

**Constraints:** budget caps, per-user, per-day, min order, max discount, dates (Cairo TZ), payment method.

**Deterministic stacking matrix:**
- Max one platform code + one store voucher per store + auto promos + payment-partner offer.
- Evaluation order: item-level → store-level → order-level → shipping → payment-partner.
- "Auto-best" picks the combination that minimizes what the shopper pays, solved exactly over ≤ 5 candidates.

**Discounted prices never create a "% off" claim** unless §9 verifies it. A voucher shows as "voucher -X", not as a reference price.

**Abuse controls:** device fingerprint, phone verification, velocity rules, multi-account graph, and a refund-then-reuse block (the voucher is reinstated only if the whole order is cancelled before shipping).

**Tests:** property-based (no combination exceeds caps, no negative totals, idempotent re-evaluation) + mutation ≥ 80%.

**API.** `POST /v1/promotions/evaluate` (internal) · `CRUD /v1/admin/promotions` · `CRUD /v1/seller/promotions`.

**Metrics.** Promo ROI, incremental GMV (holdout), abuse rate.

## 18. Shopping psychology (ethical) and Voice of Customer
**Allowed:** real scarcity and urgency, social proof, verified anchoring, decoy pricing (Plus), goal-gradient progress bars, loss aversion (expiring coins, free-delivery threshold), reciprocity, endowment, variable rewards with disclosed odds, commitment, choice-overload control, peak-end moments, Zeigarnik.

**Forbidden:** fake timers, fake stock, fake reviews, drip pricing, confirm-shaming, hard-to-cancel flows, and pre-ticked consents. A CI copy-lint runs, and Design QA uses a checklist.

**VoC:**
- A post-delivery 1-question micro-survey and quarterly NPS.
- AR/EN review sentiment and topic modeling.
- Support-ticket auto-tagging and a return-reason taxonomy.
- No-result searches, rage-tap and drop-off analytics, feature-request clustering.
- **A weekly auto-generated VoC report** (LLM over aggregates, with PII stripped before the prompt) in Admin and per seller (their own data only).

---

## 19. Seller Center (Shopify-level)
**KYC onboarding.**
- Documents: commercial register, tax card, signatory national ID (21+), IBAN (name match), and brand authorization or proof of purchase for third-party brands (anti-counterfeit).
- Verification: OCR + validation + sanctions/watchlist screening, done automatically where APIs exist, else by the Ops queue.
- **KYC states:** `DRAFT → SUBMITTED → AUTO_CHECKS → (APPROVED | NEEDS_INFO | REJECTED)` and `APPROVED → SUSPENDED`.
- **ETA registration** status and e-receipt capability are captured (§B4).

**Features.**
- Storefront builder.
- Catalog: single and bulk CSV (validated, dry-run, error report), bulk images with automatic background cleanup, AI bilingual titles and descriptions (Arabic required, seller approves), variants, barcodes, **structured size charts**, condition and defects.
- **Channel integrations** (Shopify, WooCommerce, Odoo P3, Google Sheets) for stock + price sync. These also feed §9.
- Drop builder.
- Orders, pick lists, **AWB labels**; Ship-by-Seller or Fulfilled-by-HAUL.
- Returns & disputes.
- Marketing: store vouchers, bundles, follower deals, sponsored products (CPC), creator collabs.
- Finance: balances, payouts, statements, **ETA e-invoices from HAUL**, VAT reports.
- Team roles + **mandatory passkey/TOTP**.
- **Seller Health Score** (dispatch SLA, cancellations, return rate, rating, Price Trust Score) drives visibility automatically.

**SLAs.**
- Accept within 24h, else auto-cancel and refund, with a health penalty.
- Dispatch within 48h (configurable).
- Respond to Q&A within 48h.

**Seller-side order states:** `PAID → ACCEPTED → PACKED → SHIPPED`, or `PAID → REJECTED_BY_SELLER` (partial refund, §15.6).

**Data access.**
- Strict tenant isolation through a **NestJS policy guard + Postgres Row-Level Security (`app.current_store_id`)**.
- Seller staff see buyer PII only for active orders, masked where possible.
- **Every Seller Center endpoint has a cross-tenant negative test** (BOLA/BFLA, API1/API5).

### 19.1 Seller analytics (advanced)
**Metrics shown to sellers:**
- Traffic: store/profile views, product views, unique visitors, follower growth, source (feed, search, stylist, shared links, ads, creators, My Stores).
- Funnel: impression → view → save → bag → checkout → purchase, per product and drop.
- Sales: GMV, net after commission/fees, units, AOV, items/order, repeat-customer rate, new vs returning.
- **Sell-through** per drop and SKU; **size-curve analysis**; **aging inventory** alerts with **AI markdown recommendations** (elasticity model: "drop to 649 EGP to clear 80% in 7 days" with a confidence interval, and **a note that the new price will not show "% off" unless verified**).
- **Stylist inclusion rate** and cross-store basket partners (aggregated).
- Search terms leading to the store; **demand gaps**.
- Return rate and reasons per SKU, fit feedback, review sentiment.
- Ranking position and anonymized category percentiles.
- Customer geography by governorate; demographics only aggregated with **k-anonymity ≥ 50**.
- Ad ROAS/CPC/CTR, voucher ROI.
- Price Trust Score history and what to fix.
- Scheduled reports, CSV export (watermarked, audited), alerts.
- Carbon: estimated gCO2e per shipment (P2).

**Tech.** Served from the warehouse (ClickHouse) via a semantic layer, with RLS by store and a ≤ 15 min freshness SLO.

---

## 20. Core algorithms & data structures

### 20.1 Orders
`OrderGroup → SellerOrder → OrderLine`, plus `Shipment` and `Return`.

**SellerOrder states:**
- Main path: `PENDING_PAYMENT → PAID | CONFIRMED_COD → ACCEPTED → PACKED → SHIPPED → OUT_FOR_DELIVERY → DELIVERED → CLOSED` (after the return window).
- Returns: `RETURN_REQUESTED → RETURN_PICKUP_SCHEDULED → RETURN_IN_TRANSIT → RETURN_RECEIVED → RETURN_INSPECTED → REFUNDED | RETURN_REJECTED`.
- Exceptions: `CANCELLED`, `REJECTED_BY_SELLER`, `DELIVERY_FAILED → RTO → RETURNED_TO_SELLER`, `DISPUTED`.

**Cancellation:** free before `SHIPPED` (the shopper cancels in-app; the seller is notified; the refund saga runs). After `SHIPPED`, it becomes a refusal or return. The **7-day distance-selling cancellation right** is honored as a free return within 7 days of delivery (**⚠ VERIFY** interpretation).

### 20.2 Inventory (upgraded: row-per-unit + SKIP LOCKED)
Shopify's 2025 redesign moved reservations from Redis into the same ACID store as the inventory ledger. It models **one row per sellable unit**, takes rows with **`SELECT … FOR UPDATE SKIP LOCKED`**, caps the available pool (1,000 rows per item/location) with a background replenisher plus a single inline replenisher under lock for hot keys, and uses READ COMMITTED, consistent lock ordering and `UNION ALL` batching. Its bottleneck was **connection exhaustion**, not query speed ([Shopify Engineering](https://shopify.engineering/scaling-inventory-reservations)).

**HAUL implementation (Postgres):**
- `inventory_levels(sku_id, location_id, on_hand, committed)` holds the authoritative counts.
- `inventory_units(sku_id, location_id, id, state available|reserved|claimed, reservation_id, expires_at)`. PK `(sku_id, location_id, id)`. The pool is materialized from `on_hand − committed` and capped at `min(on_hand_free, 1000)`.
- **Reserve** (one tx, READ COMMITTED, SKUs locked in sorted order):
  ```sql
  WITH picked AS (
    SELECT id FROM inventory_units
    WHERE sku_id=$1 AND location_id=$2 AND state='available'
    ORDER BY id LIMIT $qty FOR UPDATE SKIP LOCKED)
  UPDATE inventory_units u SET state='reserved', reservation_id=$r, expires_at=now()+interval '10 min'
  FROM picked WHERE u.id=picked.id RETURNING u.id;
  ```
  If fewer than `qty` rows come back → roll back the whole multi-SKU reservation and return the shortfall to the shopper.
- **Claim** on payment: set the units `claimed`, increment `committed`, write the outbox event, and post the ledger, **all in the same transaction**.
- **Release:** a sweeper (pg_cron, every 30 s) returns expired reservations to `available`, with `FOR UPDATE SKIP LOCKED` batches of 500.
- **Replenisher:** a background job tops up the pool. For hot SKUs, an inline replenish runs under `pg_advisory_xact_lock(sku_hash)` so only one transaction refills.
- **Redis** holds only a "definitely sold out" flag per SKU (pre-filter) and the waiting-room queue. It is **never the source of truth**.
- **Seller stock sync** (channel integrations) adjusts `on_hand` through idempotent, versioned updates. A negative adjustment while units are reserved → those orders are honored and a seller oversell penalty applies.
- **Connections:** PgBouncer in transaction mode, `application_name` tagged by business process (`checkout.reserve`, `catalog.read`…), checkout pool isolated from analytics, statement timeout 2 s on the reserve path.

**Acceptance.** A chaos + property test with 10k concurrent reserves on 100 units → exactly 100 claimed, 0 oversold, no deadlocks across 1,000 runs.

### 20.3 Ledger → see §T4.

### 20.4 Buy Box
`score = a·price_norm + b·(−delivery_days) + c·seller_health + d·rating + e·price_trust`. Tie-break on stock depth. An "Other sellers" sheet lists the rest. Weights are admin-configurable, versioned and A/B-tested.

### 20.5 Ranking
- Two-stage: candidate retrieval (ANN + rules) → learning-to-rank (GBDT first, then neural).
- Features: decayed velocity, verified discount depth, freshness, affinity, size availability, budget fit (**computed on-device or as a request-time filter only, never stored as a seller-visible feature**), seller health, price trust, return rate.
- Diversity re-rank (≤ 2 consecutive per store), new-seller exploration (Thompson sampling, capped at 5% of impressions), bot filtering.
- A/B with guardrails (return rate, complaints).
- Note: no verified 2023–26 sources were gathered for the ranking stack, so it is industry standard.

### 20.6 Recommendations
Item-item co-view/co-buy (batch) → two-tower + pgvector ANN → session-based (sequence model, P3). "Similar" = visual + attribute embedding. "Similar for less" = similar AND price < current AND verified.

### 20.7 Fraud, risk & COD refusal controls
**Context.** About 51% of Egyptian online shoppers prefer COD, and secondary sources cite **MENA COD return-to-origin at 25–35%** ([eGrow](https://www.egrow.com/en/blog/the-state-of-cod-e-commerce-in-2026-markets-trends-and-opportunities); figure unsourced upstream, **⚠ VERIFY** with courier data).

**Model.** Rules + a GBDT risk score over: device/IP graph, phone age, account age, COD refusal history (cross-courier where data-sharing is lawful), velocity, voucher patterns, address quality score, order value, time of day, chargebacks, and BNPL cash-conversion signals.

**Decisions:** `allow` · `require OTP/WhatsApp confirmation` · `require partial prepayment (delivery fee or 20%)` · `prepaid only` · `limit value` · `block`.

**COD controls:**
| Control | Rule (default, configurable) |
|---|---|
| New-user COD cap | ≤ 1,500 EGP first order; ≤ 3,000 after 2 delivered |
| Order confirmation | WhatsApp/IVR confirm within 2 h for risk ≥ medium, else auto-cancel |
| Refusal policy | 1 refusal → warning + delivery fee prepaid next time; 2 in 90 days → prepaid only for 90 days |
| Open-box on delivery | Allowed for apparel (try-at-door P2, §28.6); refusal reason captured by courier app |
| Address quality | Landmark + map pin required for COD; low score → call confirmation |
| Multi-store COD | Each SellerOrder may ship separately; refusal of one does not cancel others |
| Seller protection | Refused COD return shipping charged per policy (platform-funded for first refusal) |

**Metrics.** COD refusal rate by governorate, fraud loss %, false-positive rate (good users blocked < 0.5%).

### 20.8 Demand forecasting (P2)
Per category/size/governorate forecasts advise sellers on Fulfilled-by-HAUL stock (quantile forecasts, with the interval shown).

---

## 21. Fulfillment & logistics (couriers, Bosta-first)
**Couriers.** Bosta is the tech-first leader: 25k+ merchants, 20M+ deliveries, next-day delivery in Egypt/KSA, instant cash collection ([Wamda](https://www.wamda.com/2024/01/bosta-raises-additional-investment-avanz-capital)). Bosta, Aramex and R2S integrate via API for dispatch, tracking, labels and COD reconciliation ([eGrow](https://www.egrow.com/en/blog/easyorders-carrier-integration-egypt-2026), [Bosta Shopify app](https://apps.shopify.com/bosta-shipping-app)). **Integrate Bosta first, then Aramex, then Mylerz/J&T** behind `CourierPort`. **⚠ VERIFY** the Bosta API endpoints, webhooks, COD remittance cycle and fees in the contract and sandbox.

**Flow.** Seller packs → `POST /v1/seller/shipments` → courier adapter creates the AWB (idempotent with the shipment ID) → printable label (A6 PDF) → pickup → tracking webhooks normalized to HAUL statuses → delivered (with proof: OTP code or photo) → COD collected → courier remittance → reconciliation.

**Rules.**
- Courier choice by governorate SLA, cost and seller preference.
- The ETA promise uses the p80 historical transit time.
- Delivery attempts: 3, then RTO.
- Return pickups are booked automatically for approved returns.

**Hub consolidation (P2):** multi-seller orders cross-dock at a HAUL hub → one parcel and one delivery fee.

**Data.** `shipments(id, seller_order_ids[], courier, awb, status, cod_amount, events[])` · `courier_events_raw` (dedup by courier event ID) · `cod_remittances`.

**Failure handling.**
- Courier API down → queue the AWB creation and retry with backoff, while the seller sees "label pending".
- A tracking webhook gap above 48h → poll.
- COD remittance mismatch → finance alert.

**Metrics.** On-time dispatch, delivery success rate, RTO rate, cost per order by governorate, gCO2e per shipment (courier-reported or distance-estimated).

**Acceptance.** Replaying all webhooks twice produces identical shipment state (idempotency).

## 22. Returns, exchanges & disputes
**Flow.** Orders → item → "Return or exchange" → reason (taxonomy: too small, too large, not as described, defective, changed mind, late, wrong item) → photos (required for defective or not-as-described) → method (pickup or drop-off) → resolution (**exchange first** for size reasons, with an instant size swap if in stock; else refund via §15.6).

**Rules (CPL 181/2018 baseline; ⚠ VERIFY details).**
| Case | Window (from `delivered_at`) | Who pays return shipping | Refund |
|---|---|---|---|
| Change of mind, unused with tags | 14 days | Shopper (free for Plus) | Item price; original delivery fee non-refundable unless whole order returned within 7 days |
| Defective / not as described / wrong item | 30 days | Seller | Full incl. delivery |
| Size exchange | 14 days | Free first exchange | n/a |
| Non-returnable (hygiene: underwear, swimwear without liner, pierced jewelry, cosmetics opened; personalized) | Disclosed on PDP and at checkout | — | Only if defective |
| Minor-defect/sample items sold "as is" with photos | Defect disclosed is not a return reason; other defects are | | |

**Inspection.** The seller (or the FBH hub) inspects within 48h of receipt. Silence → auto-approve. A rejection requires photos → the shopper can **dispute** → T&S review (human), SLA 5 business days.

**Serial returners.** A transparent policy: a return rate above 60% over ≥ 10 orders in 6 months → free returns removed and a notice sent. The policy is published, never secret, mirroring how Zalando tightened its policy against excessive returns ([ecommercegermany](https://ecommercegermany.com/blog/zalando-return-policy-update/)).

**Returns-resale lane (Veepee "Re-turn" model):** returned items that pass inspection can be relisted as "Open-box — returned" with condition grading (P2).

**API.** `POST /v1/orders/lines/{id}/returns` (idem) · `GET /v1/me/returns` · `POST /v1/seller/returns/{id}/inspect` · `POST /v1/returns/{id}/dispute`.

**Events.** `return_requested(reason)`, `return.received`, `return.inspected(result)`, `refund.completed`.

**Payout interplay.** Seller payouts for a line are released only after `CLOSED` (§T4). A refund after payout → seller balance negative → netted from the next payout.

**Metrics.** Return rate by category/seller/reason, fit-related return reduction, refund time p95, dispute rate.

**Acceptance.** A return requested on day 15 for change of mind is refused with a clear reason. A defect on day 29 is accepted.

---

## 23. Admin Console & platform analytics
**Operations:**
- Sellers & KYC, catalog quality scores.
- **Price-integrity monitor** (auto-action log, trends, appeals).
- Drops calendar & mega events (White Friday, 11.11, Ramadan, Eid al-Fitr, Eid al-Adha, Mother's Day 21 March, back-to-school, summer).
- Merchandising/homepage builder.
- Promotions, gift cards, referrals, rewards, Plus plans & pricing (versioned, price changes notify members ≥ 30 days ahead).
- Users & segments, logistics SLAs, returns & disputes.
- Support desk (tickets, chat, **WhatsApp Business inbox**, macros, AI-suggested replies with a human send).
- Ads manager, feature flags & experiments.
- **Privacy (DPO) console**, **tax (ETA) console**, **reconciliation console**.
- RBAC & immutable audit log.

**Admin security.**
- Passkey mandatory; access via SSO + device posture; IP allow-list for Finance and Super-admin.
- **Dual approval** for payouts above a threshold, refunds above a threshold, plan price changes, role grants and data exports.
- Just-in-time elevation; every PII view is logged with a reason code.

**Analytics:**
- GMV, net revenue, take rate, **contribution margin per order** (after shipping, payment fees, promos, returns, COD RTO).
- Conversion by step, AOV, items/order, **multi-store bag rate**, stylist-driven GMV.
- Cohorts (D1/D7/D30/M3), repeat rate, LTV by channel, CAC, payback.
- Plus: penetration, trial conversion, churn, savings delivered, LTV uplift.
- Budget feature impact.
- Price integrity KPIs.
- Logistics: dispatch, delivery success, COD refusal, cost by governorate.
- Returns.
- Promotion ROI and abuse.
- Referral K-factor.
- Supply health.
- Search health.
- **Sustainability: gCO2e per order (SCI), cost per order (FinOps)**.
- **Mega-event war room** (traffic, errors, checkout success, stock-outs, PSP health, queue depth).
- Anomaly alerts on all KPIs.

## 24. Notifications & CRM
**Channels:** push (APNs/FCM via Expo), in-app inbox, **WhatsApp Business** (template-approved), SMS, email.

**Triggers:** followed-store drops, price drops (verified), back in size, payday budget reset ("you can afford 3 wishlist items now"), stylist ("new outfits for Friday's wedding"), bag reminder (**once**), waitlist turn, order lifecycle, refunds, coins expiring, monthly budget report, Plus renewal with savings.

**Rules:**
- **Marketing requires consent per channel** (§B1); transactional messages do not.
- Frequency caps (marketing ≤ 1 push/day, ≤ 3/week).
- **Quiet hours 23:00–09:00 Africa/Cairo** (transactional exempt).
- Send-time optimization; per-type preferences.
- Journeys: welcome, first purchase, win-back, trial conversion.
- Every message is Arabic-first with an EN fallback.

**Data.** `notification_templates(versioned, AR/EN)` · `notification_log(partitioned)` · `preferences`.

**Failure handling.** Provider failover; WhatsApp template rejection → SMS fallback for transactional messages only.

**Metrics.** Opt-in rate, CTR, unsubscribe rate (guardrail).

## 25. Elite UI/UX
- **Principles:** calm luxury with moments of excitement; product imagery first; one clear next action per screen; no dead ends; **honesty is visible**.
- **Tokens** shared code↔Figma (Style Dictionary): semantic colors (savings green; urgency coral used sparingly), IBM Plex Sans Arabic + a Latin pair, 4-pt spacing, radii, elevation, motion.
- **Signature components:** ProductCard, PriceBlock (verified badge + installment line + budget-fit), SizeSelector with recommendation, OutfitCard (multi-store), BudgetRing, FreeDeliveryProgress per store, CountdownRing (server-time synced), IntentWishlist sheet, Stylist bubbles with carousels.
- **Motion:** shared-element transitions, haptics, confetti + savings total on order success; Reduce Motion respected.
- **Performance budgets:**
  - Cold start < 2 s (iPhone 12), TTI < 2.5 s.
  - Transitions < 300 ms; 60/120 fps lists (FlashList).
  - JS bundle < 6 MB.
  - Image payload per PDP < 400 KB above the fold.
  - Offline cache for bag, wishlist and orders.
- **Accessibility WCAG 2.2 AA:** Dynamic Type, VoiceOver AR/EN, 44-pt targets, contrast, correct RTL mirroring, accessible names on every icon button. Automated a11y checks run in CI on the web apps.
- **Localization:** Arabic default in Egypt, Egyptian-friendly copy, numeral preference (Western/Eastern Arabic), EGP formatting (`١٬٢٠٠ ج.م` / `EGP 1,200`), Hijri dates for campaigns.
- Every screen is designed in light/dark × AR/EN × loading/empty/error/offline before build. Each major flow is usability-tested with 5+ target users per iteration.

## 26. Analytics foundation
The event taxonomy lives in `/docs/analytics/events.md` with Zod-typed properties shared across apps:

`app_open, onboarding_step_completed, world_selected, store_viewed, product_viewed, filter_applied, search_performed, search_no_result, size_recommended, fit_feedback_submitted, stylist_outfit_generated, outfit_added_to_bag, affordability_view_opened, budget_set, budget_warning_shown, budget_cap_blocked_checkout, wishlist_added(intent), add_to_bag, free_delivery_unlocked, checkout_started, payment_selected, order_placed, order_delivered, return_requested(reason), refund_completed, price_badge_viewed, price_reported, plus_paywall_viewed, plus_started, plus_cancelled(reason), gift_card_purchased, gift_card_redeemed, referral_shared, referral_converted, coins_earned, drop_joined_queue, drop_admitted, consent_changed`

**Rules.** Collection is consent-aware (no analytics SDK before consent; strictly-necessary server events are pseudonymous). No PII in events. Schema registry in CI. Events go to a warehouse (ClickHouse) with dbt models and data contracts.

## 27. Trust & safety, content, IP
- Counterfeit notice-and-takedown (brand-owner portal; 48h SLA).
- Prohibited items list.
- Review guidelines: verified purchase only, a seller cannot review itself, no incentivized-review bias (coins are given for any honest review, not for positive ones).
- Image moderation (nudity/violence classifiers; AR/EN text toxicity).
- Seller duplicate/counterfeit detection via pHash across stores.
- Report flows on every UGC surface.

## 28. Additional features (recommended)
| # | Feature | Phase | Key rules |
|---|---|---|---|
| 1 | **Price-drop auto-buy** | P3 | Plus, explicit opt-in per item, target price, budget-checked, saved PSP token, max 1 unit, push before charge with a 15-min cancel; never BNPL/COD; SCA/3-DS per PSP (**⚠ VERIFY** merchant-initiated transaction support) |
| 2 | Back-in-my-size network alerts | P2 | Across all stores via matching (§9.2) |
| 3 | Outfit calendar | P3 | Events → stylist fills gaps |
| 4 | Wardrobe digitization | P3 | Photo → attributes; images P2 data, user-deletable |
| 5 | Split payment with friends (group gifts) | P2 | Each payer pays the PSP directly; pot not held by HAUL beyond the gift-card issue (§B2) |
| 6 | Try-at-door / open-box on delivery | P2 | Courier-supported governorates; refused items return immediately |
| 7 | Exchange-first returns | P1 | §22 |
| 8 | Pre-loved resale | P3 | Verified purchase history; **⚠ VERIFY** C2C regulatory/tax |
| 9 | Sustainability badge | P2 | "Saved from waste" units counter, derived from real sold clearance units only |
| 10 | Store events / sample sales QR | P3 | Signed QR tickets, offline validation |
| 11 | Corporate gifting portal | P2 | §15.1 |
| 12 | Shareable "My Haul" cards | P2 | No price/PII unless the user opts in |
| 13 | Smart reorder for basics | P2 | |
| 14 | Accessibility shopping mode | P2 | |
| 15 | Seller AI copilot | P2 | Listing quality score, photo tips, markdown advice, Q&A draft replies (seller sends) |
| 16 | **Returns-resale lane** (Veepee Re-turn) | P2 | §22 |

---

# PART D — TECHNOLOGY, SECURITY, RELIABILITY, SUSTAINABILITY

## T1. Architecture overview
```
apps/      mobile (Expo) · seller-web · admin-web · api (NestJS modular monolith) · workers · crawler · ml-services (FastAPI)
packages/  domain · validation (Zod) · api-client (generated) · ui-tokens · ui-native · ui-web · i18n · analytics · config · policy (authz)
infra/     terraform · k8s|ecs · observability · waiting-room
docs/      adr · specs · api · data-model · security (threat models, ASVS matrix) · privacy (ropa, dpia, tia) · compliance (verify-register) · runbooks · design-system · analytics · sustainability
```
**Backend modules:** auth, users, privacy, catalog, pricing-integrity, search-sync, inventory, cart, checkout, payments, ledger, payouts, tax-eta, orders, fulfillment, returns, promotions, gift-cards, store-credit, subscriptions, rewards, referrals, budget, sizing, stylist-gateway, recommendations-gateway, notifications, analytics-ingest, sellers, admin, fraud, trust-safety, voc. Split a module into its own service only when an ADR shows the need (load or team).

## T2. Mobile (Expo / React Native)
- **Expo SDK 55+ (RN 0.83+); the New Architecture is mandatory** because the Legacy Architecture is no longer supported. **Minimum Xcode 26.** iOS min 15.1 on SDK 55, with **SDK 56 raising it to 16.4**. `expo-av` is removed, so use `expo-video`/`expo-audio`. Android 16+ edge-to-edge is mandatory ([Expo SDK 55 changelog](https://expo.dev/changelog/sdk-55)).
- **Hermes v1 is opt-in** and has memory and startup regressions on SDK 55. Expo recommends SDK 57 for it, so **target the latest stable SDK at project start** (**⚠ VERIFY** whether 56 or 57) and adopt Hermes v1 only once stable.
- **EAS Update:** channels per environment, `--environment` required, runtime-version or fingerprint policy, **staged rollouts (1% → 10% → 50% → 100%)** with automatic rollback on crash-rate regression. Hermes bytecode diffing cuts update size ~75% (on by default from SDK 56).
- Stack: Expo Router, TS, TanStack Query (persisted), Zustand, react-hook-form + Zod, Reanimated, Gesture Handler, FlashList, expo-image (blurhash), MMKV (non-sensitive, encrypted instance for cache), **SecureStore/Keychain** (tokens; `WHEN_UNLOCKED_THIS_DEVICE_ONLY`), i18next + full RTL (`I18nManager` with reload flow), Sentry (source maps from EAS), PostHog (consent-gated).
- **Certificate pinning:** pin to **intermediate/SPKI hashes with ≥ 2 backup pins** and a **remote kill switch**; or rely on CT + App Attest. A stale pin must never brick the app during a drop. ADR required.
- **App Attest (iOS) / Play Integrity (Android)** on OTP, checkout, drops, gift-card redemption and referral attribution.
- **MASVS v2** control groups STORAGE, CRYPTO, AUTH, NETWORK, PLATFORM, CODE, RESILIENCE and PRIVACY are each mapped to tests in `/docs/security/masvs.md`, with MASTG test cases in CI where automatable ([OWASP MASVS](https://mas.owasp.org/MASVS/)).
- Deep links: universal links/app links with verified domains. Parameters are validated and never trusted for auth.

## T3. Backend, API & data
- **NestJS modular monolith** on Node LTS. REST + **OpenAPI generated from code** → typed client. `/v1` versioning with a deprecation policy (≥ 6 months, `Sunset` header). Cursor pagination, ETags, `Problem+JSON` errors, per-route rate limits (Redis token bucket), request size limits, and a default timeout of 10 s.
- **AuthZ:** a central `policy` package (resource-ownership + role + tenant) is enforced in a guard **and** by Postgres RLS on tenant tables. **Deny by default.** An object ID not found or not owned → 404 (API1/API3/API5).
- **Mass-assignment protection:** DTOs are explicit allow-lists, and response serializers are explicit (API3).
- **PostgreSQL 16+** (managed, multi-AZ, PITR, read replicas) + pgvector + pg_cron + PgBouncer. Partition high-volume tables (events, price snapshots, webhooks, audit) monthly. Migrations are expand/contract only (zero-downtime), and checked in CI by a migration linter.
- **Redis:** caching, rate limits, waiting room, sold-out flags, and BullMQ (or SQS) for queues. Redis is never a source of truth for money or stock.
- Typesense; S3-compatible storage + CDN with on-the-fly resizing (AVIF/WebP).
- **Warehouse:** ClickHouse/BigQuery + dbt (residency per ADR-0002).
- Feature store; model registry (MLflow).
- **ML services:** FastAPI, versioned features, offline eval, shadow deploys, online A/B, **model cards**, drift monitoring.
- **Crawler workers:** headless pool in an isolated network segment, robots.txt compliance, per-domain politeness, snapshot storage, change detection, SSRF guard.

## T4. Ledger, payouts & reconciliation
Stripe runs an internal double-entry ledger with data-quality metrics as the backbone of its money movement ([Stripe Dev Blog](https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)). Marketplace split models (destination charges, separate charges and transfers) are the reference ([Stripe Connect](https://docs.stripe.com/connect/charges)). Egyptian PSPs may not offer Connect-style splits, so **HAUL's ledger is the system of record** for seller sub-balances, which makes reconciliation critical.
- **Tables:** `ledger_accounts(id, type, owner_type, owner_id, currency)` · `journal_entries(id, kind, idempotency_key UNIQUE, occurred_at, ref_type, ref_id)` · `postings(entry_id, account_id, amount BIGINT signed, currency)`.
- A **deferred constraint trigger** ensures the sum of postings per entry per currency is 0. Postings are immutable (UPDATE/DELETE revoked). Corrections use reversing entries.
- **Accounts:** `psp_clearing:{psp}`, `cod_clearing:{courier}`, `seller_payable:{store}`, `platform_commission`, `platform_vat_output`, `shipping_revenue`, `promo_expense_platform`, `promo_receivable_seller`, `store_credit:{user}:{sub}`, `gift_card_liability`, `refund_reserve`, `bnpl_clearing:{provider}`, `plus_revenue`, `deferred_plus_revenue`.
- **Order paid (example):** Dr psp_clearing 2,500 / Cr seller_payable:A 1,600, seller_payable:B 600, platform_commission 230, platform_vat_output 32.2 (14% on commission), shipping_revenue 37.8 … (always balanced; amounts in piastres in code).
- **Payouts:** the state machine is `SCHEDULED → ON_HOLD (risk) → APPROVED → SENT → SETTLED | FAILED`. Eligibility: line `CLOSED` (return window plus 3 days) and no dispute. Weekly cycle; dual approval above a threshold; IBAN name-match; payout through the PSP/bank API, idempotent.
- **Reconciliation (nightly, plus intraday during mega events):**
  - PSP settlement files ↔ `psp_clearing`.
  - Courier COD remittances ↔ `cod_clearing`.
  - BNPL settlements ↔ `bnpl_clearing`.
  - ETA submissions ↔ invoices.
  - Store-credit projections ↔ postings.
  - Any unmatched line → a ticket and alert; aging above 3 days → Finance escalation.
- **Integrity job:** a global trial balance equal to 0, verified hash chain on journal entries, and a daily signed snapshot.

## T5. Security baseline
- **Standards:**
  - **OWASP ASVS 5.0.0 (June 2025) Level 2** for API and web, Level 3 for the ledger, payments and admin. ASVS 5.0 renumbered every requirement, so map controls in `/docs/security/asvs-5.0-matrix.md` ([SoftwareMill](https://softwaremill.com/whats-new-in-asvs-5-0/), [OWASP ASVS](https://owasp.org/projects/asvs)). Include V10.4 OAuth AS items if HAUL ever issues tokens to third parties, and the sender-constrained tokens (DPoP) consideration for refresh tokens.
  - **MASVS v2** for mobile.
  - **OWASP API Security Top 10 2023**, with each item mapped to tests.
  - **OWASP LLM Top 10 2025** for AI features.
  - **PCI SAQ A** + FAQ 1588 controls (§B8).
- **Identity:** passkeys (WebAuthn/FIDO2) for sellers and admins (mandatory) and offered to shoppers ([FIDO](https://fidoalliance.org/passkeys/)). TOTP is the fallback.
- **Crypto:** TLS 1.2+ (prefer 1.3), HSTS preload, AES-256 at rest. **Field-level envelope encryption** with KMS-managed DEKs for P3 (phone, DOB, addresses, measurements, IDs, IBAN, budget). **Blind indexes** (HMAC) for lookup. Key rotation yearly. Plan the post-quantum migration (ASVS 11.1.4, L3) in the crypto inventory.
- **Input/output:** Zod at every boundary, parameterized queries only (Prisma/Kysely), output encoding, CSP with nonces, strict CORS, upload pipeline (type sniff, size cap, AV scan, EXIF/GPS strip, re-encode, private buckets, signed URLs ≤ 15 min).
- **Business-flow abuse (API6):** bot management at the edge, per-account/device limits, attestation and velocity rules on drops, checkout, OTP, referrals, gift cards and reviews.
- **SSRF (API7):** crawler and webhook egress through an allow-listed proxy.
- **Inventory (API9):** API catalog auto-generated, with no shadow endpoints; a staging environment cannot reach production data.
- **Unsafe consumption (API10):** responses from PSPs, couriers and ETA are schema-validated and handled with timeouts and circuit breakers.
- **Supply chain:** lockfiles, Renovate, `pnpm audit` + OSV, **SBOM (CycloneDX)** per build, **Sigstore cosign** image signing, **SLSA v1.0 Build L2 → L3** provenance via hardened CI, secret scanning (pre-commit + CI), SAST (Semgrep/CodeQL), DAST (ZAP on staging), container scanning, IaC scanning (Checkov/tfsec) ([SLSA](https://slsa.dev/spec/v1.0/), [Sigstore](https://www.sigstore.dev/), [CycloneDX](https://cyclonedx.org/)).
- **Ops security:** least-privilege IAM, no long-lived cloud keys (OIDC from CI), break-glass accounts, WAF, DDoS protection, an immutable audit log shipped to WORM storage.
- **Testing:** STRIDE threat model per module; **external pen test before launch and yearly**, plus before each major money feature; a bug bounty (private at launch).
- **Incident response:** severity matrix, on-call, breach runbook tied to the PDPL 72h/3-day clock (§B1).

## T6. Privacy engineering
Covered by `data_inventory.yaml` → RoPA, retention jobs, DSAR automation, consent gating of SDKs, pseudonymous analytics IDs (rotated yearly), a **DPIA** for the stylist, fit, budget and fraud models, a **TIA** for any cross-border processor, and processor DPAs (PSP, couriers, SMS, LLM vendor, cloud).

## T7. Infrastructure & environments
- Terraform with remote state and policy-as-code (OPA/Conftest).
- Docker; managed containers (ECS or Kubernetes).
- Environments dev / staging (prod-like, synthetic data only) / prod.
- **Region per ADR-0002 (PDPL residency and transfer).**
- CDN + WAF + waiting room at the edge.
- Secrets manager.
- Blue/green + canary (5% → 25% → 100% with automated SLO gates).
- Autoscaling on queue depth and RPS. Pre-scale before drops via a scheduled scaling plan.

## T8. Observability & SRE
- **OpenTelemetry** traces, metrics and logs end-to-end, with mobile → API trace propagation. Structured JSON logs with PII redaction at the logger level. **Business-context tags** on spans and DB connections (Shopify's connection-tagging lesson, [Shopify Engineering](https://shopify.engineering/scaling-inventory-reservations)).
- **SLOs (with error budgets):**
  | Journey | SLI | SLO |
  |---|---|---|
  | Checkout | successful order placements / attempts (excl. user-declined) | ≥ 99.5% (28d) |
  | Reserve | p95 latency of reserve tx | < 150 ms |
  | Payment confirmation | webhook → order PAID p95 | < 5 s |
  | API | p95 latency (read) | < 300 ms |
  | Search | p95 | < 150 ms |
  | Mobile | crash-free sessions | ≥ 99.8% |
  | Refunds | initiated within 24 h of return receipt | ≥ 99% |
  | Reconciliation | unmatched PSP lines older than 3 days | 0 |
- **Multi-window, multi-burn-rate alerting** (1h/5m and 6h/30m windows) per the Google SRE Workbook ([SRE Workbook](https://sre.google/workbook/alerting-on-slos/)).
- **Error-budget policy:** budget exhausted → feature freeze except reliability work. **A release freeze 48h before mega events** plus a game day.
- Blameless postmortems within 5 business days.

## T9. Resilience & performance testing
- k6 load at **20× baseline** before mega events, with a drop simulation (§16 acceptance).
- **Chaos tests:**
  - PSP down → failover or hidden method.
  - Search down → Postgres fallback.
  - Redis down → waiting room fails closed (drops paused) while normal checkout continues.
  - Courier API down → queued.
  - LLM down → rule-based stylist.
- **RPO ≤ 15 min, RTO ≤ 1 h**; monthly restore drills (restore to a scratch environment, then run the integrity job).
- A degraded-mode matrix is documented per dependency.

## T10. Sustainability (green software) & FinOps
The Green Software Foundation's **SCI** became **ISO/IEC 21031:2024** on 25 April 2024 ([GSF](https://greensoftware.foundation/articles/sci-specification-achieves-iso-standard-status/)). It measures `SCI = ((E × I) + M) per R` ([SCI spec](https://sci.greensoftware.foundation/)).
- **Functional unit R = one completed order** (plus "per 1,000 sessions" for browsing).
- Compute E from cloud provider carbon tools and Impact Framework estimates, and I from the grid intensity of the chosen region (**⚠ VERIFY** MENA region intensity data). M is embodied emissions.
- **Levers (mandatory):**
  - AVIF/WebP with on-the-fly resizing to the device DPR.
  - Lazy-load; video autoplay only on Wi-Fi or by user setting; a weekly image-payload budget check in CI.
  - Scale to zero for non-prod at night.
  - Batch jobs (reconciliation, analytics, model training) in low-carbon windows where SLAs allow.
  - Right-size via autoscaling.
  - Deduplicate the crawler (ETag/If-Modified-Since, DOM hash).
  - LLM caching and smallest-adequate models.
  - **Hub consolidation** (one parcel, fewer trips) and the **returns-resale lane** as physical-world levers.
- **FinOps:** cost per order and cost per 1k sessions on dashboards next to gCO2e per order. Budget alerts per environment and per LLM feature.
- **Shopper-facing:** "saved from waste" counts real sold clearance units (§28.9). No carbon claims without a methodology page.

## T11. Code quality & delivery
- Testing pyramid/trophy per A2.10. Mutation testing on the critical modules. Pact contracts. Fitness functions (dependency-cruiser, bundle-size budget, API latency budget in CI perf tests).
- **Trunk-based development** with short-lived branches; PR template (spec link, threat notes, screenshots AR/EN × light/dark); required reviews (2 for money/security code, with CODEOWNERS); conventional commits; automated changelog.
- **DORA targets:** deploy daily (API), lead time < 1 day, change-failure rate < 15%, recovery < 1 h.

## T12. LLM platform rules
- **Uses:** stylist, NL search parsing, attribute extraction, VoC summaries, seller copywriting, support reply suggestions.
- All calls go through `llm-gateway`, which handles provider abstraction, prompt registry (versioned), schema-constrained outputs, PII scrubber, injection heuristics, per-feature cost budgets and circuit breaker, caching, eval suites (golden sets AR/EN, regression on each prompt change) and audit (prompt hash, model, tokens; no raw P2/P3).
- **Residency:** no P2/P3 data leaves the approved region without consent and a licence (§B1).
- Map every feature to **LLM01–LLM10** in `/docs/security/llm-threats.md`.

---

# PART E — DELIVERY

## P1. Launch checklist
- **App Store:** privacy labels and privacy manifest, account deletion, Sign in with Apple, subscription disclosures (Plan A/B decided), review demo account, early App Review consultation on Plus (§B7).
- **Legal sign-off:**
  - ToS; Seller Agreement (commission, SLAs, prohibited items, counterfeit liability, **price parity & genuine discount + consent to monitoring**, automatic penalties, payouts, DPA).
  - Privacy Policy (PDPL), consent texts, cookie/tracking notice.
  - Subscription Terms, Gift Card Terms, Store Credit Terms (closed-loop wording), Rewards & Referral Terms, Prohibited Items, Review Guidelines, IP notice-and-takedown, Returns & Refunds Policy (CPL), Accessibility statement.
  - **All of it in Arabic (authoritative) + English.**
- **Regulatory:** PDPC licence/registration and DPO appointed (by **1 Nov 2026**); transfer licence if needed; CBE/counsel opinion on store credit; ETA registration + e-invoice/e-receipt live; VAT registration.
- **Security:** external pen test passed (no high/critical open), ASVS L2 matrix complete, MASVS tests green, SAQ A + FAQ 1588 evidence filed, SBOM/signing live.
- **Reliability:** 20× load test passed, drop simulation passed, restore drill passed, on-call staffed.
- **Contracts live:** PSPs (Paymob/Kashier primary + failover; Fawry), ≥ 1 BNPL provider (valU or Sympl), couriers (Bosta + Aramex), SMS + WhatsApp BSP.
- **Supply:** 30 curated launch brands with channel integrations connected ≥ 30 days before launch, so price integrity has history.
- **Support:** AR/EN staffed, including WhatsApp, with macros.
- **Go-to-market:** Grand Opening 72-hour Mega Drop, waitlist referral leaderboard, 50 micro-creators.

## P2. ⚠ VERIFY BEFORE LAUNCH — register (seed rows)
| # | Item | Owner |
|---|---|---|
| 1 | PDPC licence category/fees; DPO qualification; statutory DSAR deadline; penalty figures | Legal/DPO |
| 2 | Data residency & cross-border transfer licence; LLM vendor transfer | Legal/CTO |
| 3 | CBE: closed-loop store credit & gift cards outside e-money; aggregator collection/payout model | Legal/Finance |
| 4 | Paymob split/sub-merchant, tokenization, recurring; fees; settlement T+n | Finance |
| 5 | BNPL providers: API, min age (21?), refund/cancel flows, marketing rules under FRA guide (6 Sep 2026) | Finance/Legal |
| 6 | ETA: HAUL's e-receipt obligation date; delegated signing for sellers; marketplace withholding/reporting; VAT on coins/vouchers/gift cards | Tax |
| 7 | CPL 181/2018: Art. 9 discount text; refund payment deadline; 7-day cancel vs 14-day return interplay; statutory exclusions; platform joint liability | Legal |
| 8 | Age of majority 21 vs 18; contracts with 18–20-year-olds; Plus age gate | Legal |
| 9 | Gift card expiry limits; promotional games/mystery box lottery rules | Legal |
| 10 | Apple: Plus via PSP (3.1.5(a)) vs IAP (3.1.1); current guideline text; US link-out fee status | Product/Legal |
| 11 | Bosta/Aramex API specs, COD remittance cycle | Ops |
| 12 | COD RTO baseline in Egypt (courier data) | Ops/Data |
| 13 | Product-match threshold τ precision on labeled Egyptian set | ML |
| 14 | Current Expo SDK (56 vs 57) & Hermes v1 readiness | Mobile |
| 15 | Fully automatic seller suspension legality | Legal |
| 16 | Waiting-room vendor & region | Infra |
| 17 | Creator VAT threshold & payout tax | Tax |
| 18 | Grid-carbon intensity for chosen region | Infra |

## P3. Phases
**Phase 0 — Foundations (4 wks):**
- Monorepo, CI/CD with SBOM/signing, IaC, environments, region ADR.
- Auth (OTP, Apple, Google, passkeys), the policy/RLS layer, consent & privacy core.
- Security baseline, design tokens + core components, i18n/RTL.
- Observability + SLO dashboards, event taxonomy, STRIDE threat models, ADRs, ERD, `data_inventory.yaml`.
- Ledger core, outbox/inbox, idempotency middleware, feature flags.

**Phase 1 — MVP: iOS + Seller Center + Admin (12–14 wks):**
- Onboarding + 18+/21+ gates, worlds (Local/Global/All/My Stores), stores, catalog.
- Search + filters (budget, size, installments), product page.
- Size profile + measurement guide + charts + fit v1 (chart matching + item flags).
- Intent wishlists, multi-store bag (free delivery ≥ 2,000 EGP per store).
- One-payment checkout (cards, Apple Pay, wallets, InstaPay, Fawry, COD with risk controls, 1 BNPL partner, store credit).
- Row-per-unit inventory, order splitting, ledger, payouts, reconciliation.
- **ETA e-invoice for commission + e-receipts**.
- Bosta integration, returns/refunds/exchange-first, vouchers core, referrals core.
- **Price integrity v1** (internal ledger + Shopify/Woo integrations + auto display rules).
- Notifications, seller analytics v1, admin essentials incl. the DPO console, legal pages AR/EN, Privacy Center, TestFlight beta.

**Phase 2 — Love & Monetize (10–12 wks):**
- HAUL Plus (Plan A/B per App Review), gift cards & store credit, **budget suite + affordability**, **AI stylist v1** (outfits within budget, complete the look).
- Recommendations & similar items, history, rewards/tiers/games, feed ranking, all drop types + waiting room.
- Crawler + image matching (price integrity v2), more BNPL partners, Aramex, hub consolidation, returns-resale lane.
- Sponsored products, advanced seller & admin analytics, VoC, A/B framework, SCI/FinOps dashboards.
- **Android launch.**

**Phase 3 — Scale & Wow:**
- Stylist chat + wardrobe digitization + outfit calendar, visual search, photo-based body measurement (on-device).
- LTR ranking v2, live shopping, creators, resale, shopper web SEO, Odoo, family/student plans, demand forecasting, price-drop auto-buy.
- Partner e-money wallet (if licensed), GCC expansion.

## P4. Definition of Done (every feature)
- Spec (A3 template) + ADR if needed + threat notes.
- Types & Zod validation.
- Unit/integration/E2E **and negative authorization tests** green; mutation threshold met on critical modules; Pact contracts verified.
- AR/EN + RTL; light/dark; loading/empty/error/offline states; WCAG 2.2 AA checked.
- Analytics events (typed, consent-aware); logs/metrics/traces/alerts; SLO defined.
- Security review (ASVS/MASVS/API/LLM mapping); privacy review (`data_inventory.yaml` updated, retention set).
- Performance budget met; image/carbon budget met.
- Feature flag + kill switch; runbook; docs updated.
- ⚠ VERIFY items resolved or explicitly accepted by the owner.
- Product sign-off on TestFlight.

## P5. Your first task
1. Read everything. List **open questions (max 12)** that block irreversible decisions, starting with the P2 register rows 2, 3, 4, 8 and 10.
2. Deliver:
   - `/docs/adr/0001-architecture.md`, `0002-data-residency.md`, `0003-wallet-store-credit.md`, `0004-plus-billing-app-store.md`, `0005-inventory-row-per-unit.md`.
   - A complete ERD (`/docs/data-model.md`) covering every module.
   - `data_inventory.yaml` and the RoPA draft.
   - An OpenAPI skeleton for Phase 1.
   - Design tokens.
   - The event taxonomy.
   - STRIDE threat models + an ASVS 5.0 L2 matrix skeleton.
   - The price-integrity spec.
   - The ledger chart of accounts with worked examples.
   - The verify register.
   - A Phase 0–1 task breakdown with estimates and dependencies.
3. Wait for approval, then implement Phase 0.

---

## Sources

**Egypt legal, tax, payments**
- PDPL Executive Regulations (Decision 816/2025): [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins) · [Al Tamimi](https://www.tamimi.com/news/from-policy-to-practice-egypt-issues-executive-regulations-of-the-personal-data-protection-law) · [Clyde & Co](https://www.clydeco.com/en/insights/2026/01/egypt-regulatory-update-on-data-privacy) · [Kennedys](https://www.kennedyslaw.com/en/thought-leadership/article/2026/egypt-s-personal-data-protection-law-the-compliance-countdown-has-begun)
- CBE e-money licensing: [Andersen via Mondaq](https://www.mondaq.com/fintech/1755348/electronic-money-institution-licensing-in-egypt) · [Egypt Today](https://www.egypttoday.com/Article/3/140779/CBE-announces-new-rules-for-licensing-and-registration-of-payment) · [Business Today Egypt](https://www.businesstodayegypt.com/amp/1/6465/Central-Bank-of-Egypt-issues-new-licensing-rules-for-payment)
- FRA consumer finance: [Law 18/2020 translation (Mondaq)](https://webiis10.mondaq.com/financial-services/1777326/translation-of-law-no-18-of-2020) · [Mondaq overview](https://www.mondaq.com/corporate-governance/1046572/overview-on-the-consumer-finance-companies-in-egypt) · [Amwal Al Ghad — FRA guide, 6 Sep 2026](https://en.amwalalghad.com/?p=230558)
- ETA e-receipt / VAT: [RTC Suite](https://rtcsuite.com/egypt-widens-b2c-e-receipt-mandate-new-taxpayers-required-as-of-september-2025/) · [KPMG](https://kpmg.com/us/en/taxnewsflash/news/2025/01/tnf-egypt-taxpayers-required-comply-mandate-electronic-receipts-b2c-transactions.html) · [Comarch](https://www.comarch.com/trade-and-services/data-management/legal-regulation-changes/egypt-expands-e-receipt-requirements-for-b2c-transactions-from-september-2025/) · [Enterprise](https://enterpriseam.com/egypt/2025/09/24/finmin-to-introduce-new-tax-incentives-targeting-e-commerce-platforms/) · [Avalara](https://www.avalara.com/vatlive/en/country-guides/africa-and-middle-east/egypt-vat/egyptian-vat-rates.html) · [vatcalc](https://www.vatcalc.com/egypt/egypt-vat-on-digital-services-foreign-providers/)
- Consumer Protection Law 181/2018: [Mondaq](https://www.mondaq.com/Article/820956/New-Egyptian-Consumer-Protection-Law) · [Digital Policy Alert (Decree 822/2019)](https://digitalpolicyalert.org/event/28035-executive-regulation-for-consumer-protection-law-no181-of-2018-prime-ministers-decree-no-822-of-2019-including-usersubject-right-entered-into-force) · [Lexis](https://www.lexis.ae/2019/04/08/egypt-implementing-regulations-to-consumer-protection-law-published/) · [UNESCWA](https://unescwa.org/sites/default/files/inline-files/ABLF-2023-consumer-CP-Egypt-english.pdf)
- Age of majority: [Ahram Online](https://english.ahram.org.eg/News/120441.aspx)
- Payments: [Kashier docs](https://developers.kashier.io/docs/accept-payments) · [MEA TechWatch (Fawry Apple Pay)](https://meatechwatch.com/2025/10/30/fawry-launches-apple-pay-in-egypt-in-partnership-with-banque-misr/) · [Shuttle Global](https://www.shuttleglobal.com/blog/the-most-popular-payment-methods-in-egypt/) · [Geidea Tamara](https://docs.geidea.net/edit/tamara) · [Martechvibe (Paymob–Tabby)](https://martechvibe.com/article/uaes-tabby-paymob-announce-partnership)

**Architecture, security, platform**
- [Shopify Engineering — Scaling inventory reservations](https://shopify.engineering/scaling-inventory-reservations)
- [Stripe Ledger](https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement) · [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests) · [Stripe Connect charges](https://docs.stripe.com/connect/charges)
- [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) · [Saga](https://microservices.io/patterns/data/saga.html)
- [OWASP ASVS](https://owasp.org/projects/asvs) · [SoftwareMill ASVS 5.0](https://softwaremill.com/whats-new-in-asvs-5-0/) · [OWASP MASVS](https://mas.owasp.org/MASVS/) · [OWASP API Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) · [OWASP LLM Top 10 2025](https://genai.owasp.org/2024/11/17/owasp-reveals-updated-2025-top-10-risks-for-llms-announces-new-llm-project-sponsorship-program-and-inaugural-sponsors/)
- PCI SAQ A 2025: [Report URI](https://blog.report-uri.com/pci-dss-4-0-1-saq-a-and-client-side-security-a-plain-english-faq/) · [SecurityMetrics](https://chat.securitymetrics.com/blog/guidance-on-saq-a-updates) · [Akamai](https://www.akamai.com/blog/security/pci-dss-v4-0-1-changes-qualify-saq-a)
- [SLSA v1.0](https://slsa.dev/spec/v1.0/) · [Sigstore](https://www.sigstore.dev/) · [CycloneDX](https://cyclonedx.org/) · [FIDO passkeys](https://fidoalliance.org/passkeys/)
- [Expo SDK 55 changelog](https://expo.dev/changelog/sdk-55) · [Expo New Architecture](https://docs.expo.dev/guides/new-architecture/)
- [DORA metrics](https://dora.dev/guides/dora-metrics-four-keys/) · [Pact](https://docs.pact.io/) · [Stryker](https://stryker-mutator.io/) · [Google SRE Workbook — alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- [GSF — SCI ISO status](https://greensoftware.foundation/articles/sci-specification-achieves-iso-standard-status/) · [ISO/IEC 21031:2024](https://scc-ccn.ca/standardsdb/standards/8186510) · [SCI spec](https://sci.greensoftware.foundation/)
- Apple: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) · [Michael Tsai — May 2025 update](https://mjtsai.com/blog/2025/05/02/app-review-guidelines-updated-for-epic-anti-steering) · [Shibolet](https://www.shibolet.com/en/apple-guidelines-update-redirecting-users-to-external-payment-mechanism/) · [Cravath — Ninth Circuit](https://www.cravath.com/news-insights/epic-games-ninth-circuit-win-affirming-civil-contempt-finding.html) · [MacRumors, Jun 2026](https://www.macrumors.com/2026/06/11/apple-fights-back-against-epic/)

**Fashion AI & benchmarks**
- [Pinterest Complete the Look (CVPR 2019)](https://openaccess.thecvf.com/content_CVPR_2019/papers/Kang_Complete_the_Look_Scene_Based_Complementary_Product_Recommendation_CVPR_2019_paper.pdf) · [arXiv 1812.01748](https://ar5iv.labs.arxiv.org/html/1812.01748) · [Bootstrapping CTL (KDD 2020)](https://arxiv.org/abs/2006.10792v1)
- [Stitch Fix latent style](https://multithreaded.stitchfix.com/blog/2018/06/28/latent-style/) · [Stitch Fix latent size](https://multithreaded.stitchfix.com/blog/2017/12/13/latentsize/) · [Gelman](https://andrewgelman.com/2018/06/25/multilevel-modeling-stan-improves-goodness-fit-literally/)
- Zalando: [size advice](https://corporate.zalando.com/en/node/10416) · [photo measurements](https://corporate.zalando.com/en/node/10477) · [mind.eu](https://www.mind.eu.com/retail/en/zalando-returns-drop-by-10-thanks-to-sizing-recommendations/) · [return policy update](https://ecommercegermany.com/blog/zalando-return-policy-update/)
- Matching: [ProMap](https://arxiv.org/pdf/2309.06882) · [NTU ensemble](https://www.csie.ntu.edu.tw/~fuh/personal/SolvingProductMatchingProblembyEnsembleMethod.pdf) · [pHash comparison](https://ssojet.com/compare-hashing-algorithms/phash-vs-spectral-hash)
- Benchmarks: [Veepee 2024 (Il Sole 24 Ore)](https://en.ilsole24ore.com/art/veepee-group-closes-2024-33-billion-italy-flash-sales-grow-twice-as-fast-as-europe-AGPsLRyD) · [Temu retention (Fashion Dive)](https://www.fashiondive.com/news/temu-retention-ecommerce-market/711168/) · [Sensor Tower SHEIN vs Temu](https://sensortower.com/blog/e-commerce-app-battle-temus-rising-star-challenged-by-sheins-loyalty-game) · [Namshi/noon](https://www.imagesretailme.com/?p=33253) · [noon One](https://absolutegeeks.com/article/top-stories/noon-one-members-get-free-osn-subscription-in-new-promotion)
- COD & couriers: [eGrow COD 2026](https://www.egrow.com/en/blog/the-state-of-cod-e-commerce-in-2026-markets-trends-and-opportunities) · [Wamda — Bosta](https://www.wamda.com/2024/01/bosta-raises-additional-investment-avanz-capital) · [Bosta Shopify app](https://apps.shopify.com/bosta-shipping-app) · [eGrow carrier integration](https://www.egrow.com/en/blog/easyorders-carrier-integration-egypt-2026)

**Research gaps (not sourced in this pass; treated as industry practice):** ranking/recommendation architectures (two-tower, LTR, session models), Paymob marketplace APIs, Egypt-specific COD refusal rates, Mylerz/J&T APIs, MENA grid-carbon intensity, and the current MASVS minor version.
