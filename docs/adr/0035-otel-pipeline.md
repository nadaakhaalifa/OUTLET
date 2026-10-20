# ADR-0035: OpenTelemetry pipeline (OTLP push, opt-in)

Status: Accepted (engineering default; vendor/backend choice stays with infra)

## Context
Spec T8 requires traces, metrics and logs end to end, mobile to API propagation, PII-free structured logs and the SLIs the Prometheus rules read.

## Options
1. Prometheus scrape endpoint (`prom-client`) plus separate tracing. More moving parts, a public-ish endpoint, a second metrics API.
2. OTel SDK with OTLP push to a collector (chosen). One API for traces and metrics, collector does tail sampling, Prometheus remote-write and redaction defence in depth.

## Decision
- `apps/api/src/platform/telemetry` starts `NodeSDK` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; otherwise every call is a no-op. Exporter failures never crash the process; queues are bounded.
- Sampling: parent-based, 10% of roots (`OTEL_TRACES_SAMPLER_ARG`). Spans carrying `outlet.sample.force=true` (errors) are always sampled at creation; true tail sampling on that attribute is a collector `tail_sampling` policy.
- Span attributes pass an allow-list; user ids are hashed; SQL is reduced to a fingerprint; routes are templates.
- Logs: JSON lines through `formatLogLine` with key and pattern redaction and `trace_id`/`span_id` correlation.
- Metric names are registered in one table; a CI test asserts every metric in `infra/observability/prometheus/rules` exists there.
- Existing request-context middleware owns traceparent parsing; the HTTP interceptor continues that trace instead of re-parsing.

## Consequences
- The response `traceparent` header still carries the request-context span id, not the OTel server span id (OTel cannot adopt a predefined span id). Trace id is identical; fixing needs a custom IdGenerator, deferred.
- No `/metrics` endpoint. Mobile session counter is client-reported and must be fed by an ingest endpoint (not built).
