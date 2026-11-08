# Verify-before-launch register

Every item tagged with a warning sign in the specs lives here. One row per item. Nothing is treated as resolved without written evidence (counsel opinion, provider contract, primary source). Read "HAUL" in the master prompt as "Outlex" (code name Outlet NK).

Status values: open, evidence filed, accepted by owner (needs owner sign-off), closed.
Gates (from `reports/Outlet NK end to end build plan.md`): G0 end of week 6, G1 end of week 10, G2 end of week 20 (MVP feature freeze), G3 end of week 24 (beta ready), G4 end of week 30 (public launch). "Latest date" is the last gate by which the row must be resolved or explicitly accepted by the owner. Dates are planning targets set on 2026-11-07 and the owner may change them. A row marked G4 that blocks a Phase 2 or Phase 3 feature means that feature cannot ship until the row closes.

## Numbering changes

Old source files reused numbers. The register fixes this once:

| Range | Source |
|---|---|
| V1-V18 | Master prompt section P2, rows 1-18, same order |
| V19-V26 | Vision addendum section 7 |
| V27-V28 | Price Watch spec (unchanged) |
| V29-V31 | ADR-0006 (unchanged) |
| V32-V36 | Shipping spec (unchanged) |
| V37-V39 | Build-plan report's old V27-V29 (renumbered +10) |
| V40-V52 | Build-plan report's old V30-V42 (renumbered +10) |
| V53-V58 | Added by sweep of all docs (2026-11-07) |

The build-plan report and `docs/open-questions.md` were updated to match. The older build in `/Users/nadakhalifa/OUTLET` uses a different scheme (VR-nn); do not mix them.

## Register

