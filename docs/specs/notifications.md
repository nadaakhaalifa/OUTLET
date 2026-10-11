# Notifications (spec section 24, P-28 core)

Status: Phase 1 wave 1, synthetic data only, in-memory adapters, fake providers, nothing deployed · Module: `apps/api/src/modules/notifications` · Migration: `0018_notifications.sql` · Data model: `docs/data-model/notifications.md` · API: `docs/api/openapi.yaml` tag `Notifications` (5 operations) · Privacy fragment: `docs/privacy/fragments/notifications.yaml`

Scope of this step: templates, preferences, consent gating, frequency caps, quiet hours, provider failover, delivery log, inbox, push-token registration, idempotent outbox consumers. No real provider (Expo push, WhatsApp BSP, SMS, email) is called; each is a port with a fake. Journeys, send-time optimisation, admin template CRUD routes and provider delivery-receipt webhooks are out of scope (listed under Deviations).

## Flow
1. A module emits a domain event (consumed by `HandleDomainEvent`) or calls `SendNotification` with `templateKey`, `userId`, `ref` (idempotency scope, e.g. an order id) and a flat `payload` of placeholder values.
2. Templates are resolved by key: the active, highest version per channel whose `valid_from` has passed. Arabic is mandatory, English is the fallback pair. The recipient locale picks the language, English falls back to Arabic when missing.
3. `(user, template key, ref)` is the idempotency identity of a request. A repeat returns the earlier request unchanged and sends nothing.
4. Per external channel (order push, whatsapp, email, sms) the pure `decideChannel` returns `send`, `defer(until)` or `suppress(reason)`. The first channel that is `send` or `defer` and has a deliverable address wins. Security and transactional messages go to exactly one external channel; marketing goes to one external channel.
5. The inbox row (`in_app`) is written for every request that is not suppressed by the user's preference (never for the `security` category such as OTP).
6. `send` dispatches to the channel's providers in priority order. `defer` stores the request as `SCHEDULED` with `scheduled_for`; `ProcessDue` releases it and re-evaluates consent, preference, caps and quiet hours at release time.
7. Every provider attempt appends a `notification_log` row. Outbox events: `notification.sent`, `notification.failed`, `notification.suppressed` (ids, channel and category only, no recipient data).
8. The shopper manages preferences (`GET/PATCH /v1/me/notification-preferences`), registers the push token (`PUT /v1/me/devices/push-token`) and reads the inbox (`GET /v1/me/notifications`, `POST /v1/me/notifications/read`).

