# Runbook index

All runbooks as of 2026-10-11. Honest status: no production environment, on-call rota or alert pipeline exists yet; runbooks are design-time procedures. Each runbook marks what is implemented in the repo versus not implemented, and tags unverifiable claims VERIFY. Severity scale is defined in `incident-response.md`.

| Runbook | Owner role | Typical severity | Trigger |
|---|---|---|---|
| [incident-response.md](incident-response.md) | Engineering lead | defines Sev1-Sev4 | Any incident; start here |
| [breach.md](breach.md) | DPO (backup CTO) | Sev1 | Suspected or confirmed personal data breach; PDPC 72 h and subject 3-day clocks |
| [ledger-integrity.md](ledger-integrity.md) | Finance engineering | Sev1 | Integrity job returns `ok: false` (trial balance, hash chain, store-credit drift) |
| [reconciliation-break.md](reconciliation-break.md) | Finance engineering | Sev3 ticket, Sev2 page | `SLOZeroBreachReconciliationUnmatchedAfter5m/24h`, nightly mismatch |
| [psp-outage.md](psp-outage.md) | Payments on-call | Sev2 (Sev1 if card and COD both affected) | Checkout success or payment confirmation fast burn, breaker open, webhook silence |
| [webhook-dlq-replay.md](webhook-dlq-replay.md) | Payments on-call | Sev2 (Sev1 if orders not placed) | Webhook or outbox dead letters, backlog |
| [stuck-reservations.md](stuck-reservations.md) | Commerce on-call | Sev2 (Sev1 in mega event) | Reservations not expiring, reserve latency SLO burn |
| [payout-failure.md](payout-failure.md) | Finance engineering | Sev2 (Sev1 wrong party or amount) | Payout stuck or failed, seller report, `seller_payable` break |
| [eta-submission-backlog.md](eta-submission-backlog.md) | Finance engineering + Tax lead | Sev3 (Sev2 systematic rejection) | Dead-lettered or aging ETA documents, reconciliation difference |
| [kill-switch-operations.md](kill-switch-operations.md) | Platform on-call | mitigation tool | Any incident that needs a capability turned off |
| [secret-rotation.md](secret-rotation.md) | Security engineering | routine; Sev1 on leak | Scheduled rotation, secret exposure, departing admin |
| [restore-drill.md](restore-drill.md) | Platform / DBA | routine | Monthly drill, backup config change; RPO 15 min, RTO 1 h |
| [mega-event-war-room.md](mega-event-war-room.md) | Head of engineering + SRE | planned event | Event or drop expected above 20x baseline |
| [degraded-mode-matrix.md](degraded-mode-matrix.md) | SRE | reference | Per-dependency degraded behaviour; not a procedure |

Related: `docs/security/threat-models/`, `docs/security/asvs-5.0-matrix.md`, `docs/sustainability/`.

## Conventions
1. Every runbook has trigger, severity, roles, steps with exact endpoint or script, verification, rollback, escalation, post-mortem checklist.
2. No step relies on editing database rows by hand; money state changes go through ledger reversing entries.
3. Money correctness over availability; never fake stock, timers or queues.
4. Anything touching personal data also opens breach.md assessment.
