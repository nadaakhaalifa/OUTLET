-- migration: 0033_ops_attention
-- phase: expand (new table, one worker job, one INSERT-only outbox policy)
-- Ops attention queue: the money / cancellation workers park work they cannot finish as `refund.attention`, `promotions.settle_attention` and
-- `shipment.cancel_attention` events. The `ops.attention` worker job (AttentionConsumer, @outlet/ops-attention) turns each into one row here
-- (UNIQUE (kind, ref_id): a replayed or repeated event upserts, never duplicates) and emits `ops.attention_opened`. ADR-0011:
--   * outlet_worker, job `ops.attention`: SELECT, INSERT, UPDATE (the upsert refreshes payload on a non-resolved row); inbox is already granted by 0007.
--   * outlet_app, user ctx (admin readers; the staff permission is enforced by the admin module): SELECT, plus UPDATE limited to status, acked_*, resolved_* and resolution_code.
--     No INSERT, no DELETE: only the worker creates items.
-- payload holds ids and short codes only (no names, phones, addresses, amounts); the consumer whitelists the fields.
CREATE TABLE attention_items (
  id              uuid PRIMARY KEY,
  market_id       text NOT NULL CHECK (length(market_id) > 0),
  kind            text NOT NULL CHECK (kind IN ('refund.attention', 'promotions.settle_attention', 'shipment.cancel_attention')),
  ref_type        text NOT NULL CHECK (ref_type IN ('refund', 'order_group', 'shipment', 'event')),
  ref_id          text NOT NULL CHECK (length(ref_id) > 0),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKED', 'RESOLVED')),
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  acked_by        uuid,
  acked_at        timestamptz(3),
  resolved_at     timestamptz(3),
  resolution_code text CHECK (resolution_code IN ('FIXED_MANUALLY', 'REFUNDED_OFFLINE', 'RETRIED_OK', 'NOT_AN_ISSUE', 'DUPLICATE', 'ESCALATED')),
  UNIQUE (kind, ref_id),
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL AND resolution_code IS NOT NULL)),
  CHECK (status = 'OPEN' OR acked_at IS NOT NULL OR status = 'RESOLVED')
);
CREATE INDEX attention_items_open_idx ON attention_items (market_id, created_at DESC, id DESC) WHERE status <> 'RESOLVED';

ALTER TABLE attention_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE attention_items FORCE ROW LEVEL SECURITY;
CREATE POLICY attention_items_user_isolation ON attention_items TO outlet_app
  USING (app.ctx() = 'user' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'user' AND market_id = app.current_market_id());
CREATE POLICY attention_items__worker_ops_attention ON attention_items FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'ops.attention' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'ops.attention' AND market_id = app.current_market_id());

REVOKE ALL ON attention_items FROM PUBLIC, outlet_app, outlet_auth, outlet_worker;
GRANT SELECT ON attention_items TO outlet_app;
GRANT UPDATE (status, acked_by, acked_at, resolved_at, resolution_code) ON attention_items TO outlet_app;
GRANT SELECT, INSERT, UPDATE ON attention_items TO outlet_worker;

-- ops.attention parks nothing else, but its `ops.attention_opened` event goes through the outbox in the inbox transaction (INSERT-only, like 0031).
CREATE POLICY outbox_events__worker_ops_attention ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'ops.attention' AND market_id = app.current_market_id());
