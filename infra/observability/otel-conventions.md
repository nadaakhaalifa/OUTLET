# OpenTelemetry conventions (Outlet NK)

Status: proposed, implements spec T8. No service emits any of this yet (no backend exists, ADR-0006), so every name below is a contract to build to, not a description of running systems. The SLO metric names in `slos/slos.yaml` come from section 3.

## 1. Signals and transport

- Traces, metrics and logs all use OpenTelemetry SDKs and OTLP to a collector. The backend choice is ADR-0017 (Proposed).
- Resource attributes on every signal: `service.name`, `service.version`, `deployment.environment.name` (`dev`, `staging`, `prod`), `cloud.region`.
- Staging carries synthetic data only (spec T7). No signal from a non-production environment is routed to a production backend.

## 2. Business-context tags

The spec asks for business context on spans and DB connections (the Shopify connection-tagging lesson). Tag low-cardinality context on spans and metrics; keep identifiers on spans and logs only.

| Attribute | Cardinality | Where | Notes |
|---|---|---|---|
| `outlet.module` | low | span, metric, log, DB tag | Owning module, for example `checkout`, `inventory`, `payments`, `ledger` |
| `outlet.journey` | low | span, metric | One of `checkout`, `reservation`, `payments`, `api`, `search`, `mobile`, `refunds`, `reconciliation` |
| `outlet.payment_method` | low | span, metric | `card`, `cod`, `wallet`, `instapay`, `bnpl`, `fawry`, `store_credit` |
| `outlet.stock_pool` | low | span, metric | `drop` or `standard` (ADR-0011) |
| `outlet.order_id` | high | span, log only | Never a metric label |
| `outlet.reservation_id` | high | span, log only | Never a metric label |
| `outlet.psp` | low | span, metric | PSP key, never a credential |
| `enduser.pseudo_id` | high | span, log only | Pseudonymous analytics ID, never phone, email or name |

DB connection tagging: every pooled connection sets `application_name` to `outlet-<service>:<module>` and each transaction adds a SQL comment `/* module=inventory journey=reservation */`, so slow queries and lock waits are attributable to a journey in Postgres logs and `pg_stat_activity`.

Rules:

1. Metric labels must be bounded. A label that can take more than 50 values needs an ADR note.
2. Money amounts are recorded as integer minor units in attributes (`outlet.amount_minor`, `outlet.currency`), never floats. Amounts do not appear as metric labels.
3. Business tags are set once in request middleware and propagated through OTel baggage; handlers never re-derive them.

## 3. Metric contract

| Metric | Type | Labels | Used by SLO |
|---|---|---|---|
| `outlet_checkout_attempts_total` | counter | `outcome` (`placed`, `failed`, `declined_by_user`), `failure_reason`, `payment_method` | checkout-success |
| `outlet_reserve_duration_seconds` | histogram | `outcome` | reserve-latency |
| `outlet_payment_confirmation_duration_seconds` | histogram | `psp` | payment-confirmation-latency |
| `http_server_request_duration_seconds` | histogram | `http_request_method`, `http_route`, `http_response_status_code` | api-read-latency |
| `outlet_search_duration_seconds` | histogram | `backend` (`engine`, `postgres_fallback`) | search-latency |
| `outlet_mobile_sessions_total` | counter | `crashed`, `platform` | mobile-crash-free |
| `outlet_refund_sla_total` | counter | `outcome` (`met`, `missed`) | refund-initiation |
| `outlet_reconciliation_unmatched_lines` | gauge | `age_bucket` (`lt_1d`, `1d_3d`, `gt_3d`), `psp` | reconciliation-unmatched |

Histogram buckets must include the SLO thresholds exactly (0.15, 0.3, 5 seconds) because the generated rules read `le="<threshold>"`. A bucket layout without them silently breaks the SLI; the generator test suite does not check instrumentation, so add a service-side test when the metrics are implemented.

## 4. Mobile to API trace propagation

- The Expo app creates a client span per API call and sends W3C `traceparent` and `tracestate` headers. It also sends `baggage` limited to `outlet.journey` and `outlet.payment_method`.
- The API accepts inbound `traceparent` from the mobile app only on authenticated routes and treats it as untrusted: it starts a new root trace link instead of a child when the header is malformed, and it never trusts baggage for authorization.
- Sampling is decided at the API: head sampling at a base rate, with 100 percent retention for errors and for spans in the checkout, payment and reconciliation journeys (tail sampling at the collector).
- The `X-Request-Id` used by the audit log (spec section 9) is set to the trace ID so audit rows and traces join.
- Mobile telemetry initialises only after the matching consent (B1). Until a crash-reporting consent purpose is decided, mobile crash and trace export is limited to consented sessions. VERIFY BEFORE LAUNCH: whether crash reporting needs its own purpose under PDPL.
- Bodies and the raw client IP are never attached to client spans.

## 5. PII redaction at the logger

Logs are structured JSON. Redaction happens in the logger itself, before serialisation, so a developer cannot forget it at the call site.

1. **Allow-list first.** Log fields are a typed object; unknown top-level keys are dropped in production builds and flagged in tests.
2. **Deny-list by key** (case-insensitive, any depth): `phone`, `email`, `name`, `address`, `dob`, `national_id`, `card`, `pan`, `cvv`, `password`, `otp`, `token`, `authorization`, `cookie`, `set-cookie`, `iban`, `wallet`, `measurements`. Value replaced by `[REDACTED]`.
3. **Pattern scrub of free text** (messages and error strings): Egyptian mobile numbers, email addresses, 13 to 19 digit runs passing a Luhn check, 14 digit national-ID shaped numbers, bearer tokens. Replaced by a typed marker such as `[REDACTED:phone]`.
4. **Pseudonyms, not identities.** Use `enduser.pseudo_id`. Rotation follows the analytics pseudonym policy.
5. **Raw payloads** from PSPs, couriers and ETA are stored in the raw-webhook store (retention per B1), never logged; logs carry the payload hash and size.
6. **Span attributes and metric labels** go through the same redactor. The OTel collector repeats the deny-list as a second line (attributes processor), so one bug does not leak.
7. **Tests.** A fixture-driven unit test feeds known PII shapes (all synthetic) through the logger and asserts none survive. CI fails on a new log field without a classification once the data inventory exists.
8. Log retention by environment and class is set with the DPO against the B1 retention table. VERIFY BEFORE LAUNCH.

## 6. What this document does not decide

- Backend and vendor: ADR-0017.
- Data residency of telemetry: telemetry can contain P2 data by accident, so it follows the ADR-0002 region decision. Until ADR-0002 is accepted no telemetry leaves a developer machine.
