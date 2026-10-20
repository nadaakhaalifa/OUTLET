-- migration: 0008_outbox_relay_and_saga
-- phase: expand
--
-- Brings outbox_events in line with packages/outbox/README.md ("Column contract")
-- and adds saga_instances. Additive only: nullable columns, no rewrites.
-- 0004's content guard already allows bookkeeping columns to change because it
-- compares only content columns; the new columns are bookkeeping.

ALTER TABLE outbox_events ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN dead_lettered_at timestamptz;

CREATE TABLE saga_instances (
  saga_id            uuid PRIMARY KEY,
  definition         text NOT NULL CHECK (length(definition) > 0),
  status             text NOT NULL CHECK (length(status) > 0),
  completed_steps    text[] NOT NULL DEFAULT ARRAY[]::text[],
  compensated_steps  text[] NOT NULL DEFAULT ARRAY[]::text[],
  failed_step        text,
  failure_reason     text,
  stuck_reason       text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER saga_instances_touch_updated_at_trg
  BEFORE UPDATE ON saga_instances
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE saga_instances ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON saga_instances TO app_user;
CREATE POLICY saga_instances_system ON saga_instances FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
