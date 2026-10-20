-- migration: 0045_ads
-- phase: expand
--
-- Sponsored products, CPC (spec 10, docs/specs/phase2/10-sponsored-products.md). Expand only:
-- nine new tables, nothing existing changes. No FK to other modules' tables except users-free
-- logical references (stores and products belong to catalog).
--
--   * Money is BIGINT piastres, VAT-EXCLUSIVE (ad spend is a B2B service, B4).
--   * ad_impressions is range partitioned by ts and carries NO user id: only a salted hash of a
--     pseudonymous session (session_hash) and a hash of the normalized query (query_hash).
--   * ad_clicks.token_jti is UNIQUE: a replayed click token is billed once. A click row is
--     written for every attempt; only `valid` rows with cost > 0 ever touch a balance.
--   * ad_balances.balance may go negative only through an explicit adjustment (refunds); click
--     billing is conditional (never below zero) and ad_daily_spend never exceeds the daily budget.
--   * No table here may hold budget, affordability or measurement data (CI: the budget module is
--     not importable from ads; the CHECK below keeps keywords free of those words as a backstop).
--   * Row level security: sellers read their own store's rows (app.store_ids); every write runs
--     as app.role = 'system' (the policy guard authorizes sellers, admins).

CREATE TABLE ad_config (
  id                                   smallint PRIMARY KEY CHECK (id = 1),
  floor_price                          bigint NOT NULL CHECK (floor_price > 0),
  slots                                smallint NOT NULL CHECK (slots BETWEEN 0 AND 4),
  pricing                              text NOT NULL CHECK (pricing IN ('gsp', 'first_price')),
  frequency_cap_per_session_day        smallint NOT NULL CHECK (frequency_cap_per_session_day BETWEEN 1 AND 100),
  click_token_ttl_ms                   integer NOT NULL CHECK (click_token_ttl_ms BETWEEN 60000 AND 86400000),
  click_dedupe_window_ms               integer NOT NULL CHECK (click_dedupe_window_ms BETWEEN 1000 AND 86400000),
  min_dwell_ms                         integer NOT NULL CHECK (min_dwell_ms BETWEEN 0 AND 10000),
  max_clicks_per_session_per_minute    smallint NOT NULL CHECK (max_clicks_per_session_per_minute BETWEEN 1 AND 100),
  max_clicks_per_campaign_session_day  smallint NOT NULL CHECK (max_clicks_per_campaign_session_day BETWEEN 1 AND 100),
  bot_score_block_bps                  integer NOT NULL CHECK (bot_score_block_bps BETWEEN 0 AND 10000),
  vat_bps                              integer NOT NULL CHECK (vat_bps BETWEEN 0 AND 10000),
  min_top_up                           bigint NOT NULL CHECK (min_top_up > 0),
  max_top_up                           bigint NOT NULL CHECK (max_top_up >= min_top_up),
  version                              integer NOT NULL DEFAULT 1,
  updated_by                           uuid,
  updated_at                           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_campaigns (
  id            uuid PRIMARY KEY,
  store_id      uuid NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  status        text NOT NULL
                  CHECK (status IN ('ACTIVE', 'PAUSED', 'PAUSED_NO_BALANCE', 'SUSPENDED', 'ENDED')),
  daily_budget  bigint NOT NULL CHECK (daily_budget > 0),
  max_cpc       bigint NOT NULL CHECK (max_cpc > 0 AND max_cpc <= daily_budget),
  keywords      jsonb NOT NULL DEFAULT '[]'::jsonb
                  CHECK (jsonb_typeof(keywords) = 'array' AND jsonb_array_length(keywords) <= 20
                         AND keywords::text !~* '(budget|afford|installment|payday|measurement|size_profile)'),
  categories    jsonb NOT NULL DEFAULT '[]'::jsonb
                  CHECK (jsonb_typeof(categories) = 'array' AND jsonb_array_length(categories) <= 20),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_campaigns_window CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX ad_campaigns_store_idx ON ad_campaigns (store_id, created_at DESC, id DESC);
CREATE INDEX ad_campaigns_active_idx ON ad_campaigns (starts_at) WHERE status = 'ACTIVE';

CREATE TABLE ad_product_bids (
  campaign_id  uuid NOT NULL REFERENCES ad_campaigns (id) ON DELETE CASCADE,
  product_id   uuid NOT NULL,
  bid          bigint NOT NULL CHECK (bid > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, product_id)
);

CREATE INDEX ad_product_bids_product_idx ON ad_product_bids (product_id);

CREATE TABLE ad_balances (
  store_id    uuid PRIMARY KEY,
  balance     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_topups (
  id              uuid PRIMARY KEY,
  store_id        uuid NOT NULL,
  net             bigint NOT NULL CHECK (net > 0),
  vat             bigint NOT NULL CHECK (vat >= 0),
  gross           bigint NOT NULL CHECK (gross = net + vat),
  status          text NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'CREDITED', 'FAILED')),
  intent_ref      text CHECK (intent_ref IS NULL OR char_length(intent_ref) <= 80),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 80),
  created_at      timestamptz NOT NULL DEFAULT now(),
  credited_at     timestamptz,
  CONSTRAINT ad_topups_credit_pair CHECK ((status = 'CREDITED') = (credited_at IS NOT NULL)),
  CONSTRAINT ad_topups_key_uq UNIQUE (store_id, idempotency_key)
);

