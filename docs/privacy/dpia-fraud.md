# DPIA skeleton: Fraud, risk scoring and COD refusal controls

> **Status: SKELETON, not assessed.** Facts below are taken from the master prompt and `data_inventory.yaml`. Risk ratings, residual risk, DPO opinion and sign-off are left blank on purpose: they are the DPO's and counsel's to complete. Whether the PDPL or its executive regulations require a formal DPIA for this processing, and in which form, is **VERIFY BEFORE LAUNCH**. No real personal data may be processed until ADR-0002 is accepted.

| Item | Value |
|---|---|
| Spec references | section 20.7, 9.4, B1 |
| Purposes in inventory | fraud_prevention |
| Controller | Outlet NK operating entity, not yet named. **VERIFY BEFORE LAUNCH** |
| DPO | Not yet appointed. **VERIFY BEFORE LAUNCH** |
| Assessment owner | to be assigned |
| Version | 0.1 skeleton, 2026-10-10 |

## 1. Description of the processing

- Rules plus a gradient-boosted risk score over device and IP graph, phone and account age, COD refusal history, velocity, voucher patterns, address quality, order value, time of day, chargebacks and BNPL signals.
- Decisions: allow, require OTP or WhatsApp confirmation, require partial prepayment, prepaid only, limit value, block. Defaults are configurable.
- Cross-courier sharing of refusal history only where lawful; it is off until counsel confirms.

## 2. Data and data subjects

- **Data subjects:** Shoppers and visitors, including people who are not customers but share a device or address.
- **Inventory tables:** `risk_assessments`, `device_ip_graph_edges`, `cod_refusal_history`, `payment_methods`, `devices`, `otp_challenges` (field-level tags are in [ropa.md](ropa.md))
- **Lawful basis (proposed):** Legitimate interest is proposed but its availability under the PDPL is **unverified**; a contract or consent basis may not fit.
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
| 1 | Automated decisions with significant effect (block, prepaid only) without human review | Provide explanation codes, a contest path and human review for blocks (to be built). Whether the PDPL grants a right against solely automated decisions is VERIFY. | | | |
| 2 | False positives excluding legitimate shoppers | Metric: good users blocked below 0.5 percent (target, unmeasured); shadow mode before enforcement. | | | |
| 3 | Discriminatory proxies (governorate, address quality, phone prefix) | Feature review for protected or proxy attributes; fairness checks by governorate before launch. | | | |
| 4 | Device and address graph links unrelated people | Edges are hashed identifiers; shared-device handling; retention rule `fraud_signals` (24 months, proposed). | | | |
| 5 | Cross-courier data sharing without a lawful basis | Disabled by default; requires counsel approval and a data-sharing agreement. | | | |
| 6 | Excess retention of risk scores | Rolling-window purge job with a metric; period unverified. | | | |

## 5. Open items

- [ ] Obtain counsel opinion on legitimate interest and automated decisions.
- [ ] Define human review SLA and the user-facing explanation text.
- [ ] Decide whether fraud signals may be shared with PSPs or BNPL providers.
- [ ] Confirm whether prior consultation with the PDPC is required (VERIFY BEFORE LAUNCH).

## 6. Opinion and sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| DPO | | | |
| Legal counsel | | | |
| Product owner | | | |
| Security lead | | | |

Review triggers: new data field, new processor, new model version, new market, any breach involving this processing.
