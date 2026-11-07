# ADR-0006: Global-ready from day one, launch in Egypt only

- Status: Proposed (owner asked 2026-11-07: "I need to expand worldwide")
- Deciders: Owner, CTO
- Related: ADR-0001 (architecture), ADR-0002 (data residency), master prompt §T1/§T4, vision addendum

## Context
The owner wants to expand worldwide. Launching several countries at once would multiply legal, payment, logistics and supply work, and each market has its own data, tax and consumer laws. On the other hand, building Egypt-only assumptions into the code (EGP everywhere, Egyptian address fields, a hard-coded 14% VAT, a 14-day return window) would force a rewrite later.

## Options considered
1. **Egypt-only code, rewrite later.** This is fastest now. Expanding later costs months, risks bugs in money code, and means migrating data.
2. **Multi-country launch.** This splits focus, multiplies compliance work, and would burn the budget before product–market fit.
3. **Global-ready architecture, single-market launch (chosen).** It adds about 5–10% extra design effort now. A new country then becomes mostly configuration, adapters and a legal entity.

## Decision
Build these 12 things into the foundations from day one. Launch only `EG`.

| # | Build now | Why |
|---|---|---|
| 1 | **Market entity**: every store, listing, order, price and policy has a `market_id` (EG first). Market config holds currency, languages, tax rules, return windows, age gates, quiet hours, COD rules and the holiday calendar. | New country = new config row, not code |
| 2 | **Money = (amount in minor units, currency)** everywhere. Ledger accounts are per currency. FX happens only at explicit, logged conversion points. No mixed-currency sums. | Multi-currency without rewrites |
| 3 | **Country-specific rules are config or plug-ins, not `if (EG)`**: returns, cancellation windows, warranty, age, consent purposes, invoice language. | Each country's consumer law differs |
| 4 | **Ports and adapters** for payments, BNPL, couriers, tax/e-invoicing, KYC, SMS/WhatsApp, maps. EG adapters first (Paymob/Kashier, Bosta, ETA, Valify). | Swap providers per country |
| 5 | **Tax engine per jurisdiction** (rates, inclusive/exclusive, e-invoice format). ETA is the first plug-in; ZATCA (KSA) and the UAE FTA come later. | E-invoicing differs by country |
| 6 | **Data residency by market ("cells")**: personal data lives in the market's own region; the global layer holds only the public catalog and anonymous data. Every table is tagged with its residency class in `data_inventory.yaml`. | Egypt PDPL now; KSA PDPL and others later |
| 7 | **i18n beyond AR/EN**: ICU messages, RTL and LTR, locale-aware numbers, dates, currency and plurals, Hijri and Gregorian calendars. No text inside images. | Add FR (Maghreb) or TR without redesign |
| 8 | **Flexible address model**: a country-specific schema validated by Zod (EG governorate/district/landmark; KSA national address; UAE makani…), plus a map pin. | Addresses differ widely |
| 9 | **Phone/ID/KYC by country**: E.164 phones, KYC document types per market. | Identity rules differ |
| 10 | **Time zones**: store UTC, show local. Drop Hour and campaigns are defined per market time zone. | Daily drop at 9 pm local |
| 11 | **Cross-border sellers**: a seller has a home country and the markets it may sell to; shipping, duties and ETAs come from adapters (Phase 3). | Global brands sell into Egypt first |
| 12 | **Domains and SEO**: one domain with `/{country}-{lang}/` paths (e.g. `/eg-ar/`) plus hreflang. The brand name must be trademark-checked in target markets. | Clean expansion, no SEO reset |

What we will **not** build now: real multi-country checkout, FX pricing, cross-border duties, a second legal entity, or other markets' adapters.

## Expansion path (proposal, each step behind a gate)
1. **Egypt**: prove the model (year 1).
2. **Inbound global**: global and Gulf brands sell **into** Egypt, using the same platform as now (year 1–2).
3. **First new market: KSA or UAE.** These are large Arabic-speaking markets, and the Arabic-first product and Gulf brands carry over. Each needs a local entity, VAT and e-invoicing (ZATCA in KSA), its own data-protection law, and local PSPs and couriers. ⚠ VERIFY per market.
4. Then **Morocco/North Africa** (adds French) or other MENA markets, chosen by data.
5. **SaaS-only expansion**, which can go faster: brands in any country use the Seller Center tools (Price Watch, defect grading, outlet storefront) for their own outlet, even where we don't run the marketplace.

**Gate to enter a new market:** Egypt contribution margin is positive, at least 60% of brands run a second event, there is a legal opinion and an entity, and contracts are in place with a PSP, a courier and tax.

## Consequences
- **Positive:** expansion is configuration plus adapters, the money code stays untouched, and the SaaS layer can sell globally early.
- **Negative:** slightly more upfront modelling. Every feature must pass a "would this break in a second market?" review question.
- **Follow-ups:** add the `market` entity to the ERD; add a residency column to `data_inventory.yaml`; add a "global-ready" check to the PR template; add verify rows V29–V31.

## Verify register
- **V29:** KSA/UAE entity, VAT and e-invoicing obligations for a marketplace.
- **V30:** Cross-border data transfer between EG and the next market's cells (both laws).
- **V31:** Trademark availability of the brand name in EG, KSA, UAE and Morocco.
