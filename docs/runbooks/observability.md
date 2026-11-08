# Runbook: observability and SLOs (E-11)

Status: the local stack in `infra/local/observability/` is **unvalidated at runtime** (Docker is not installed on the dev Mac; YAML and JSON were parse-checked only). Image tags are best-known pins; verify on first run.

## Start locally
```
cd infra/local
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml up -d
```
Apps export with `initTelemetry({ serviceName, env, exporter: "otlp" })` from `@outlet/observability` (default endpoint `http://127.0.0.1:4318`, or `OTEL_EXPORTER_OTLP_ENDPOINT`). Use `exporter: "none"` in tests.

| What | Where |
|---|---|
| Grafana (admin / grafana_local_only) | http://127.0.0.1:3000, dashboard "Z-OUTLET SLOs" (provisioned from `grafana/dashboards/slo.json`) |
| Prometheus + alert rules | http://127.0.0.1:9090 (`prometheus/rules/*.yml`) |
| Traces | Grafana, Explore, Tempo datasource |

Flow: app -> OTLP http :4318 -> otel-collector -> Tempo (traces) and a Prometheus scrape endpoint (:8889, metrics). Sentry (or self-hosted) handles crash reports and release health and is not part of this stack.

## SLOs
| SLO | Target | Instrument | Alert |
|---|---|---|---|
| Checkout success | >= 99.5% (28 d) | `checkout_success_total` / `checkout_attempts_total` | `CheckoutBurnRate*` |
| Webhook to PAID | p95 < 5 s | `webhook_to_paid_seconds` | `WebhookToPaidBurnRate*` |
| API read | p95 < 300 ms | `api_read_latency_seconds` | `ApiReadBurnRate*` |
| Reserve tx | p95 < 150 ms | `reserve_latency_seconds` | `ReserveBurnRate*` |
| Unmatched PSP lines > 3 days | 0 | `unmatched_psp_lines` gauge | `UnmatchedPspLines` |
| Crash-free sessions | >= 99.8% | Sentry release health | Sentry alert (outside this stack) |

Latency SLOs are evaluated as the share of requests under the threshold (histogram buckets at 5 s, 0.3 s, 0.15 s are fixed in `createSloMetrics`; change both together).

## Alert policy
Multi-window, multi-burn-rate (Google SRE Workbook). Burn = error ratio / budget.
- Fast: 1h AND 5m burn > 14.4 (about 2% of a 30-day budget per hour). Severity page for checkout, webhook, reserve.
- Slow: 6h AND 30m burn > 6. Severity ticket.
- `UnmatchedPspLines`: any value > 0 for 5 min pages Finance and the on-call.
Tag DB pools with `pgConnectionTag()` (`checkout.reserve`, `catalog.read`, `analytics`, ...) so slow queries map to a business process.

## Kill switches
Registry `KILL_SWITCHES` in `@outlet/flags`. `enabled=true` or no row = allowed. If the flag store is unreachable and cache is older than 60 s: money switches fail **closed** (killed), UI switches fail **open**.

| Switch | Class | Store down |
|---|---|---|
| payments.{card,apple_pay,meeza,mobile_wallet,instapay,fawry,bnpl,cod,store_credit}.enabled | money | closed |
| referrals.payouts.enabled, gift_cards.sales.enabled | money | closed |
| drops, games, stylist.llm, ranking.ml, crawlers, shipping.international (`.enabled`) | ui | open |

Engage with `FlagService.engageKillSwitch(name, actor, marketId?)`; every change is audited.

## Deploy windows
No deploys from **2 h before to 1 h after Drop Hour**. Release freeze 48 h before mega events plus a game day. Canary 5% -> 25% -> 100% with automatic rollback on an SLO burn alert.

## Error-budget policy
- Budget remaining > 50%: ship normally.
- Budget < 50% or any fast-burn page in the window: only reliability and fixes ship; release owner signs off.
- Budget exhausted (28 d): feature freeze except reliability work until it recovers.
- Every page gets a blameless postmortem within 5 business days.
