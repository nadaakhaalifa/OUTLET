# Sustainability measurement status

As of 2026-10-11. Honest summary: **nothing is measured.** There is no production environment, no real traffic and no energy or carbon data. This page is the register to update when that changes.

| Quantity | Needed for | Source (planned) | Status | Blocking item |
|---|---|---|---|---|
| E per order, per 1,000 sessions | SCI | Cloud provider carbon tool / Impact Framework estimate | Not measured | No deployed workload; no tagging |
| I grid intensity (gCO2e/kWh) | SCI | Provider or public grid data for the chosen region | Not measured | **VERIFY**: region undecided (ADR-0002 Proposed); MENA data availability unconfirmed (verify register row 18) |
| M embodied | SCI | Provider-published embodied figures | Not measured | VERIFY availability |
| R completed orders | SCI | `order_group.paid` events | Not measured | No production orders |
| R sessions | SCI | Analytics session events (consent-gated) | Not measured | No production traffic |
| Image payload per PDP | Budget (400 KB) | CI check, RUM | Not measured | CI check not implemented |
| Parcels per order, gCO2e per shipment | Logistics | Courier/hub data | Not measured | Courier contracts, hub not built (VR-11) |
| Cost per order | FinOps | Billing + order count | Not measured | No billing |
| LLM cost per generation | FinOps | llm-gateway audit (tokens, model) | Not measured | No production LLM traffic; VERIFY gateway emits tokens |

## Synthetic baseline (allowed, non-production)
Load scripts in `tooling/load/k6` can drive staging with synthetic data to produce relative figures once staging exists. Label any such figure "synthetic, non-production"; never quote externally.

## Claims policy
No carbon, "green" or "saved from waste" claims in product or marketing until: methodology page published (from sci-method.md), data sources recorded here, and counsel reviews wording against consumer-protection rules (VERIFY).

## Update log
- 2026-10-11: page created; all quantities Not measured.
