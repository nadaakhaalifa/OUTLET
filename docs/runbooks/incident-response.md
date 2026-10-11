# Runbook: incident response

Owner: Engineering lead. Status: draft; the on-call rota, tools and names do not exist yet (pre-backend). Numbers below are proposals to be tuned after launch data.

## Severity matrix

| Sev | Definition (any one) | Examples | Response | Update cadence | Comms |
|---|---|---|---|---|---|
| Sev1 | Money, personal data or all shoppers affected; checkout down; security incident | Checkout success under SLO and burning fast; double charging; ledger imbalance; suspected breach | Page now, ack in 5 min, incident commander assigned, all-hands | every 30 min | Status page, support macro, DPO if personal data (breach.md) |
| Sev2 | Major feature degraded or a large cohort affected, workaround exists | One PSP down with others working; search on Postgres fallback; courier API queueing | Page, ack in 15 min | every 60 min | Support macro, status banner if shopper-visible |
| Sev3 | Minor degradation, no money or data risk | Slow-burn latency alert; one seller feed failing; dashboard gap | Ticket, same business day | daily | none |
| Sev4 | Cosmetic or internal | Typo, non-blocking tooling issue | Backlog | none | none |

Escalate one level when: duration exceeds twice the response target, the cause is unknown after 30 min, or money or personal data is suspected. Any suspicion of personal data exposure is Sev1 and starts breach.md in parallel.

## Roles

- **Incident commander (IC):** owns the response, decides, delegates; does not debug.
- **Operations lead:** hands on keyboard; executes mitigations.
- **Communications lead:** status updates, support and, with the DPO, regulators.
- **Scribe:** timeline in the incident channel.
- **DPO:** consulted on any personal data involvement.

## On-call

- Primary and secondary, weekly rota, handover with a written summary. A named deputy for the DPO.
- Pages come only from generated SLO alerts (`severity: page`) and a small set of security and infrastructure alerts. Ticket-severity alerts never page.
- Every page links to a runbook (`runbook` annotation). A page without one is a bug in the alert.
- Fatigue guard: more than 2 pages per shift outside real incidents triggers an alert review the next business day.
- Compensation, rota size and hours are an owner decision (see decisionsForOwner in the delivery report).

## Procedure

1. **Acknowledge** the page; open an incident channel and record T0.
2. **Assess** severity from the matrix. When unsure, pick the higher one.
3. **Assign** IC, operations lead, comms lead.
4. **Stabilise before diagnosing:** roll back the last release, disable the feature flag, switch to the degraded mode in degraded-mode-matrix.md, or hide the failing payment method (psp-outage.md).
5. **Communicate** on the cadence in the matrix; state facts, impact, next update time.
6. **Resolve** when the SLI is back inside objective for 30 min.
7. **Review:** blameless post-mortem within 5 business days with timeline, contributing factors, and tracked actions with owners.

## Error-budget policy link

Budget exhausted (28 d window) means a feature freeze except reliability work. A release freeze starts 48 h before mega events, with a game day. These are spec T8 rules; the freeze mechanics are an engineering lead decision.

## Dashboards and rules

Generated alert rules: `infra/observability/prometheus/rules/`. Dashboards: `infra/observability/grafana/dashboards/`. Regenerate with `node tooling/observability/generate.mjs`.
