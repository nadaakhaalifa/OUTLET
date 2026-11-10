-- migration: 0040_privacy_retention_purge
-- phase: expand (indexes, grants and policies only; no column or table change)
-- Executes the retention purge of the worker job `privacy.retention` (RetentionRunner, @outlet/privacy; ADR-0016 section "Retention purge").
-- Every purge is a DELETE by the outlet_worker role under ctx `worker`, job `privacy.retention`, and ONLY for rows past the retention cutoff of the
-- rule in data_inventory.yaml (the cutoff is baked into the policy, so a bug or a wrong runner argument cannot delete a younger row), market-pinned
-- where the table has a market_id. Table -> cutoff -> inventory rule:
--   outbox_events         published_at < now() - 60 days, published rows only      outbox_60d
--   dlq_messages          resolved_at  < now() - 60 days, status replayed|discarded dlq_60d (new rule; the dlq_messages columns are retagged from dedup_90d; payload is P2)
--   inbox_processed       processed_at < now() - 60 days                           dedup_60d (was dedup_30d; the window must not be shorter than the outbox, so a replay of a published event is still deduplicated)
--   attention_items       created_at   < now() - 24 months, status RESOLVED only   ops_attention_24m
--   notification_log      created_at   < now() - 12 months, status <> queued       notification_12m
--   market_sales_daily    day          < (now() - 25 months)::date                 sales_rollup_25m
--   store_sales_daily     day          < (now() - 25 months)::date                 sales_rollup_25m
--   admin_dashboard_snapshots: NOT purged (rule dashboard_snapshot_overwrite: one row per tile, overwritten in place).
-- inbox_processed had no RLS (0007 granted SELECT, INSERT to every worker job). A table-wide DELETE grant would let any job erase dedup records, so RLS is
-- enabled and forced here: any worker job reads and writes (ctx worker, a job set), only privacy.retention deletes, and only rows older than 60 days.
-- Tables with an existing FOR ALL worker policy (dlq_messages: outbox.relay, attention_items: ops.attention, market/store_sales_daily: reporting.rollup)
-- would gain DELETE through that policy once DELETE is granted: a RESTRICTIVE FOR DELETE policy pins DELETE to `privacy.retention` for all of them.
-- No new column: data_inventory.yaml needs no new column row (inbox_processed columns are retagged dedup_60d).

CREATE INDEX outbox_events_published_idx ON outbox_events (published_at) WHERE published_at IS NOT NULL;
CREATE INDEX inbox_processed_processed_idx ON inbox_processed (processed_at);
CREATE INDEX dlq_messages_resolved_idx ON dlq_messages (resolved_at) WHERE status <> 'open';
CREATE INDEX attention_items_resolved_idx ON attention_items (created_at) WHERE status = 'RESOLVED';
CREATE INDEX notification_log_created_idx ON notification_log (created_at) WHERE status <> 'queued';

GRANT DELETE ON outbox_events, dlq_messages, inbox_processed, attention_items, notification_log, market_sales_daily, store_sales_daily TO outlet_worker;

-- outbox_events (market pin)
CREATE POLICY outbox_events__worker_privacy_retention_select ON outbox_events FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id() AND published_at < now() - interval '60 days');
CREATE POLICY outbox_events__worker_privacy_retention_delete ON outbox_events FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id() AND published_at < now() - interval '60 days');

-- dlq_messages (no market_id column)
CREATE POLICY dlq_messages__worker_privacy_retention_select ON dlq_messages FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND status IN ('replayed', 'discarded') AND resolved_at < now() - interval '60 days');
CREATE POLICY dlq_messages__worker_privacy_retention_delete ON dlq_messages FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND status IN ('replayed', 'discarded') AND resolved_at < now() - interval '60 days');
CREATE POLICY dlq_messages__worker_delete_guard ON dlq_messages AS RESTRICTIVE FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention');

-- inbox_processed (no market_id column): RLS enabled now, every worker job keeps what 0007 granted
ALTER TABLE inbox_processed ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_processed FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_processed__worker_inbox_read ON inbox_processed FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() IS NOT NULL);
CREATE POLICY inbox_processed__worker_inbox_insert ON inbox_processed FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() IS NOT NULL);
CREATE POLICY inbox_processed__worker_privacy_retention_delete ON inbox_processed FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND processed_at < now() - interval '60 days');

-- inbox_processed: consumers that legitimately run on the outlet_app pool (the audit allows outlet_app policies on this table only, named inbox_processed__app_*,
-- each pinned to ctx and to the consumer names it writes). ReleaseRequiredConsumer runs in a store context and records two consumer values. outlet_app had no
-- production grant on the table (only the test default privileges), so the grant is added here too; no DELETE, no UPDATE.
GRANT SELECT, INSERT ON inbox_processed TO outlet_app;
CREATE POLICY inbox_processed__app_store_inventory_release_select ON inbox_processed FOR SELECT TO outlet_app
  USING (app.ctx() = 'store' AND consumer IN ('inventory.release_required', 'inventory.release_required.seller_order'));
CREATE POLICY inbox_processed__app_store_inventory_release_insert ON inbox_processed FOR INSERT TO outlet_app
  WITH CHECK (app.ctx() = 'store' AND consumer IN ('inventory.release_required', 'inventory.release_required.seller_order'));
CREATE POLICY inbox_processed__worker_delete_guard ON inbox_processed AS RESTRICTIVE FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention');
CREATE POLICY outbox_events__worker_delete_guard ON outbox_events AS RESTRICTIVE FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id());

-- attention_items (market pin)
CREATE POLICY attention_items__worker_privacy_retention_select ON attention_items FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id() AND status = 'RESOLVED' AND created_at < now() - interval '24 months');
CREATE POLICY attention_items__worker_privacy_retention_delete ON attention_items FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id() AND status = 'RESOLVED' AND created_at < now() - interval '24 months');
CREATE POLICY attention_items__worker_delete_guard ON attention_items AS RESTRICTIVE FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id());

-- notification_log (market pin; queued rows are never purged)
CREATE POLICY notification_log__worker_privacy_retention_select ON notification_log FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id() AND status <> 'queued' AND created_at < now() - interval '12 months');
CREATE POLICY notification_log__worker_privacy_retention_delete ON notification_log FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id() AND status <> 'queued' AND created_at < now() - interval '12 months');
CREATE POLICY notification_log__worker_delete_guard ON notification_log AS RESTRICTIVE FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id());

-- market_sales_daily / store_sales_daily (market pin)
CREATE POLICY market_sales_daily__worker_privacy_retention_select ON market_sales_daily FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id() AND day < (now() - interval '25 months')::date);
CREATE POLICY market_sales_daily__worker_privacy_retention_delete ON market_sales_daily FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id() AND day < (now() - interval '25 months')::date);
CREATE POLICY market_sales_daily__worker_delete_guard ON market_sales_daily AS RESTRICTIVE FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id());
CREATE POLICY store_sales_daily__worker_privacy_retention_select ON store_sales_daily FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id() AND day < (now() - interval '25 months')::date);
CREATE POLICY store_sales_daily__worker_privacy_retention_delete ON store_sales_daily FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id() AND day < (now() - interval '25 months')::date);
CREATE POLICY store_sales_daily__worker_delete_guard ON store_sales_daily AS RESTRICTIVE FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.retention' AND market_id = app.current_market_id());
