# Architecture decision records

Status values: Accepted, Proposed (draft, awaiting owner). "Blocks" is what stops a Proposed record from being Accepted. Open question numbers are in docs/open-questions.md, VR ids in docs/compliance/verify-register.md. No ADR that touches personal data, money or law is accepted without its named owner.

| ADR | Title | Status | Blocks |
|---|---|---|---|
| [0001](0001-architecture.md) | Hexagonal modular monolith on pnpm/Turborepo | Proposed | Owner approval; open question 12 (team size) for split criteria |
| [0002](0002-data-residency.md) | Data residency and cross-border transfer | Proposed | Open questions 1, 2, 8; VR-01, VR-02, VR-20, VR-21 |
| [0003](0003-wallet-store-credit.md) | Wallet is closed-loop store credit, not e-money | Proposed | Open questions 3, 4; VR-03, VR-22 |
| [0004](0004-plus-billing-app-store.md) | Plus subscription billing under App Store rules | Proposed | Open questions 5, 6, 7; VR-04, VR-08, VR-10, VR-23 |
| [0005](0005-inventory-row-per-unit.md) | Inventory reservations: row-per-unit, SKIP LOCKED | Proposed | None external; ready for approval |
| [0006](0006-mobile-foundation.md) | Mobile foundation: Expo SDK 57, EAS, no backend | Accepted | Nothing; Hermes v1 adoption tracked in VR-14 |
| [0007](0007-certificate-pinning.md) | Certificate pinning: SPKI pinning with backup pins vs CT plus App Attest | Proposed | Not assessed here; see the file |
| [0008](0008-launch-checklist-vs-phased-features.md) | Launch checklist versus phased features (Mega Drop, creators) | Proposed | Owner decision (Founder, Product); VR-09, VR-16, VR-17 if scope is pulled forward |
| [0009](0009-refund-deadline-basis.md) | Refund deadline basis (delivery vs return receipt) | Proposed | VR-07 (Legal); open question 11 |
| [0010](0010-free-delivery-threshold-scope.md) | Free-delivery threshold per store vs one bag | Proposed | Owner decision (Product, Finance): threshold value and waiver funding |
| [0011](0011-reservation-ttl-by-payment-method.md) | Reservation TTL by payment method | Proposed | Owner approval of values; provider windows VR-04, VR-05 |
| [0012](0012-plus-age-gate.md) | Plus age gate 21 vs 18 | Proposed | VR-08 (Legal); open question 6 |
| [0013](0013-price-integrity-evidence-for-clearance-skus.md) | Price-integrity evidence for clearance SKUs without history | Proposed | Owner decision (Product, Legal); VR-07, VR-13 |
| [0014](0014-store-credit-and-gift-cards-in-phase-1.md) | Store credit and gift cards in Phase 1 vs legal status | Proposed | VR-03, VR-06, VR-09; open question 3 |
| [0015](0015-ci-provenance-and-signing.md) | CI provenance, signing and quality gates | Proposed | Owner approval; Sigstore residency question and the SLSA level claim |
| [0016](0016-environments-and-iac-layout.md) | Environments and infrastructure-as-code layout | Proposed | ADR-0002 (region and provider); orchestrator choice |
| [0017](0017-observability-stack.md) | Observability stack: OpenTelemetry with a self-hosted or managed backend | Proposed | Owner approval; ADR-0002 for telemetry residency |
| [0018](0018-vocabulary-reconciliation.md) | Authoritative vocabularies: OrderGroup states, consent purposes, price-history path, ledger owners | Proposed | Owner confirmation; SMS marketing purpose decision |
| [0019](0019-mutation-policy-and-phase-exit.md) | Mutation-testing policy (per-module floors with ratchet) and Phase 0 exit rule | Proposed | Owner confirmation |
| [0020](0020-persistence-adapters.md) | Persistence adapters on Kysely: typing approach, unit of work, RLS session | Proposed | Tech Lead confirmation |


## Convention
- File name `NNNN-short-slug.md`; header lists Status, Date, Deciders, Spec refs.
- Every Proposed ADR carries a safe default and the owner decision required, so work can continue without silently taking a legal or irreversible decision.
