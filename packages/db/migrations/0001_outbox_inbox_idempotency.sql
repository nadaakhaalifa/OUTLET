-- migration: 0001_outbox_inbox_idempotency
-- phase: expand (additive only; no drops, renames or type changes)
-- Source: docs/data-model.md section 7.2 (platform kernel).
--
-- Delivery is at-least-once. Consumers insert (consumer, message_id) into
-- inbox_processed in the same transaction as their side effect; a conflict
-- on that key means "already handled".
--
-- PARTITIONING IS NOT IMPLEMENTED YET. The data model makes outbox_events and
-- inbox_processed monthly RANGE partitions on UUIDv7 bounds (drop after 60 days)
-- and idempotency_keys daily RANGE partitions (drop after 48 h). Until a later
-- expand migration introduces them these are plain tables with the same keys.
--
-- Deviations from the data model (all additive):
--   outbox_events.dead_lettered_at  set when the relay gives up after N attempts
--   outbox_events.last_error        last publish error (text, no payload)
--   idempotency_keys.expires_at     explicit 24 h expiry (data model: retention idempotency_24h)
--   market_id has no FK to markets yet: the markets table is not built.

CREATE TABLE outbox_events (
  id               uuid PRIMARY KEY,                       -- UUIDv7, server generated
  market_id        text NOT NULL CHECK (length(market_id) > 0),
  aggregate_type   text NOT NULL CHECK (length(aggregate_type) > 0),
  aggregate_id     uuid NOT NULL,
  event_type       text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  visibility       text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'public')),
  payload          jsonb NOT NULL,                         -- Zod-typed; never P3
  trace_id         text,
  occurred_at      timestamptz NOT NULL,
  published_at     timestamptz,
  attempts         smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error       text,
  dead_lettered_at timestamptz
);

-- Relay scan in commit order; the dead-letter predicate keeps the hot part small.
CREATE INDEX outbox_events_unpublished_idx
  ON outbox_events (id) WHERE published_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX outbox_events_aggregate_idx
  ON outbox_events (aggregate_type, aggregate_id, id);

CREATE TABLE inbox_processed (
  consumer      text NOT NULL CHECK (length(consumer) > 0),
  message_id    uuid NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);

CREATE TABLE idempotency_keys (
  key              uuid NOT NULL,
  actor_id         uuid NOT NULL,
  route            text NOT NULL CHECK (length(route) > 0),
  request_hash     bytea NOT NULL CHECK (length(request_hash) = 32),
  status           text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status  smallint CHECK (response_status BETWEEN 100 AND 599),
  response_body    jsonb,
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (key, actor_id, route)
);

CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

CREATE TABLE dlq_messages (
  id           uuid PRIMARY KEY,
  consumer     text NOT NULL,
  message_id   uuid NOT NULL,
  payload      jsonb NOT NULL,
  error        text NOT NULL,
  attempts     smallint NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replayed', 'discarded')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX dlq_messages_status_idx ON dlq_messages (status, created_at);
