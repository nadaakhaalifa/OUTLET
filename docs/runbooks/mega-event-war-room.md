# Runbook: mega-event war room (drops, White Friday, 11.11, Ramadan, Eid)

Owner: Head of engineering (commander) with SRE. Roles: incident commander, SRE, payments lead, inventory/DB lead, support lead, product owner, comms. Severity: the event is planned, not an incident; incidents inside it follow incident-response.md and are treated one level higher (VERIFY policy with owner).

## Trigger
Any scheduled event or drop with expected traffic above 20x baseline (spec T9), or a Phase 2 drop (`docs/specs/phase2/07-drops-waiting-room.md`).

## Honest status (2026-10-11)
- k6 scripts exist: `tooling/load/k6/{drop-50k,checkout-mix,reserve-p95,search-p95,webhook-replay}.js` and `tooling/load/seed.mjs`, `simulate.mjs`. No results from a real environment exist; `tooling/load/chaos/` is empty. A 20x test, a drop simulation and a game day have NOT been run.
- A waiting-room vendor is not chosen (verify register row 16) and no production Redis queue has been exercised.
- SLO rule generation exists in `tooling/observability` (`generate.mjs`, `validate-rules.mjs`); a live Prometheus/Grafana is not confirmed. Scheduled pre-scaling is not implemented.
- The Admin "war room" dashboard (spec section 23) is not confirmed built.

## T-14 to T-2 days
1. Run k6 at 20x against staging with synthetic data: `tooling/load/seed.mjs` then each script in `tooling/load/k6`, with `BASE_URL`, `VUS` env as the scripts read. Record p95 reserve < 150 ms, checkout success >= 99.5%, search p95 < 150 ms (T8 SLOs).
2. Post-run end-state checks: zero oversell, claimed units <= stock (drop-50k header comment).
3. Postgres concurrency proof on real PG16: `tooling/db/inventory-concurrency.sh` and `tooling/db/run-on-postgres16.sh`.
4. Restore drill within 30 days (restore-drill.md). Ledger integrity green (ledger-integrity.md).
5. Verify each kill switch works (kill-switch-operations.md) and the degraded-mode matrix chaos entries have run.
6. Contracts: PSP rate limits, courier capacity, SMS budgets (SMS pumping caps). VERIFY with each vendor.

## T-48 h
Release freeze (spec T8). Only reliability fixes. Pre-scale compute, PgBouncer pool, Redis; confirm checkout pool isolated from analytics.

## During the event
- Roles seated, one channel, one scribe. Dashboards: checkout success, payment confirmation latency, reserve p95, stuck reservations, PSP health, queue depth, stock-outs.
- Cadence: 15 min status; page on SLO fast-burn.
- Playbooks by symptom: PSP fault -> psp-outage.md; reservations pile up -> stuck-reservations.md; webhook backlog -> webhook-dlq-replay.md; Redis down -> drops paused fail-closed, `kill.drops`; LLM cost spike -> `kill.stylist_llm`; fraud/gift cards -> `kill.gift_card_sales`, COD limits are owner decisions.
- Never fake stock, queues or timers (spec A2.13). Never widen COD automatically.

## Verification (end)
- Zero oversell reconciliation, ledger trial balance 0, PSP settlement matches (reconciliation-break.md), refunds for expired-reservation payments done (alert if > 0.1%, spec section 7).

## Rollback
Disable `kill.drops`-related path by turning drops off, return to normal checkout, scale down on schedule (not immediately).

## Escalation
Commander -> owner for revenue-affecting switches over 1 h -> counsel for consumer-law complaints.

## Post-mortem checklist
- SLO and error-budget impact, peak RPS, peak queue depth, oversell count.
- Which rehearsal was missing (real result versus plan).
- Cost per order and gCO2e per order for the event if measured (sustainability/measurement-status.md; not measured yet).
- Blameless review within 5 business days.