CREATE INDEX ad_topups_store_idx ON ad_topups (store_id, created_at DESC, id DESC);

CREATE TABLE ad_daily_spend (
  campaign_id  uuid NOT NULL REFERENCES ad_campaigns (id) ON DELETE CASCADE,
  day_key      text NOT NULL CHECK (day_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  spent        bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
  PRIMARY KEY (campaign_id, day_key)
);

CREATE TABLE ad_impressions (
  id           uuid NOT NULL,
  campaign_id  uuid NOT NULL,
  store_id     uuid NOT NULL,
  product_id   uuid NOT NULL,
  position     smallint NOT NULL CHECK (position >= 0),
  query_hash   text CHECK (query_hash IS NULL OR char_length(query_hash) = 64),
  session_hash text NOT NULL CHECK (char_length(session_hash) = 64),
  ts           timestamptz NOT NULL,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE ad_impressions_default PARTITION OF ad_impressions DEFAULT;

CREATE INDEX ad_impressions_campaign_idx ON ad_impressions (campaign_id, ts);
CREATE INDEX ad_impressions_session_idx ON ad_impressions (session_hash, campaign_id, ts);
CREATE INDEX ad_impressions_store_idx ON ad_impressions (store_id, ts);

CREATE TABLE ad_clicks (
  id              uuid PRIMARY KEY,
  token_jti       text NOT NULL CHECK (char_length(token_jti) BETWEEN 8 AND 80),
  campaign_id     uuid NOT NULL,
  store_id        uuid NOT NULL,
  product_id      uuid NOT NULL,
  impression_id   uuid NOT NULL,
  session_hash    text NOT NULL CHECK (char_length(session_hash) = 64),
  valid           boolean NOT NULL,
  invalid_reason  text CHECK (invalid_reason IS NULL OR invalid_reason IN
                    ('token_expired', 'too_fast', 'duplicate_window', 'burst', 'self_click', 'bot',
                     'campaign_drain', 'budget_exhausted', 'no_balance', 'kill_switch', 'credited_back')),
  cost            bigint NOT NULL DEFAULT 0 CHECK (cost >= 0),
  day_key         text NOT NULL CHECK (day_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  ts              timestamptz NOT NULL,
  posted_entry_id text,
  posted_at       timestamptz,
  credited_back   bigint NOT NULL DEFAULT 0 CHECK (credited_back >= 0 AND credited_back <= cost),
  CONSTRAINT ad_clicks_jti_uq UNIQUE (token_jti),
  CONSTRAINT ad_clicks_valid_shape CHECK ((valid AND invalid_reason IS NULL) OR (NOT valid AND invalid_reason IS NOT NULL)),
  CONSTRAINT ad_clicks_cost_only_valid CHECK (valid OR cost = 0 OR invalid_reason = 'credited_back')
);

CREATE INDEX ad_clicks_campaign_idx ON ad_clicks (campaign_id, ts);
CREATE INDEX ad_clicks_store_idx ON ad_clicks (store_id, ts);
CREATE INDEX ad_clicks_session_idx ON ad_clicks (session_hash, ts);
CREATE INDEX ad_clicks_unposted_idx ON ad_clicks (ts, id) WHERE valid AND cost > 0 AND posted_at IS NULL;

-- Row level security -------------------------------------------------------------------
ALTER TABLE ad_config ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON ad_config TO app_user;
CREATE POLICY ad_config_system_select ON ad_config FOR SELECT USING (app_role() = 'system');
CREATE POLICY ad_config_system_insert ON ad_config FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY ad_config_system_update ON ad_config FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE ad_campaigns ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON ad_campaigns TO app_user;
CREATE POLICY ad_campaigns_select ON ad_campaigns FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY ad_campaigns_insert ON ad_campaigns FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY ad_campaigns_update ON ad_campaigns FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE ad_product_bids ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON ad_product_bids TO app_user;
CREATE POLICY ad_product_bids_select ON ad_product_bids FOR SELECT
  USING (app_role() = 'system' OR EXISTS (
    SELECT 1 FROM ad_campaigns c WHERE c.id = campaign_id AND c.store_id::text = ANY (app_store_ids())));
CREATE POLICY ad_product_bids_write ON ad_product_bids FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE ad_balances ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON ad_balances TO app_user;
CREATE POLICY ad_balances_select ON ad_balances FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY ad_balances_insert ON ad_balances FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY ad_balances_update ON ad_balances FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE ad_topups ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON ad_topups TO app_user;
CREATE POLICY ad_topups_select ON ad_topups FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY ad_topups_insert ON ad_topups FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY ad_topups_update ON ad_topups FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE ad_daily_spend ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON ad_daily_spend TO app_user;
CREATE POLICY ad_daily_spend_system ON ad_daily_spend FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE ad_impressions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON ad_impressions TO app_user;
CREATE POLICY ad_impressions_select ON ad_impressions FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY ad_impressions_insert ON ad_impressions FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE ad_clicks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON ad_clicks TO app_user;
CREATE POLICY ad_clicks_select ON ad_clicks FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY ad_clicks_insert ON ad_clicks FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY ad_clicks_update ON ad_clicks FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
