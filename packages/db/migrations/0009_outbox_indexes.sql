-- migration: 0009_outbox_indexes
-- phase: expand
-- no-transaction
--
-- Indexes for the relay claim query in packages/outbox/README.md, built
-- CONCURRENTLY (outbox_events is a large table in production). The runner
-- executes this file statement by statement because CONCURRENTLY cannot run
-- inside a transaction block. A failed concurrent build leaves an INVALID
-- index: drop it and re-run (IF NOT EXISTS makes re-runs safe only after drop).

-- Relay poll index: due, unpublished, not dead-lettered.
CREATE INDEX CONCURRENTLY outbox_events_due_idx
  ON outbox_events (occurred_at, id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

-- Per-ordering-key head-of-line lookup (NOT EXISTS in the claim query).
CREATE INDEX CONCURRENTLY outbox_events_ordering_key_idx
  ON outbox_events (ordering_key, occurred_at, id)
  WHERE ordering_key IS NOT NULL AND published_at IS NULL;