## Rules
| # | Rule | Default (configurable) |
|---|---|---|
| N1 | Categories: `transactional`, `marketing`, `security`. Only `marketing` is consent gated and user switchable | |
| N2 | Marketing on `push`, `whatsapp`, `email` needs the matching consent purpose (`marketing_push`, `marketing_whatsapp`, `marketing_email`) from the privacy module through `ConsentPort`. SMS has no marketing purpose (ADR-0018): SMS marketing is always suppressed `NO_CONSENT` | |
| N3 | Marketing without consent on any channel still lands in the inbox (data model edge case) | |
| N4 | Frequency caps, per user and per channel, counting delivered marketing only: at most 1 per Africa/Cairo calendar day and 3 per rolling 7 Cairo days | 1 / 3, same for whatsapp and email |
| N5 | Quiet hours 23:00 to 09:00 Africa/Cairo apply to marketing on external channels. Transactional and security are exempt. A deferred message goes out at the next 09:00 Cairo; if that is after the message `expires_at` it is dropped (`SUPPRESSED`, `QUIET_HOURS`), never delayed past relevance | 23:00 / 09:00 |
| N6 | Cairo time is computed by an explicit rule (UTC+2, UTC+3 from the last Friday of April 00:00 to the last Thursday of October 24:00, Egyptian DST since 2023), not by the host tz database, so results are deterministic with the injected `Clock`. A test cross-checks the rule against `Intl` | |
| N7 | Provider failover: providers of a channel are tried in `priority` order; `unavailable` goes to the next provider. All unavailable: the request stays `SCHEDULED` and is retried with exponential backoff and deterministic jitter until `expires_at`, then `FAILED` | base 30 s, cap 1 h, TTL 24 h transactional, 24 h marketing (longer than the 10 h night), 15 min security; time critical messages pass their own `expires_at` |
| N8 | WhatsApp template rejection (provider says rejected, or the template is not `APPROVED`) falls back to the same key's SMS template for `transactional` and `security` only. Marketing is never sent by SMS and is logged `FAILED` `template_rejected` | |
| N9 | Invalid device token feedback deactivates that token and adds an `INVALID_TOKEN` suppression for push when none is left; the inbox row remains | |
| N10 | Suppression list: `UNSUBSCRIBED` and `COMPLAINT` block marketing on the channel; `BOUNCE` and `INVALID_TOKEN` block every category on the channel | |
| N11 | One tap unsubscribe: `PATCH push_marketing=false` withdraws the consent through `ConsentPort` and writes an `UNSUBSCRIBED` suppression. Setting a flag to `true` is accepted only when consent is already granted (422 `consent_required`), because consent is granted explicitly in the Privacy Center. `sms_marketing=true` is 422 `channel_not_supported` | |
| N12 | A `consent.changed` event with `granted=true` clears the `UNSUBSCRIBED` suppression for that channel | |
| N13 | Template activation requires a non-empty Arabic body; if English is present its placeholder set must equal the Arabic set; a WhatsApp template also needs a provider template id and approval `APPROVED`. A template that fails cannot be activated | |
| N14 | Payload is flat, placeholders only (`{{name}}`), every placeholder must be present, no unknown keys, values are strings of at most 200 chars or finite numbers. Control and bidi override characters are stripped, email bodies are HTML escaped. Payload must contain no P3 data and no budget amounts (payday and affordability triggers pass symbolic values only, decision I-60) | |
| N15 | Preference types (user switchable, all marketing): `PRICE_DROPS`, `BACK_IN_SIZE`, `STYLIST`, `BUDGET`, `PROMOTIONS`, `REWARDS`, `PLUS`. Non-switchable: `ORDER_UPDATES`, `REFUNDS`, `ACCOUNT_SECURITY` (422 `type_not_switchable`). Wire `type` is `TYPE` (all channels) or `TYPE.channel` (one channel); the effective value is the channel override, else the type value, else enabled | |
| N16 | Queued messages keep the template version they were rendered with: rendering happens at request time and the rendered text is stored with the version | |
| N17 | Inbox rows expire after 90 days or the message `expires_at`; the list hides expired rows | 90 d |
| N18 | Deep links are app routes only (`^/[A-Za-z0-9/_\-.]{0,198}$`, no `//`), never external URLs | |

> ADV-2 fix: the frequency cap is check-and-reserve. `FrequencyStore.reserve` runs the cap predicate and records the slot in one atomic step before dispatch (in-memory: synchronous; SQL adapter: a single conditional upsert on `notification_frequency_counters` under row lock). A slot is released on retry or failure, so only delivered marketing counts.

## Edge cases
- Duplicate trigger: unique `(user, template_key, ref)`; the second call returns `duplicate`.
- Two concurrent identical requests: the repository `insertIfAbsent` is atomic; the loser returns `duplicate`.
- Recipient deleted or contact unknown: request is rejected `recipient_unknown`, nothing stored. Queued messages for a user found missing at release are `CANCELLED`.
- Message released after consent was withdrawn: re-evaluated at release, `SUPPRESSED NO_CONSENT`.
- Quiet-hours edge: 22:59:59 sends, 23:00:00 defers, 08:59:59 defers, 09:00:00 sends. Across the DST transitions the rule above holds in local time.
- Clock at day boundary: the daily cap resets at Cairo midnight, not UTC midnight.
- Provider returns invalid token for one of several tokens: only that token is deactivated, the rest are tried.
- No external channel available (no token, no phone) for transactional: inbox only, request `SENT` without an external delivery and a `suppressed` metric `NO_ADDRESS`.
- Template missing for the user's locale: Arabic is used.
- Template missing entirely: `rejected unknown_template`, no request.

## Data
Migration `0018_notifications.sql` (expand only). Tables and PII class:
| Table | Key columns | PII | Tenancy |
|---|---|---|---|
| `notification_templates` | `(key, version, channel)` unique, partial unique active per `(key, channel)` | P0 | none (config, admin write) |
| `notification_preferences` | `(user_id, type, channel)`; channel `*` means all | P2 | user RLS |
| `notification_suppressions` | `(user_id, channel, reason)` | P2 | user RLS |
| `notification_requests` | unique `(user_id, template_key, ref)`, index `(status, scheduled_for)` | P2 | user RLS |
| `notification_log` | `(id)` with `(user_id, sent_at)` index | P2 | user RLS |
| `inbox_messages` | index `(user_id, created_at DESC, id DESC)` | P2 | user RLS |
| `notification_frequency_counters` | `(user_id, channel, day)` | P2 | user RLS |
| `notification_push_tokens` | unique `(user_id, install_id)` | P2 | user RLS |
| `channel_providers` | `(channel, provider_code)` | P1 | none |

