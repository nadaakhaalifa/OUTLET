-- migration: 0011_media
-- phase: expand (new table only)
-- Source: docs/data-model.md media_assets, docs/haul-master-prompt-v3.md T5 (upload pipeline), docs/adr/0009 (defect photos).
--
-- Deviations from the ERD (simplified for the pipeline; reviewed in the report):
--   * kind/status replace owner_type/visibility/scan_status. Visibility is derived: only status = 'ready' product,
--     defect, brand_logo and storefront assets have public variants (CDN URLs); documents are never public.
--   * Platform-owned assets have store_id NULL. app.enable_store_rls uses store_id = app.current_store_id(), which is
--     never true for NULL, so the outlet_app role cannot read or write them. ADR-0011 has no privileged client: they are
--     reached only through the named exception policy media_assets__worker_platform (outlet_worker, job 'media.platform',
--     store_id IS NULL, market pin). The same job gets INSERT-only outbox_events__worker_media_platform so media.ready /
--     media.rejected / media.document_viewed commit with the row (0007's worker_emit job list is fixed).
--   * storage_key points at the private original; variants[] carries the derived public renditions
--     ([{format, width, height, key, bytes}]).
CREATE TABLE media_assets (
  id               uuid PRIMARY KEY,
  market_id        text NOT NULL,
  store_id         uuid,
  kind             text NOT NULL CHECK (kind IN ('product', 'defect', 'brand_logo', 'storefront', 'document')),
  status           text NOT NULL CHECK (status IN ('pending_scan', 'ready', 'rejected')),
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime             text NOT NULL,
  bytes            bigint NOT NULL CHECK (bytes > 0),
  width            int CHECK (width IS NULL OR width > 0),
  height           int CHECK (height IS NULL OR height > 0),
  variants         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(variants) = 'array'),
  storage_key      text NOT NULL,
  rejected_reason  text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'rejected' OR rejected_reason IS NOT NULL)
);
CREATE INDEX media_assets_store_kind_idx ON media_assets (store_id, kind, created_at DESC) WHERE store_id IS NOT NULL;
CREATE INDEX media_assets_sha256_idx ON media_assets (sha256);
CREATE INDEX media_assets_pending_idx ON media_assets (created_at) WHERE status = 'pending_scan';
SELECT app.enable_store_rls('media_assets');

-- Named exception policies (ADR-0011): platform-owned media. Never matches a store-owned row.
CREATE POLICY media_assets__worker_platform ON media_assets FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'media.platform' AND store_id IS NULL AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'media.platform' AND store_id IS NULL AND market_id = app.current_market_id());
CREATE POLICY outbox_events__worker_media_platform ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'media.platform' AND market_id = app.current_market_id());
GRANT SELECT, INSERT, UPDATE ON media_assets TO outlet_worker;