| # | Item | Source | Owner | Blocks | Latest date | Status | Evidence link | Note |
|---|---|---|---|---|---|---|---|---|
| V1 | PDPC licence category and fees; DPO qualification; statutory DSAR deadline; penalty figures | haul-master-prompt-v3.md §P2 row 1; §B1 | Legal/DPO | Launch; privacy centre SLAs | G0 (file licences wk 1-2; granted or filed by G3) | open | |  |
| V2 | Data residency and cross-border transfer licence; LLM vendor transfer | haul-master-prompt-v3.md §P2 row 2; §B1; ADR-0002 | Legal/CTO | All infrastructure, IaC, ADR-0002 | G0 | open | |  |
| V3 | CBE: closed-loop store credit and gift cards outside e-money; aggregator collection and payout model | haul-master-prompt-v3.md §P2 row 3; §B2 | Legal/Finance | Wallet, refunds to credit, payouts, ADR-0003 | G0 | open | |  |
| V4 | Paymob split/sub-merchant, tokenization, recurring; fees; settlement T+n; wallet/InstaPay refund support per PSP | haul-master-prompt-v3.md §P2 row 4; §7, §14, §15.6 | Finance | Checkout saga, payouts, ledger accounts | G1 | open | |  |
| V5 | BNPL providers: API, minimum age (21?), refund and cancel flows, marketing rules under the FRA guide (6 Sep 2026) | haul-master-prompt-v3.md §P2 row 5; §B3 | Finance/Legal | BNPL checkout and copy | G2 | open | |  |
| V6 | ETA: own e-receipt obligation date; delegated signing for sellers; marketplace withholding or reporting; VAT on coins, vouchers, gift cards and platform-funded discounts; tax retention period | haul-master-prompt-v3.md §P2 row 6; §B4 | Tax | Tax engine, seller onboarding | G2 | open | |  |
| V7 | CPL 181/2018: Art. 9 text; refund payment deadline; 7-day cancel vs 14-day return; statutory exclusions; platform joint liability; subscription refunds | haul-master-prompt-v3.md §P2 row 7; §B5, §20.1, §22, §14 | Legal | Returns policy, price display, refunds | G2 | open | |  |
| V8 | Age of majority 21 vs 18; contracts with 18-20-year-olds; Plus age gate | haul-master-prompt-v3.md §P2 row 8; §B6 | Legal | Onboarding gates | G0 | open | |  |
| V9 | Gift card expiry limits; promotional games and mystery-box lottery rules | haul-master-prompt-v3.md §P2 row 9; §15.1, §15.5, §16 | Legal | Gift cards, rewards games, mystery drops (Phase 2) | G4 | open | |  |
| V10 | Apple: Plus via PSP (3.1.5(a)) vs IAP (3.1.1); current guideline text; US link-out fee status | haul-master-prompt-v3.md §P2 row 10; §B7 | Product/Legal | Plus on iOS (Phase 2) | G4 | open | |  |
| V11 | Bosta/Aramex API specs and COD remittance cycle | haul-master-prompt-v3.md §P2 row 11; §21 | Ops | Courier adapter | G1 | open | |  |
| V12 | COD return-to-origin baseline in Egypt (courier data) | haul-master-prompt-v3.md §P2 row 12; §20.7 | Ops/Data | COD risk rules | G2 | open | |  |
| V13 | Product-match threshold tau precision on a labelled Egyptian set (2,000 pairs) | haul-master-prompt-v3.md §P2 row 13; §9.2 | ML | Price Watch matching, VRP v1 | G2 | open | |  |
| V14 | Current Expo SDK and Hermes v1 readiness. Build plan says SDK 57+; keep open until confirmed at Phase 2 start | haul-master-prompt-v3.md §P2 row 14; §T2 | Mobile | Apps (Phase 2) | G4 | open | |  |
| V15 | Fully automatic seller suspension legality | haul-master-prompt-v3.md §P2 row 15; §9.5 | Legal | Price Watch enforcement ladder | G3 | open | |  |
| V16 | Waiting-room vendor and region | haul-master-prompt-v3.md §P2 row 16; §16 | Infra | Drop Hour admission | G2 | open | |  |
| V17 | Creator VAT threshold and payout tax | haul-master-prompt-v3.md §P2 row 17; §15.4 | Tax | Creator program (Phase 3) | G4 | open | |  |
| V18 | Grid-carbon intensity for the chosen region | haul-master-prompt-v3.md §P2 row 18; §T10 | Infra | SCI dashboards | G4 | open | |  |
| V19 | CPL 181/2018: disclosed defects vs the 30-day defect right; confirm the 30-day period | vision-addendum §7 V19; §3 | Legal | Returns policy, defect card checkbox | G0 | open | |  |
| V20 | CPA fake-discount fine ceiling (EGP 2m per Oct 2026 vs 30k-1m in the spec); competition approval rules | vision-addendum §7 V20 | Legal | Price-proof copy, campaigns | G3 | open | |  |
| V21 | Legality of shopper auctions and sealed bids | vision-addendum §7 V21; §4 items 16-17 | Legal | Live Auction Hall, sealed-bid lots (V2/V3) | G4 | open | |  |
| V22 | Gam'eya, escrow and seller cash advances: e-money / FRA status | vision-addendum §7 V22; §4 items 30, 35, 43 | Legal/Finance | Hold-until-accepted, get paid now, gam'eya (V3) | G4 | open | |  |
| V23 | Local sale of export overruns and QIZ stock; brand licence limits; grey imports | vision-addendum §7 V23 | Legal | Brand onboarding, sourcing | G1 | open | |  |
| V24 | VAT on seller plans and B2B lots; reseller KYC and tax | vision-addendum §7 V24; §4 item 48 | Tax | Seller plans, lot market | G3 | open | |  |
| V25 | Tax treatment of in-kind donations | vision-addendum §7 V25; §4 item 38 | Tax | Give Corner (V2) | G4 | open | |  |
| V26 | Courier COD refusal data; open-box-at-door support | vision-addendum §7 V26; §4 item 29 | Ops | COD rules, open-box at door (V2) | G2 | open | |  |
| V27 | Legality of monitoring seller websites with contract consent, and of residential-IP spot checks | specs/price-watch.md §Open verify items | Legal | Price Watch crawler, Seller Agreement | G3 | open | |  |
| V28 | Whether a commission surcharge as a penalty is enforceable under the Seller Agreement | specs/price-watch.md §Open verify items | Legal | Enforcement ladder, Seller Agreement | G3 | open | |  |
| V29 | KSA/UAE entity, VAT and e-invoicing obligations for a marketplace | adr/0006 §Verify | Legal/Tax | Second market (Phase 2+) | G4 | open | |  |
| V30 | Cross-border data transfer between EG and the next market's cells (both laws) | adr/0006 §Verify | Legal/DPO | Second market, cell design | G4 | open | |  |
| V31 | Trademark availability of the brand name in EG, KSA, UAE and Morocco | adr/0006 §Verify; open-questions Q6 | Owner/Legal | Brand, domain, marketing | G0 | open | |  |
| V32 | Export eligibility and exporters' register requirements for small sellers; zero-rated VAT documentation | specs/shipping-domestic-international.md §Verify | Legal/Tax | International export (Phase 2) | G4 | open | |  |
| V33 | Courier rate cards, volumetric divisor, restricted items, DAP/DDP support (Aramex, DHL, Egypt Post) | specs/shipping-domestic-international.md §Verify | Ops | Shipping pricing | G4 | open | |  |
| V34 | Destination duty, de-minimis and consumer-law rules for the first export countries | specs/shipping-domestic-international.md §Verify | Legal | International export (Phase 2) | G4 | open | |  |
| V35 | Egypt import rules (ACI, personal-use limits) for cross-border sellers | specs/shipping-domestic-international.md §Verify | Legal/Ops | Cross-border import (Phase 3) | G4 | open | |  |
| V36 | PSP support for foreign cards and multi-currency settlement; CBE rules | specs/shipping-domestic-international.md §Verify | Finance | International checkout | G4 | open | |  |
| V37 | Huawei Cloud Cairo service catalog: PostgreSQL version, pg_cron, multi-AZ, PITR, KMS, IaC support, SLA, pricing | reports/end to end build plan §Verify items | CTO | Residency spike, ADR-0002, infra | G0 | open | |  |
| V38 | Measured latency Cairo to Huawei Cairo, AWS me-central-1 and Frankfurt | reports/end to end build plan §Verify items | CTO | Residency spike, ADR-0002 | G0 | open | |  |
| V39 | Whether the PDPC treats encrypted or tokenized data abroad as a transfer; any adequacy list (UAE, EU) | reports/end to end build plan §Verify items | Counsel/DPO | ADR-0002, hybrid design | G0 | open | |  |
| V40 | PDPC licence fees above 200k records; marketing licence fee; DPO qualification; processing times; decree number 81 vs 816/2025 | reports/end to end build plan §Verify items (old V30) | Counsel/DPO | Licence filing, budget | G0 | open | | Overlaps V1 |
| V41 | Paymob split/sub-merchant and payout-from-settlement; Kashier connected-account settlement, payouts and multi-account checkout | reports/end to end build plan §Verify items (old V31) | Finance | Checkout saga, payouts | G1 | open | | Overlaps V4 |
| V42 | BNPL quote API for 'from X/month' copy; refund cascades to loan cancellation via PSP | reports/end to end build plan §Verify items (old V32) | Finance | BNPL, RefundRouter | G2 | open | | Overlaps V5 |
| V43 | Bosta webhook signing, rate limits, COD remittance cycle; Aramex API | reports/end to end build plan §Verify items (old V33) | Ops | Courier adapter | G1 | open | | Overlaps V11 |
| V44 | WhatsApp Egypt rate card from Meta; rule for the 'international' authentication sender; utility charges after 1 Oct 2026 | reports/end to end build plan §Verify items (old V34) | Marketing/Ops | OTP fallback, order messages | G3 | open | |  |
| V45 | SMS OTP providers and sender-ID rules in Egypt | reports/end to end build plan §Verify items (old V35) | CTO | Auth (OTP) | G1 | open | |  |
| V46 | Valify data residency, price, registry-backed match; any Commercial Registry lookup API | reports/end to end build plan §Verify items (old V36) | Ops/CTO | Seller KYC | G1 | open | |  |
| V47 | Typesense Arabic support (official docs); bake-off result | reports/end to end build plan §Verify items (old V37) | CTO | Search engine choice | G1 | open | |  |
| V48 | Cloudflare Business vs Enterprise pricing for Waiting Room and bot management | reports/end to end build plan §Verify items (old V38) | CTO | Drop Hour admission | G2 | open | | Related to V16 |
| V49 | Employer social insurance rate and cap; 2026 salary bands from Wuzzuf/recruiters | reports/end to end build plan §Verify items (old V39) | Founder | Hiring budget | G1 | open | |  |
| V50 | Holding-company options and costs (Delaware, ADGM, DIFC) | reports/end to end build plan §Verify items (old V40) | Counsel | Cap table, funding | G2 | open | |  |
| V51 | Ramadan 2027 and Eid al-Adha 2027 exact dates | reports/end to end build plan §Verify items (old V41) | Marketing | Calendar engine, launch timing | G1 | open | |  |
| V52 | Startup Charter certificate criteria and Law 6/2025 revenue caps | reports/end to end build plan §Verify items (old V42) | Tax adviser | Tax and incentives | G1 | open | |  |
| V53 | Free-delivery threshold basis (subtotal after item discounts, before vouchers and credit): product and legal agree | haul-master-prompt-v3.md §6 Bag rules | Product/Legal | Bag, free-delivery bar | G2 | open | | added by sweep |
| V54 | Merchant-initiated transactions and SCA/3-DS for price-drop auto-buy | haul-master-prompt-v3.md §28 item 1; vision-addendum §4 item 22 | Finance/Legal | Price-drop auto-buy (Phase 3) | G4 | open | | added by sweep |
| V55 | C2C / pre-loved resale: regulatory and tax treatment | haul-master-prompt-v3.md §28 item 8; vision-addendum §3 (Pre-owned) | Legal/Tax | Pre-loved resale (Phase 3) | G4 | open | | added by sweep |
| V56 | Pantry and near-expiry: NFSA requirements, expiry display, return exclusions; cosmetics rules; electronics warranty terms | design/ui-reference-spec.md §7 | Legal/Ops | Pantry, Beauty and Electronics categories | G2 | open | | added by sweep |
| V57 | Use of real brand names and logos in demo images and ads only with written permission | design/ui-reference-spec.md §6; vision-addendum §5 ad rules | Marketing/Legal | Marketing, demo content | G3 | open | | added by sweep |
| V58 | AI-suggested HS code for international parcels: seller confirms; legal accuracy duty | specs/shipping-domestic-international.md §3 | Legal/Ops | International export (Phase 2) | G4 | open | | added by sweep |
| V59 | Can input VAT on PSP, BNPL and courier fees be recovered? | docs/specs/ledger-chart-of-accounts.md | Tax | Ledger fee accounts | G2 | open | | added by ledger/security docs |
| V60 | Commission base: before or after seller-funded discounts; VAT-inclusive or net price | docs/specs/ledger-chart-of-accounts.md | Owner/Tax | Commission calc, Seller Agreement (D1) | G0 | open | | added by ledger/security docs |
| V61 | VAT model: marketplace agent vs platform as deemed supplier under split model (b) | docs/specs/ledger-chart-of-accounts.md | Tax/Legal | Whole chart of accounts | G1 | open | | added by ledger/security docs |
| V62 | VAT base of goods and commission when the platform funds a discount | docs/specs/ledger-chart-of-accounts.md | Tax | Promotions, ledger | G2 | open | | added by ledger/security docs |
| V63 | COD payout under a PSP split model; does holding COD cash need a licence? | docs/specs/ledger-chart-of-accounts.md | Legal/Finance | COD, payouts | G1 | open | | added by ledger/security docs |
| V64 | VAT on cost recharges to sellers (supply or pass-through) | docs/specs/ledger-chart-of-accounts.md | Tax | Seller fees | G2 | open | | added by ledger/security docs |
| V65 | Map ASVS matrix to exact official ASVS 5.0.0 IDs; confirm API Top 10 list before pen-test scoping | docs/security/asvs-5.0-l2-matrix.md | CTO | Pen test scope | G3 | open | | added by ledger/security docs |
| V66 | Google Play payments policy for a commerce-only Plus billed through the PSP | docs/adr/0004-plus-billing-app-store.md | Product/Legal | Plus on Android (Phase 2) | G4 | open | | added by ADRs |
| V67 | Search engine licences (Typesense GPL-3.0, Meilisearch MIT/BUSL parts, OpenSearch Apache 2.0) for commercial use | docs/adr/0010-search-engine-bake-off.md | CTO/Legal | Search engine choice | G1 | open | | added by ADRs |
| V68 | Does proxying personal traffic through a global CDN/WAF (TLS termination, logs) count as a cross-border transfer? | docs/adr/0002-data-residency.md | Counsel/DPO | Edge design, residency | G1 | open | | added by ADRs |
| V69 | Egyptian product-safety rules for kids' clothing and accessories (drawstrings, small parts) | docs/adr/0009-defect-grading-and-defect-passport.md | Legal/Ops | Kids category, defect rules | G2 | open | | added by ADRs |
| V70 | PDPL lawful bases: is legitimate interest available, on what conditions (fraud, risk, price reports, search logs)? | docs/data-model.md / data_inventory.yaml | Counsel/DPO | Fraud, analytics | G1 | open | | added by data model |
| V71 | Legal retention period for tax, accounting and commercial records (model assumes 7 years) | docs/data-model.md / data_inventory.yaml | Tax/Legal | Retention jobs | G3 | open | | added by data model |
| V72 | KYC record retention after contract end; do AML rules apply? (model assumes contract + 5 years) | docs/data-model.md / data_inventory.yaml | Legal | Seller KYC | G3 | open | | added by data model |
| V73 | Which fields are sensitive personal data under PDPL (biometric KYC, financial, children) and extra conditions | docs/data-model.md / data_inventory.yaml | Counsel/DPO | KYC, budget, size profiles | G1 | open | | added by data model |
| V74 | Children's measurements in family size profiles: guardian consent and conditions | docs/data-model.md / data_inventory.yaml | Counsel/DPO | Size profiles | G2 | open | | added by data model |
| V75 | Seller identity fields CPL requires on listings; may a sole trader's name and register number be published? | docs/data-model.md / data_inventory.yaml | Legal | Listings, global plane | G2 | open | | added by data model |
| V76 | May pseudonymous first-party server events and security logs run before analytics consent? | docs/data-model.md / data_inventory.yaml | Counsel/DPO | Analytics, security logging | G1 | open | | added by data model |
| V77 | Erasure vs legal retention: may pseudonymised order and ledger rows be kept after deletion? | docs/data-model.md / data_inventory.yaml | Counsel/DPO | Privacy delete | G2 | open | | added by data model |
| V78 | Automated risk decisions (COD block, prepaid-only) and shared refusal data: lawful basis, notice, right to contest | docs/data-model.md / data_inventory.yaml | Counsel/DPO | COD risk rules | G2 | open | | added by data model |

Sweep notes: inline warnings in the master prompt were mapped to existing rows, not duplicated. Mapping: DSAR deadline and DPO fee to V1; retention tax period, gift-card VAT, ETA delegation and withholding to V6; aggregator payout and recurring-billing rules to V3/V4; BNPL age to V5; Art. 9, 7-day cancel, refund deadline, statutory exclusions and subscription refunds to V7; age of majority to V8; gift-card expiry, games and mystery box to V9; waiting-room vendor to V16; auto-suspension to V15; tau to V13; COD return-to-origin to V12; courier docs to V11; Expo/Hermes to V14; carbon data to V18; trademark of the working name to V31; Price Watch cloaking checks to V27.
