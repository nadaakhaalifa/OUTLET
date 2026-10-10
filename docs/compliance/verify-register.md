# VERIFY BEFORE LAUNCH register

Source: master prompt v3 section P2 (rows VR-01 to VR-18, same order as the seed table) plus rows VR-19 to VR-24 raised from the Phase 0 research context. Read "HAUL" as "Z-OUTLET".

Rules for this file
- One row per unverified legal, regulatory or provider-specific assumption. Nothing here is a verified fact.
- Owner is a **role**, not a person, until the owner names people (open question 12).
- Evidence link is `none yet` until a written opinion, contract clause, regulator text or primary source is filed. A secondary article is not evidence. When a document is filed, put its path or URL here and change the status.
- Status values: `Open` (no work started), `In progress` (counsel or provider engaged), `Evidence filed` (awaiting sign-off), `Verified` (signed off), `Accepted risk` (owner accepted in writing; see Definition of Done, P4).
- Date is the date the row was last changed.
- No real personal data is processed while the rows that block it are open (ADR-0002 is not accepted).

| id | item | owner role | evidence link | status | blocks | date |
|---|---|---|---|---|---|---|
| VR-01 | PDPC licence category and fees; DPO qualification; statutory DSAR deadline; penalty figures | Legal / DPO | none yet (source: master prompt B1, open question 8) | Open | First processing of real personal data; DPO console go-live; breach runbook; DSAR SLA constant | 2026-10-10 |
| VR-02 | Data residency and cross-border transfer licence; LLM vendor transfer | Legal / CTO | none yet (open questions 1, 2) | Open | ADR-0002; production Terraform and KMS; backups and DR region; warehouse; llm-gateway for any P2/P3 data; any real data in TestFlight | 2026-10-10 |
| VR-03 | CBE: closed-loop store credit and gift cards are outside e-money; aggregator collection and payout model | Legal / Finance | none yet (open questions 3, 4) | Open | ADR-0003; ADR-0014; store-credit and gift-card modules (sales stay behind a kill switch, off); payouts module | 2026-10-10 |
| VR-04 | Paymob split/sub-merchant, tokenization, recurring; fees; settlement T+n | Finance | none yet (open question 5) | Open | PSP adapter implementation; Plus recurring billing; reconciliation parser; payout design | 2026-10-10 |
| VR-05 | BNPL providers: API, minimum age (21?), refund and cancel flows, marketing rules under the FRA guide dated 6 Sep 2026 | Finance / Legal | none yet | Open | BNPL checkout option; installment copy; ADR-0012 (age gates interplay) | 2026-10-10 |
| VR-06 | ETA: own e-receipt obligation date; delegated signing for sellers; marketplace withholding or reporting; VAT on coins, vouchers and gift cards; VAT base when the platform funds a discount | Tax | none yet (open question 10) | Open | tax-eta module; ledger chart of accounts VAT accounts; invoice layout; ADR-0014 (gift-card VAT point) | 2026-10-10 |
| VR-07 | CPL 181/2018: Art. 9 discount text; refund payment deadline; 7-day cancel vs 14-day return interplay; statutory exclusions; platform joint liability | Legal | none yet (open question 11) | Open | ADR-0009; ADR-0013; Returns Policy text; RefundRouter SLO; price-integrity display rules going live | 2026-10-10 |
| VR-08 | Age of majority 21 vs 18; contracts with 18-20-year-olds; Plus age gate | Legal | none yet (open question 6) | Open | ADR-0012; `age_policy` seed values; onboarding gates; ADR-0004 Plus billing | 2026-10-10 |
| VR-09 | Gift card expiry limits; promotional games and mystery-box lottery rules | Legal | none yet | Open | ADR-0014 (expiry default); Phase 2 games and drop types (mystery box) | 2026-10-10 |
| VR-10 | Apple: Plus via PSP (3.1.5(a)) vs IAP (3.1.1); current guideline text; US link-out fee status | Product / Legal | none yet (open question 7) | Open | ADR-0004; Plus entitlements split; App Store submission | 2026-10-10 |
| VR-11 | Bosta and Aramex API specs; COD remittance cycle | Ops | none yet | Open | CourierPort adapters; COD reconciliation; payout eligibility timing | 2026-10-10 |
| VR-12 | COD return-to-origin baseline in Egypt from courier data (the market figure cited in the spec is unsourced upstream) | Ops / Data | none yet | Open | COD risk-control thresholds; ADR-0011 (COD reservation window); unit-economics model | 2026-10-10 |
| VR-13 | Product-match threshold tau precision on a labeled Egyptian set (2,000 pairs) | ML | none yet | Open | Price integrity v2 (crawler and image matching); ADR-0013 evidence tiers E3 and above | 2026-10-10 |
| VR-14 | Current Expo SDK (56 vs 57) and Hermes v1 readiness | Mobile | docs/adr/0006-mobile-foundation.md (SDK 57 chosen; Hermes v1 off) | Evidence filed | Hermes v1 adoption only; not a launch blocker | 2026-10-10 |
| VR-15 | Legality of fully automatic seller suspension without prior human review | Legal | none yet | Open | Automatic suspension in the enforcement ladder (price integrity); Seller Agreement | 2026-10-10 |
| VR-16 | Waiting-room vendor and region | Infra | none yet | Open | Drop waiting room (Phase 2); ADR-0008 | 2026-10-10 |
| VR-17 | Creator VAT threshold and payout tax | Tax | none yet | Open | Creator program (Phase 3); ADR-0008 | 2026-10-10 |
| VR-18 | Grid-carbon intensity for the chosen region | Infra | none yet | Open | SCI dashboards (Phase 2); depends on ADR-0002 region | 2026-10-10 |
| VR-19 | Foreign-seller import structure: who is importer of record, customs duty and VAT on cross-border parcels, customs clearance, and returns of imported goods (Global world) | Legal / Tax / Ops | none yet | Open | Global world launch; seller agreement for foreign sellers; landed-cost display; hub consolidation | 2026-10-10 |
| VR-20 | PDPC review lead time: how long licence or registration review takes in practice, and whether the 1 Nov 2026 full-compliance date has any grace for applicants | Legal / DPO | none yet | Open | Date of first real user; ADR-0002 timeline; VR-21 | 2026-10-10 |
| VR-21 | Whether launching or running a beta before the PDPC licence is issued is tolerated, and under what conditions (filed application, DPO appointed, synthetic data only) | Legal / DPO | none yet | Open | Any TestFlight beta with real people; go-to-market date | 2026-10-10 |
| VR-22 | Marketplace collection and payout licensing model: if Z-OUTLET collects the full basket and pays sellers out, is a PSP or payment-facilitator licence needed, or must the PSP's marketplace or sub-merchant product be used (narrows VR-03 and VR-04) | Legal / Finance | none yet (open question 4) | Open | Payout adapter implementation; Seller Agreement payout clauses; ledger account design confirmation | 2026-10-10 |
| VR-23 | App Review outcome on Plus under Plan A (commerce-only perks via PSP); result of the early consultation on a TestFlight build | Product | none yet | Open | Plus launch path (Plan A or Plan B); ADR-0004 acceptance | 2026-10-10 |
| VR-24 | Z-OUTLET's own COD refusal and return-to-origin baseline, measured after launch (distinct from the courier-data baseline in VR-12); needed to tune risk controls | Ops / Data | none yet (cannot exist before launch) | Open | COD limits and deposit rules tuning; ADR-0011 review after first 8 weeks | 2026-10-10 |

## Notes
- VR-14 is the only row with filed evidence: ADR-0006 records the SDK choice. It still needs a Hermes v1 stability check before adoption.
- A row moves to `Verified` only with a signed opinion, contract clause or primary-source citation in the evidence column.
- Rows that gate a feature must also be reflected as a feature flag or kill switch that stays off until the row is `Verified` or `Accepted risk`.