`notification_log` is not partitioned in this step (declarative partitioning of an expand-only table with a unique key needs the partition key in the PK; deferred to the platform partitioning migration, see Deviations). Consent is owned by privacy, read through `ConsentPort`.

## API (conformant to `docs/api/openapi.yaml`)
| Operation | Method and path | Auth | Idempotent | Rate limit |
|---|---|---|---|---|
| getNotificationPreferences | `GET /v1/me/notification-preferences` | shopper, self, ETag/If-None-Match | n/a | 120/min/user |
| updateNotificationPreferences | `PATCH /v1/me/notification-preferences` | shopper, self, `If-Match` required | key optional | 60/min/user |
| registerPushToken | `PUT /v1/me/devices/push-token` (204) | shopper, self | key optional | 60/min/user |
| listInbox | `GET /v1/me/notifications?cursor&limit` | shopper, self | n/a | 120/min/user |
| markInboxRead | `POST /v1/me/notifications/read` (204) | shopper, self | key optional | 60/min/user |

Errors are Problem+JSON. `markInboxRead` is all or nothing: any id that is not the caller's, or does not exist, gives a 404 identical to a missing id and marks nothing.

## Events
Outbox out: `notification.sent`, `notification.failed`, `notification.suppressed` (`request_id`, `category`, `channel`, `reason`). Analytics out: `wishlist_alert_sent(alert_type, channel)` only, for templates flagged with an `alertType`. Consumed through `HandleDomainEvent` (inbox_processed, consumer name `notifications`): `order_group.paid`, `refund.completed`, `wishlist.alert_due`, `consent.changed`. Unknown event types are ignored (still marked processed).

## Failure handling
- Provider timeout or 5xx is modelled as `unavailable`: next provider, then retry with backoff and jitter until TTL, then `FAILED` and `notification.failed`.
- Duplicate outbox delivery: `runOnce(consumer, message_id)` makes the consumer idempotent; the send itself is also idempotent by `(user, key, ref)`.
- If the consumer body throws, the inbox mark is rolled back so the message is redelivered (real adapter: same transaction).
- Poison events (schema invalid) are counted `invalid` and not retried; the relay owns the DLQ.
- Suppressed or capped messages are recorded, never retried.

## Security and abuse
| Threat (STRIDE) | Control |
|---|---|
| Spoofing / BOLA: read or mark another user's inbox | Routes are `AuthenticatedSelf`; every query is keyed by the token subject; foreign or missing ids both return 404; RLS on `inbox_messages` |
| Tampering: client sets preference for another user, injects types | Strict Zod allow-list, subject taken from token only, transactional types rejected |
| Info disclosure: PII in logs and provider payloads | Logs carry ids and enums only; push tokens never returned, logged or echoed; payload validated flat with a no-unknown-keys rule; budget outcomes symbolic |
| Template and header injection | Templates are not user editable; values stripped of control and bidi characters; email bodies escaped; deep links are app routes only |
| Spam and consent bypass | Consent, preference, caps and quiet hours enforced server side at send and again at release; SMS marketing impossible |
| Hijack of another install's token | Tokens are keyed `(user_id, install_id)`; one user can never overwrite another user's row |
| DoS / pumping | Per-user rate limits; frequency caps; SMS per-prefix budget caps are a provider adapter concern (VERIFY BEFORE LAUNCH with the SMS contract) |
| Repudiation | Delivery log per attempt with provider code and ref; outbox events |
OWASP API mapping: API1 (BOLA) inbox/ids, API3 (property level) strict schemas, API4 (resource) limit 50 and ids max 100, API6 (business flow) caps and consent.

## Metrics
Opt-in rate, delivery rate per channel and provider, suppression reasons, quiet-hours drops, failover count, WhatsApp to SMS fallbacks, cost per message, time to deliver transactional p95 (SLI), unsubscribe rate (guardrail).

