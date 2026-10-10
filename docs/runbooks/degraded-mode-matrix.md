# Degraded-mode matrix

Spec T9 asks for one documented degraded mode per dependency. Behaviour below is the design target; none of it is implemented yet. Each mode needs a chaos test before launch (spec T9).

| Dependency | Failure | Detection | Degraded behaviour (shopper-visible) | What must not happen | Recovery | Owner runbook |
|---|---|---|---|---|---|---|
| PSP (card, wallet, BNPL) | Errors, timeouts, outage | Circuit breaker open, `outlet_checkout_attempts_total{outcome="failed"}` burn, webhook gap | Fail over to a second PSP only if one is contracted (VERIFY: none yet); otherwise hide the failing method in checkout with an Arabic/English explanation, keep COD and other methods | Silently retrying a charge without an idempotency key; showing a method that will fail; creating orders marked paid without confirmation | Breaker half-open probes, then restore method; reconcile every in-flight payment | psp-outage.md |
| Search engine | Down or slow | `outlet_search_duration_seconds` burn, engine health | Fall back to Postgres query (filters and keyword, no ranking personalisation, no typo tolerance), banner-free; browse and category pages unaffected | Returning stale results as if fresh; timing out the whole home screen | Re-enable engine, run reindex diff job | this file |
| Redis | Down | Connection errors, waiting-room health | Waiting room **fails closed**: drops are paused with an honest "not open right now" state, no fake queue or timer. Normal checkout continues; rate limits fall back to a conservative in-process limit | Letting a drop open without the waiting room; losing idempotency keys silently; inventory state in Redis being the source of truth | Restart, rebuild cache, resume drops manually after capacity check | this file |
| Courier API | Down, errors | Adapter breaker, shipment-create failures | Orders accepted normally; shipment creation queued in the outbox with retries; delivery estimate shows the wider range | Cancelling paid orders; losing the pickup request; promising a date that cannot be met | Drain the queue in order, confirm with the courier, compare counts | this file |
| LLM provider | Down, slow or over budget | `llm-gateway` breaker, per-feature budget alert | Stylist uses rule-based recommendations; NL search parsing falls back to plain keyword; support suggestions disabled; no spinner longer than 2 s | Sending P2/P3 data to a fallback provider outside the approved region; showing model errors to the shopper | Close breaker; evals unchanged | this file |
| SMS/OTP provider | Down | OTP send failures | Offer alternate sign-in (Apple, Google, passkey); queue non-urgent SMS | Disabling OTP verification; unlimited resend | Provider recovery; replay is not allowed for expired OTPs | this file |
| Postgres primary | Down | Health, replication lag | Read replica serves catalog reads (cached, labelled stale only in ops view); writes and checkout fail with a retry message; no partial orders | Promoting a replica with data loss unnoticed (RPO 15 min) | Failover per restore-drill.md; run integrity job | restore-drill.md |

## Rules for every degraded mode

1. The mode is explicit: a feature flag or breaker state visible on the ops dashboard, not an accident of timeouts.
2. Honesty: no fabricated stock, queues, timers or discounts when degraded (spec A2.13).
3. Money correctness over availability: when in doubt, refuse the order, never double charge.
4. Entering and leaving the mode is logged and measured; time spent degraded is a dashboard panel.
5. Each mode has a chaos test in the T9 suite and a game-day entry.

## Open items

- VERIFY: second PSP availability and failover feasibility before promising failover.
- Postgres topology depends on ADR-0001 and ADR-0002 outcomes.
