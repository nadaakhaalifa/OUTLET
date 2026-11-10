-- migration: 0038_search_sync_job
-- phase: expand (one nullable column, one partial index, RLS on one public read model, two policies for one worker job)
-- Composes the `search.sync` worker job (SearchSyncConsumer, @outlet/search; ADR-0016). Findings against 0022:
--   * search_documents had NO row-level security: every worker job (and any app context) could write it. Search is still a public (P0) read model,
--     but only the sync job may write it, so RLS is now enabled and forced: outlet_app reads (user and store contexts, market-pinned), and the single
--     write path is `search.sync` (market-pinned). No other worker job or role sees or changes a row.
--   * the display decision (verified discount / lowest in 30 days) comes from @outlet/pricing-integrity, which reads price_claims: under the
--     `search.sync` context the row would be invisible, so the job would always index "plain" even when a claim exists (or index a discount a claim
--     forbids). A market-pinned SELECT policy for `search.sync` fixes that; price_events and sku_price_windows are RLS-free and already granted (0012).
--   * engine_synced_seq: the seq (source event microseconds) last mirrored to the external engine (Typesense etc., undecided, ADR-0010). NULL = never.
--     seq IS DISTINCT FROM engine_synced_seq means "the Postgres read model is ahead of the engine": staleness reports it instead of claiming fresh.
-- Grants are unchanged (0022 already gives outlet_worker SELECT, INSERT, UPDATE on search_documents and SELECT on catalog_public_listings; the
-- inbox row is granted to every worker by 0007). The consumer does not DELETE and does not emit events.

ALTER TABLE search_documents ADD COLUMN engine_synced_seq bigint CHECK (engine_synced_seq IS NULL OR engine_synced_seq >= 0);
CREATE INDEX search_documents_engine_pending_idx ON search_documents (market_id, updated_at) WHERE engine_synced_seq IS DISTINCT FROM seq;

ALTER TABLE search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_documents FORCE ROW LEVEL SECURITY;

-- Plain isolation-style name on purpose (no store_id / user_id column here, so the tenant audit does not apply): read only, market-pinned.
CREATE POLICY search_documents_user_isolation ON search_documents FOR SELECT TO outlet_app
  USING (app.ctx() IN ('user', 'store') AND market_id = app.current_market_id());
CREATE POLICY search_documents__worker_search_sync ON search_documents FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'search.sync' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'search.sync' AND market_id = app.current_market_id());

CREATE POLICY price_claims__worker_search_sync ON price_claims FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'search.sync' AND market_id = app.current_market_id());
