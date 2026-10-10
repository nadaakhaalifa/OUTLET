# DPIA skeleton: Budget and affordability suite

> **Status: SKELETON, not assessed.** Facts below are taken from the master prompt and `data_inventory.yaml`. Risk ratings, residual risk, DPO opinion and sign-off are left blank on purpose: they are the DPO's and counsel's to complete. Whether the PDPL or its executive regulations require a formal DPIA for this processing, and in which form, is **VERIFY BEFORE LAUNCH**. No real personal data may be processed until ADR-0002 is accepted.

| Item | Value |
|---|---|
| Spec references | section 12, B1 |
| Purposes in inventory | budget_insights (consent `budget_insights`) |
| Controller | Z-OUTLET operating entity, not yet named. **VERIFY BEFORE LAUNCH** |
| DPO | Not yet appointed. **VERIFY BEFORE LAUNCH** |
| Assessment owner | to be assigned |
| Version | 0.1 skeleton, 2026-10-10 |

## 1. Description of the processing

- Opt-in monthly budget, payday, per-category limits, cycles, instalment commitments (from provider data or user entry) and savings goals.
- Computes remaining budget, filters feed, search and stylist, plans purchases across cycles and offers soft or hard spending caps.
- Spec rule: never shared with sellers, excluded from ads, ranking and promo targeting, enforced by a lint rule on module imports.

## 2. Data and data subjects

- **Data subjects:** Adult shoppers who opt in.
- **Inventory tables:** `budgets`, `budget_cycles`, `installment_commitments`, `savings_goals` (field-level tags are in [ropa.md](ropa.md))
- **Lawful basis (proposed):** Consent (`budget_insights`), withdrawable in one tap.
- **Recipients and processors:** see [processors-register.md](processors-register.md). All DPA statuses are unknown.
- **Residency and transfers:** see [tia-template.md](tia-template.md). No transfer is assumed lawful.

## 3. Necessity and proportionality

| Question | Answer |
|---|---|
| Is the purpose specific and documented? | Yes, see inventory purposes. |
| Is there a less intrusive way to reach it? | **To be assessed by the DPO** |
| Is data minimised (fields, volume, retention)? | See inventory tags and [retention-schedule.md](retention-schedule.md). Adequacy **to be assessed**. |
| How are data subjects informed and how do they exercise rights? | Privacy Center (spec section 2) and DSAR export, deletion, consent withdrawal. Notice text **not yet written**. |

## 4. Risks and mitigations

Likelihood, severity and residual risk are intentionally blank.

| # | Risk to individuals | Mitigation in the design | Likelihood | Severity | Residual |
|---|---|---|---|---|---|
| 1 | Financial-behaviour profile is highly sensitive and could be repurposed for targeting | Tagged P3, field-encrypted; `promotions` and `ads` may not import these tables (the inventory checker requires forbidden_importers on these tables; the import lint rule itself is not yet written). | | | |
| 2 | Disclosure to sellers, couriers or BNPL partners | seller_visibility none; BNPL commitments come from the provider or the user, nothing is sent back. | | | |
| 3 | Perceived financial advice or credit scoring | Spec rule: no credit scoring or loan recommendations (FRA); copy labelled "estimate". Counsel review of the wording (VERIFY). | | | |
| 4 | Wellbeing features misused as dark patterns | Caps are user-chosen; unlock delays are user-visible; no nudging toward higher spend from this data. | | | |
| 5 | Deletion on withdrawal not completing | Retention rule `budget_data` deletes on consent withdrawal; purge job metric required. | | | |

## 5. Open items

- [ ] Confirm the deletion deadline after withdrawal (proposed, unverified).
- [ ] Add a dependency-cruiser rule (none exists yet) proving no import path from promotions or ads reaches the budget tables.
- [ ] Confirm whether instalment data received from a provider makes that provider a joint controller (VERIFY).
- [ ] Confirm whether prior consultation with the PDPC is required (VERIFY BEFORE LAUNCH).

## 6. Opinion and sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| DPO | | | |
| Legal counsel | | | |
| Product owner | | | |
| Security lead | | | |

Review triggers: new data field, new processor, new model version, new market, any breach involving this processing.
