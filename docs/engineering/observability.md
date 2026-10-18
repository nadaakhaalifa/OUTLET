# Observability (spec T8)

Code: `apps/api/src/platform/telemetry/`. ADR: 0035.

## Enabling
Set `OTEL_EXPORTER_OTLP_ENDPOINT` (for example `http://otel-collector:4318`). Optional: `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER_ARG` (0..1, default 0.1), `TELEMETRY_HASH_SALT`. Unset means a full no-op.

## What is emitted
- Traces: HTTP server span per handled route (`HttpTelemetryInterceptor`, route templates), provider calls (`traceProviderCall`), jobs and the outbox relay (`traceJob`), DB queries (`kyselyTelemetryLog`, fingerprint only) and DB business processes (`traceDbProcess`, attribute `db.application_name` such as `checkout.reserve`).
- Metrics: see `INSTRUMENTS` in `metrics.ts`. OTLP names map to Prometheus names (`outlet.reserve.duration` in seconds becomes `outlet_reserve_duration_seconds_bucket`). Histogram buckets include 0.15, 0.3 and 5 for the SLO rules.
- Logs: `formatLogLine` (used by `jsonLogger`) redacts PII by key and by pattern and adds trace ids.
- Workers: `otelMetrics` writes to the meter when telemetry is on and always keeps the `worker.metric` log line.

## Wiring still to do by module owners
- Record `outlet.checkout.attempts`, `outlet.reserve.duration`, `outlet.search.duration`, `outlet.payment.confirmation.duration`, `outlet.refund.sla`, `outlet.reconciliation.unmatched_lines`, `outlet.outbox.lag`, `outlet.provider.ready` from the owning modules via `instruments()`. Names exist and are CI-checked; callers are not yet instrumented.
- Pass `kyselyTelemetryLog` as Kysely `log` in `platform/db/factory.ts`.
- Collector: tail_sampling policy on `outlet.sample.force = true`; attribute redaction processor as defence in depth.

## Rules
Adding an attribute requires adding it to `ATTRIBUTE_ALLOW_LIST`. Renaming a metric used by `infra/observability/prometheus/rules` fails `metric-registry.test.ts`.

## Dashboards (`infra/observability/dashboards/`)
`slo-overview.json`, `checkout-funnel.json`, `inventory-reserve.json`, `worker-health.json`, `outbox-lag.json`, `provider-readiness.json`. Validate with `node infra/observability/dashboards/validate.mjs`.
