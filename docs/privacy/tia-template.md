# Transfer impact assessment (TIA) template

> **Status: TEMPLATE, nothing assessed.** One copy per recipient that processes personal data outside the approved region (see ADR-0002). The transfer requirements (PDPC licence or authorization, adequacy, TIA) come from spec B1 and are **VERIFY BEFORE LAUNCH**: the exact legal test, the form and the filing process are not confirmed. Do not rely on this template as legal advice.

## Rule of thumb from ADR-0002

- P2 and P3 data stay inside the approved region unless a licence exists and the assessment below is complete.
- External LLM and ML APIs receive no P2 or P3 data unless the `cross_border_ml` consent and a licence both exist.
- Backups, replicas, logs and the warehouse count as transfers.

## 1. Identification

| Field | Value |
|---|---|
| Processor id (from processors-register) | |
| Legal entity and country | |
| Role (processor, independent controller, joint controller) | |
| Service and reason for the transfer | |
| Inventory tables and fields transferred | list `table.field` from ropa.md |
| Highest PII class | P0 / P1 / P2 / P3 |
| Data subjects and approximate volume | |
| Frequency and mechanism (API, batch, replication) | |
| Onward transfers and sub-processors | |
| Related ADR, DPIA and DPA | |

## 2. Legal basis for the transfer

| Question | Answer | Evidence |
|---|---|---|
| Is a PDPC licence or authorization required? | **VERIFY** | |
| Licence reference and validity | | |
| Does the destination provide an adequate level of protection? | **VERIFY** | |
| Which transfer instrument applies (licence, contract clauses, other)? | **VERIFY** | |
| Is data subject consent also required (`cross_border_ml`)? | | consent version |

## 3. Destination assessment

| Topic | Finding | Source and date |
|---|---|---|
| Government or public-authority access powers | | |
| Data protection law and an independent regulator | | |
| Enforceable rights and remedies for data subjects | | |
| Practical track record of the recipient with access requests | | |
| Data localisation or exit risks | | |

## 4. Safeguards

| Safeguard | In place? | Notes |
|---|---|---|
| Encryption in transit and at rest, keys held in-region | | |
| Field-level encryption of P3 before transfer | | |
| Pseudonymisation or removal of direct identifiers | | |
| Minimisation to an allow-list of fields (llm-gateway for LLM vendors) | | |
| No training on our data, no retention at the vendor | | |
| Access logging and audit rights | | |
| Breach notice to us within a stated period (needed for the 72 hour PDPC clock) | | |
| Exit plan and deletion certificate | | |

## 5. Risk and decision

| Item | Value |
|---|---|
| Risk to individuals before safeguards | |
| Residual risk after safeguards | |
| Decision (approve, approve with conditions, reject, defer) | |
| Conditions and review date | |
| Assessed by, DPO sign-off, date | |

## 6. Transfer register entry

On approval add a row to the `transfer_register` table (see data inventory): processor, destination, instrument, licence reference, TIA date, next review.

## Recipients that will need a TIA if hosted or operating outside the approved region

- Primary cloud and managed data plane (depends on ADR-0002)
- CDN, WAF and edge (sees IP and request metadata of every user)
- Payment service providers and BNPL providers
- Couriers
- SMS, WhatsApp BSP, e-mail and push providers
- LLM vendor
- Product analytics and error monitoring
- KYC verifier and app attestation services
