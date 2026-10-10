# DPIA skeleton: Size and fit models

> **Status: SKELETON, not assessed.** Facts below are taken from the master prompt and `data_inventory.yaml`. Risk ratings, residual risk, DPO opinion and sign-off are left blank on purpose: they are the DPO's and counsel's to complete. Whether the PDPL or its executive regulations require a formal DPIA for this processing, and in which form, is **VERIFY BEFORE LAUNCH**. No real personal data may be processed until ADR-0002 is accepted.

| Item | Value |
|---|---|
| Spec references | section 10, B1 |
| Purposes in inventory | fit_sizing (consent `measurements`) |
| Controller | Outlet NK operating entity, not yet named. **VERIFY BEFORE LAUNCH** |
| DPO | Not yet appointed. **VERIFY BEFORE LAUNCH** |
| Assessment owner | to be assigned |
| Version | 0.1 skeleton, 2026-10-10 |

## 1. Description of the processing

- Four layers: seller size charts, item "runs small or large" flags (Beta-Binomial, n >= 20), a per-user latent size via a hierarchical Bayesian model, and brand-level bias learned from returns.
- Inputs: body measurements (P3), fit preference, purchase and return history, fit feedback. Output: size, confidence, explanation, alternatives.
- Phase 3 adds photo-based estimation on device where possible. Photos are never stored without explicit consent.

## 2. Data and data subjects

- **Data subjects:** Adult shoppers and the people they create profiles for (partner, children). Children profiles hold a nickname and measurements only, never DOB or photo.
- **Inventory tables:** `size_profiles`, `size_charts`, `fit_feedback`, `fit_model_params`, `seller_size_demand_agg`, `body_scan_capture`, `size_alerts` (field-level tags are in [ropa.md](ropa.md))
- **Lawful basis (proposed):** Consent (`measurements`) for P3 measurements. Contract may cover size advice from non-body data (VERIFY).
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
| 1 | Body measurements are P3 and could reveal health or body characteristics | Field-encrypted, in-country residency, never visible to sellers; sellers see only aggregates with k >= 50. | | | |
| 2 | Re-identification through small-k aggregates | k >= 50 floor enforced in `seller_size_demand_agg`; suppression and tests required. | | | |
| 3 | Third-party and child data entered by the account holder | Profiles live under the adult account; no DOB or photo for children; counsel to confirm the guardian-consent position (VERIFY). | | | |
| 4 | Photo-based estimation retaining images | Processed on device; `body_scan_capture` is device-only and not persisted. Server upload would need a new inventory entry and DPIA update. | | | |
| 5 | Model transfer of user latent size across brands without a clear purpose | fit_model_params keyed by user, item or brand; erasure of user-keyed rows on consent withdrawal. | | | |
| 6 | Inaccurate recommendations driving returns or exclusion | Confidence below 0.6 shows "not sure"; calibration metric ECE below 0.05 (target, unmeasured). | | | |

## 5. Open items

- [ ] Confirm whether measurements count as health data under the PDPL (VERIFY).
- [ ] Decide how user-keyed fit parameters are deleted when the measurements consent is withdrawn.
- [ ] Validate the k >= 50 threshold against the real seller population.
- [ ] Confirm whether prior consultation with the PDPC is required (VERIFY BEFORE LAUNCH).

## 6. Opinion and sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| DPO | | | |
| Legal counsel | | | |
| Product owner | | | |
| Security lead | | | |

Review triggers: new data field, new processor, new model version, new market, any breach involving this processing.
