-- migration: 0028_seller_analytics
-- phase: expand
--
-- Seller analytics v1 read models (spec 19.1, docs/specs/seller-analytics.md).
-- Fed by an event source through the inbox (consumer 'seller-analytics'); idempotent by message id.
--
-- PRIVACY: `shopper_key` is a pseudonymous key used ONLY to count DISTINCT shoppers (k-anonymity >= 50,
-- repeat rate). No read path returns it. No measurement, budget or identity column exists here.
-- Store ids are LOGICAL references (stores belong to another module). Money is BIGINT piastres.
-- RLS: sellers read only their own store (app.store_ids); only the `system` role writes.

CREATE TABLE seller_analytics_facts (
  message_id        uuid PRIMARY KEY,
  store_id          uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN
                      ('store_view', 'impression', 'view', 'save', 'bag', 'checkout', 'purchase', 'return', 'search_click')),
  occurred_at       timestamptz NOT NULL,
  product_id        uuid,
  sku_id            uuid,
  shopper_key       text CHECK (shopper_key IS NULL OR char_length(shopper_key) BETWEEN 8 AND 128),
  seller_order_id   uuid,
  qty               integer CHECK (qty IS NULL OR qty BETWEEN 1 AND 1000),
  gross_minor       bigint CHECK (gross_minor IS NULL OR gross_minor >= 0),
  commission_minor  bigint CHECK (commission_minor IS NULL OR commission_minor >= 0),
  size_label        text CHECK (size_label IS NULL OR char_length(size_label) <= 16),
  reason            text CHECK (reason IS NULL OR reason IN
                      ('too_small', 'too_large', 'not_as_described', 'defective', 'changed_mind', 'late', 'wrong_item')),
  source            text CHECK (source IS NULL OR char_length(source) <= 32),
  governorate       text CHECK (governorate IS NULL OR char_length(governorate) <= 40),
  term              text CHECK (term IS NULL OR char_length(term) BETWEEN 2 AND 60),
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sa_facts_purchase_chk CHECK (kind <> 'purchase' OR
    (sku_id IS NOT NULL AND product_id IS NOT NULL AND qty IS NOT NULL AND gross_minor IS NOT NULL
     AND commission_minor IS NOT NULL AND commission_minor <= gross_minor AND seller_order_id IS NOT NULL)),
  CONSTRAINT sa_facts_return_chk CHECK (kind <> 'return' OR
    (sku_id IS NOT NULL AND product_id IS NOT NULL AND qty IS NOT NULL AND reason IS NOT NULL)),
  CONSTRAINT sa_facts_search_chk CHECK (kind <> 'search_click' OR term IS NOT NULL)
);

CREATE INDEX sa_facts_store_kind_idx ON seller_analytics_facts (store_id, kind, occurred_at);
CREATE INDEX sa_facts_store_product_idx ON seller_analytics_facts (store_id, product_id, kind) WHERE product_id IS NOT NULL;
CREATE INDEX sa_facts_store_sku_idx ON seller_analytics_facts (store_id, sku_id, kind) WHERE sku_id IS NOT NULL;

CREATE TABLE seller_analytics_stock (
  store_id       uuid NOT NULL,
  sku_id         uuid NOT NULL,
  product_id     uuid NOT NULL,
  size_label     text NOT NULL CHECK (char_length(size_label) BETWEEN 1 AND 16),
  on_hand        integer NOT NULL CHECK (on_hand >= 0),
  price_minor    bigint NOT NULL CHECK (price_minor > 0),
  listed_at      timestamptz NOT NULL,
  observed_at    timestamptz NOT NULL,
  PRIMARY KEY (store_id, sku_id)
);

CREATE TABLE seller_analytics_freshness (
  store_id         uuid PRIMARY KEY,
  last_event_at    timestamptz NOT NULL,
  last_ingest_at   timestamptz NOT NULL
);

-- RLS ----------------------------------------------------------------------------------
ALTER TABLE seller_analytics_facts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON seller_analytics_facts TO app_user;
CREATE POLICY sa_facts_select ON seller_analytics_facts FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY sa_facts_insert ON seller_analytics_facts FOR INSERT
  WITH CHECK (app_role() = 'system');

ALTER TABLE seller_analytics_stock ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON seller_analytics_stock TO app_user;
CREATE POLICY sa_stock_select ON seller_analytics_stock FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY sa_stock_insert ON seller_analytics_stock FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY sa_stock_update ON seller_analytics_stock FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE seller_analytics_freshness ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON seller_analytics_freshness TO app_user;
CREATE POLICY sa_fresh_select ON seller_analytics_freshness FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY sa_fresh_insert ON seller_analytics_freshness FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY sa_fresh_update ON seller_analytics_freshness FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
