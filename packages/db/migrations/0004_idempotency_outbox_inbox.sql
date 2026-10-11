-- migration: 0004_idempotency_outbox_inbox
-- phase: expand
--
-- HTTP idempotency store, transactional outbox and inbox (spec A2.5, A2.8,
-- docs/data-model/platform.md). packages/outbox/README.md did not exist when
-- this was written; these columns are the contract it should follow.
--
-- Delivery is at-least-once. Consumers insert (consumer, message_id) into
-- inbox_processed in the same transaction as their side effect; a duplicate
-- insert means "already handled".
--
-- Relay claim query (syntax executed in tests; SKIP LOCKED concurrency NOT verified on PGlite):
--   SELECT id FROM outbox_events WHERE published_at IS NULL
--   ORDER BY occurred_at, id LIMIT 100 FOR UPDATE SKIP LOCKED;
--
-- Partitioning (monthly) is deferred to a later expand migration, see README.

CREATE TABLE outbox_events (
  id               uuid PRIMARY KEY,  -- uuidv7 supplied by the application
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  aggregate_type   text NOT NULL CHECK (length(aggregate_type) > 0),
  aggregate_id     uuid NOT NULL,
  event_type       text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  event_version    integer NOT NULL DEFAULT 1 CHECK (event_version >= 1),
  -- events sharing an ordering_key are relayed in order (e.g. an order id)
  ordering_key     text,
  payload          jsonb NOT NULL,   -- P0-P2 only, never P3
  headers          jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at     timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_error       text
);

CREATE INDEX outbox_events_unpublished_idx
  ON outbox_events (occurred_at, id) WHERE published_at IS NULL;
CREATE INDEX outbox_events_aggregate_idx
  ON outbox_events (aggregate_type, aggregate_id);

-- Event payloads are immutable; only relay bookkeeping may change.
CREATE FUNCTION outbox_events_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NULL THEN
      RAISE EXCEPTION 'unpublished outbox events must never be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.occurred_at, NEW.aggregate_type, NEW.aggregate_id, NEW.event_type, NEW.event_version,
      NEW.ordering_key, NEW.payload, NEW.headers)
     IS DISTINCT FROM
     (OLD.id, OLD.occurred_at, OLD.aggregate_type, OLD.aggregate_id, OLD.event_type, OLD.event_version,
      OLD.ordering_key, OLD.payload, OLD.headers) THEN
    RAISE EXCEPTION 'outbox event content is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER outbox_events_guard_trg
  BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_events_guard();

CREATE TABLE inbox_processed (
  consumer      text NOT NULL CHECK (length(consumer) > 0),
  message_id    uuid NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);

CREATE INDEX inbox_processed_processed_at_idx ON inbox_processed (processed_at);

CREATE TABLE idempotency_keys (
  actor_id         uuid NOT NULL,   -- user, staff or service principal
  route            text NOT NULL CHECK (length(route) > 0),
  key              uuid NOT NULL,
  request_hash     bytea NOT NULL CHECK (length(request_hash) = 32),
  response_status  integer CHECK (response_status BETWEEN 100 AND 599),
  response_body    jsonb,           -- may hold the caller's own P2 data
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (actor_id, route, key),
  CONSTRAINT idempotency_keys_expiry_chk CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
