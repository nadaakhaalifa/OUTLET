# ADR-0002: Data residency and cross-border transfer

- Status: **Proposed, blocked on open questions 1, 2 and 8** (do not mark Accepted without Legal/CTO sign-off)
- Date: 2026-10-10
- Deciders: Legal, DPO, CTO
- Spec refs: §B1, §T3, §T7, §T12, register rows 1, 2, 18

## Context and problem statement

Egypt's PDPL executive regulations (Decision 816/2025) require full compliance by **1 November 2026**. Personal data may leave Egypt only with a PDPC licence or authorization, an adequate level of protection and a transfer impact assessment (TIA). We must pick where the primary data plane runs. That choice drives Terraform, KMS, backups, the warehouse, the CDN, any LLM vendor and the carbon-intensity factor.

This is a legally binding, hard-to-reverse decision, so per §A4 it is the owner's to make. This ADR lays out the options and a recommended path.

## Decision drivers

- Lawfulness first: no transfer without a licence, or no transfer at all.
- Time: roughly 3 weeks to the compliance date, and licence lead time is unknown.
- Availability and cost of managed Postgres, KMS, object storage, WAF and CDN in the chosen location.
- Latency to Egyptian users.
- Ability to use external ML/LLM APIs for the stylist and fit features.
- Reversibility: moving a populated primary database later is expensive.

## Considered options

| | Option | Lawfulness | Capability | Notes |
|---|---|---|---|---|
| A | **Egypt-hosted provider** for the whole data plane | Strongest: no transfer to license | Managed-service depth is unverified (multi-AZ Postgres, KMS, PITR, WORM) | Risk of weaker SLOs and tooling |
| B | **Nearby hyperscaler region** (AWS `me-central-1` UAE or `eu-south-1`) + PDPC transfer licence + TIA | Needs licence and TIA before real data | Full managed stack | Licence lead time unknown |
| C | **Hybrid:** P2/P3 (personal and sensitive) stays in Egypt, with the catalog, search index, images and CDN global | Strong for personal data | Two data planes, higher complexity | The ledger and orders contain P2/P3 and sit with it, so the money path is in Egypt too |

## Decision (recommended, pending sign-off)

**Start with Option C's data-classification model, deployed so that Option A or B can be chosen per data class without code changes.**

Concretely, independent of which option is approved:

1. **Classification drives placement.** Every column is tagged P0–P3 in `data_inventory.yaml` (CI fails on untagged columns). Placement policy is expressed against those tags.
2. **Region is configuration.** Terraform modules take `data_region` and `edge_region` as inputs. No code hardcodes a region.
3. **Dev and staging use synthetic data only** (§T7), so engineering can proceed before this ADR is accepted. No real personal data is loaded anywhere, including TestFlight, until the ADR is accepted.
4. **External LLM/ML APIs receive no P2/P3** unless `cross_border_ml` consent *and* a transfer licence exist. The `llm-gateway` enforces this with a PII scrubber and an allow-list of fields (§T12).
5. **Transfer register.** Every processor outside the approved region (SMS, email, analytics, crawler proxy, LLM vendor, PSP) is recorded with its TIA and DPA in `docs/privacy/`.
6. **Warehouse residency follows the same rule.** Analytics events carry pseudonymous IDs and no P3 fields.
7. **Backups and DR** stay inside the same legal boundary as the primary. RPO ≤ 15 min and RTO ≤ 1 h must hold there.

## Consequences

**Good**
- Engineering is unblocked without taking a legal position on transfers.
- The choice is reversible per data class, because placement is policy and not code.

**Bad / risks**
- Two-plane operation (Option C) increases complexity, so it is only adopted if counsel confirms that a transfer licence is not obtainable in time.
- If neither A nor B is lawful by 1 Nov 2026, launch slips. The spec says launch must not precede compliance.

## Needed to finalize

Answers to open questions 1, 2 and 8, plus register row 1 (PDPC category/fees) and row 18 (grid carbon intensity for the chosen region).