## Acceptance
- A marketing push to a user without `marketing_push` consent is never sent (inbox only).
- No more than 1 marketing push per Cairo day and 3 per rolling 7 days are delivered.
- A marketing message at 23:30 Cairo is `SCHEDULED` for 09:00 while an order shipped message is sent immediately.
- A template without an Arabic body cannot be activated.
- A WhatsApp rejection on a transactional message sends the SMS; on marketing it does not.
- The same event delivered twice sends one message.
- A user cannot read or mark another user's inbox item (404).

## Deviations and open points (reported to the integrator)
1. Data model API table names `/v1/me/notifications/preferences` and `/v1/me/inbox`; OpenAPI (authoritative here) uses `/v1/me/notification-preferences`, `/v1/me/notifications`. Implemented per OpenAPI.
2. `devices` (migration 0006) has no `push_token` column although the data model says tokens live there. Rather than alter an auth-owned table, tokens are held in `notification_push_tokens`. Reconcile when auth lands push registration.
3. Data model lists `notification_log` as partitioned and `journeys`, `journey_enrollments`, `send_time_windows`, `CRUD /v1/admin/notification-templates`, `/v1/webhooks/notifications/{provider}` and `/v1/unsubscribe/{token}`. These are not in the OpenAPI notification operations and are deferred; domain support for template activation exists without a route.
4. Preference `types[].type` carries `TYPE.channel` for per-channel choices; the OpenAPI schema types it as a free string so this is conformant but should be documented in openapi.yaml.
5. `quiet_hours` in the preferences response is read-only platform configuration (the update schema has no field for it).
6. Recipient contact (phone, email, locale) comes from a `ContactPort`; the users module adapter is not built yet (fake in this module).
7. Real `ConsentPort` adapter over the privacy module `ConsentRepository` is not possible yet because privacy exports no repository token; the integrator binds `NOTIFICATION_CONSENT`.

## Wave 2: Kysely adapters (persistence)

Adapters: `apps/api/src/modules/notifications/adapters/kysely-store.ts` (templates, requests, delivery log, frequency store, preferences, suppressions, inbox, push tokens). Raw SQL, Zod-parsed rows, one transaction per call under `app.role = system` (ADR-0020). The module still wires the in-memory adapters; the integrator swaps them behind the same ports.

Decisions
- **FrequencyStore.reserve is atomic in SQL.** `pg_advisory_xact_lock(hashtextextended('notification_frequency:<user>:<channel>'))` is taken, the trailing 7 Cairo day counters are read, `admit` runs, and the counter is incremented, all in one transaction. A row lock cannot do it because the counter row for today may not exist yet; a single conditional insert cannot, because the cap rule is the caller's `admit` callback (domain policy), not a SQL constant. `release` is a guarded decrement (never below 0).
- **Day granularity.** The table keeps one `marketing_count` per (user, channel, Cairo day). `admit` and `sentTimes` receive synthetic instants (noon UTC of each counted day), which is exact for `frequencyUsage`, the only consumer (it buckets by Cairo date key). `sentTimes(since)` includes the whole Cairo day of `since`.
- **SMS has no counter** (table CHECK excludes it; SMS has no marketing purpose, ADR-0018). `reserve` on sms returns `admit([])` and records nothing.
- **claimDue** is one statement: `SELECT ... FOR UPDATE SKIP LOCKED` in a CTE, `UPDATE` to ACCEPTED with `scheduled_for = NULL`, returned oldest first.
- **insertIfAbsent** is `INSERT ... ON CONFLICT (user_id, template_key, ref) DO NOTHING`, so concurrent duplicates create exactly one request.
- **Template activation.** The partial unique index allows one active version per (key, channel) (asserted by `migration.test.ts`), so `save` of an active version retires the previous active one in the same transaction. A future-dated `valid_from` therefore cannot be pre-staged beside a live version; scheduled rollout needs a different constraint (reported to the integrator, no migration changed).

Tests: `test/repositories.contract.test.ts` runs one contract suite against the in-memory repositories and the Kysely adapters on PGlite (migrations 0001..0011 and 0018), including a 40-way concurrent reserve that must admit exactly the cap. PGlite is one backend: the concurrency test proves the logic and the cap, not lock behaviour between real sessions; run against PostgreSQL 16 before relying on it.

## Push token ownership

A push token is active for at most one user. Registering a token that is active for another user or install deactivates that registration in the same transaction (partial unique index `notification_push_tokens_active_token_uq` on `md5(token)` where `deactivated_at is null`).
