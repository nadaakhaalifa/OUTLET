# Software Carbon Intensity (SCI) method for Z-OUTLET

Status: method defined, nothing measured (2026-10-11). Spec: master prompt section T10; shopper claims are governed by T10 ("no carbon claims without a methodology page"); this page is that methodology page's source, not yet shopper-facing.

## Standard
SCI is ISO/IEC 21031:2024 (Green Software Foundation). Formula:

    SCI = ((E x I) + M) per R

- E: energy consumed by the software, kWh.
- I: carbon intensity of the electricity, gCO2e per kWh, for the grid and time where the energy was used.
- M: embodied emissions of the hardware share used, gCO2e.
- R: functional unit.

## Functional unit R
- Primary: **one completed order** (an OrderGroup that reaches `PAID` or `CONFIRMED_COD` and is not cancelled before shipping; VERIFY exact boundary with product, and whether returns are attributed back to the order).
- Browsing: **per 1,000 sessions** (sessions with no order), reported separately and never added to the per-order figure without an allocation rule.
- Shipment-level gCO2e (courier-reported or distance estimated; spec phase2/09 lists "gCO2e per shipment") is a separate boundary that is not part of software SCI; report it next to SCI, never inside it.

## Software boundary (proposed)
Included: API, workers, ML services, Postgres, Redis, search, CDN egress and storage attributable to the product, LLM inference calls, CI is excluded from the runtime figure but tracked separately. Excluded: end-user device energy (reported as an estimate only), courier transport (see above), office and staff. Boundary is a proposal; owner and sustainability reviewer to confirm.

## Allocation
Shared infrastructure energy is allocated to R by request or resource-time share: per-order = (energy of order-path services over a window) / (completed orders in the window). Browse sessions use the browse-path services. Allocation keys come from OpenTelemetry business-context tags (spec T8). Not implemented.

## What is measurable now versus not
| Item | Status |
|---|---|
| E (energy) | Not measured. No production workload exists. Cloud provider carbon tooling or Impact Framework estimates are the planned sources. VERIFY availability for the chosen region. |
| I (grid intensity) | Not measured. **VERIFY**: MENA/Egypt or chosen-region grid intensity data (verify register row 18). Residency region itself is undecided (ADR-0002 Proposed), so I cannot be fixed. Do not use a global or EU average without labelling it as a placeholder. |
| M (embodied) | Not measured. Needs provider-published embodied figures; VERIFY availability. |
| R (orders, sessions) | Countable once events exist: `order_group.paid`, session events in the analytics taxonomy. No production data yet. |
| Image payload budget | Budget defined in spec section 25 and levers checklist; weekly CI check is VERIFY (see levers-checklist.md). |
| gCO2e per shipment | Not measured; courier data and Aramex/Bosta contracts pending (verify register row 11). |

Therefore today: **no SCI value exists and none may be quoted** in product, marketing or investor material.

## Reporting rules
1. Always report E, I, M separately plus the SCI, the region, the time window and the boundary.
2. Show uncertainty; estimated inputs are labelled "estimate".
3. Marginal versus average intensity: use location-based average intensity unless the owner chooses otherwise; record the choice in an ADR. VERIFY.
4. "Saved from waste" counts (spec 28.9) are units, not carbon; do not convert to CO2e without a published method.
5. Dashboards: gCO2e per order next to cost per order (FinOps, spec T10). Not built.

## Steps to first number
1. Decide region (ADR-0002) and boundary.
2. Obtain I and M sources, record in measurement-status.md.
3. Tag workloads with business context; collect E.
4. Compute baseline per 1,000 sessions and per order on staging with synthetic load (`tooling/load/k6`), clearly labelled non-production.
5. Publish methodology page, then claims.
