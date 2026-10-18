-- migration: 0076_affiliate_attribution_commissions
-- phase: expand
--
-- Creators and affiliates, part 2: clicks, attribution and commissions.
--
--   * affiliate_clicks: range partitioned monthly by ts (explicit partitions for the launch
--     quarter plus a DEFAULT, a partition job adds the rest). Pseudonymous: a device hash and an
--     IP hash, never a user id, address or raw identifier. `counted` is false once the per-IP
--     hourly cap is reached; `attributable` is false for bots and headless agents.
--   * attributions: one per order group (PRIMARY KEY), so a second creator can never take the same
--     order. The rate table is snapshotted as JSON at attribution time.
--   * commissions: one row per (order_line_id, creator_id), the idempotency key of the accrual.
--     Money is bigint piastres. clawed_back never exceeds amount. ACCRUING rows are held (cap,
--     suspended creator) and have no ledger intent. Ledger intents live in commission_postings.
--   * creator_monthly_accruals: the atomic counter behind the monthly accrual cap.
--   * payout_id is added in 0077 once creator_payouts exists.

CREATE TABLE affiliate_clicks (
  id            uuid NOT NULL,
  link_id       uuid NOT NULL,
  creator_id    uuid NOT NULL,
  ts            timestamptz NOT NULL,
  device_hash   text NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  ip_hash       text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  ua_class      text NOT NULL CHECK (ua_class IN ('app', 'browser', 'bot', 'headless')),
  counted       boolean NOT NULL,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE affiliate_clicks_default PARTITION OF affiliate_clicks DEFAULT;
CREATE TABLE affiliate_clicks_2026_10 PARTITION OF affiliate_clicks
  FOR VALUES FROM ('2026-10-01T00:00:00Z') TO ('2026-11-01T00:00:00Z');
CREATE TABLE affiliate_clicks_2026_11 PARTITION OF affiliate_clicks
  FOR VALUES FROM ('2026-11-01T00:00:00Z') TO ('2026-12-01T00:00:00Z');
CREATE TABLE affiliate_clicks_2026_12 PARTITION OF affiliate_clicks
  FOR VALUES FROM ('2026-12-01T00:00:00Z') TO ('2027-01-01T00:00:00Z');

-- Attribution lookup: the buyer's devices inside the window.
CREATE INDEX affiliate_clicks_device_idx ON affiliate_clicks (device_hash, ts DESC);
-- Per-IP hourly cap and creator analytics.
CREATE INDEX affiliate_clicks_ip_idx ON affiliate_clicks (creator_id, ip_hash, ts);
CREATE INDEX affiliate_clicks_creator_idx ON affiliate_clicks (creator_id, ts);

CREATE TABLE attributions (
  order_group_id  uuid PRIMARY KEY,
  creator_id      uuid NOT NULL REFERENCES creator_accounts (id),
  link_id         uuid NOT NULL REFERENCES affiliate_links (id),
  click_id        uuid NOT NULL,
  click_at        timestamptz NOT NULL,
  buyer_user_id   uuid NOT NULL,
  rate_snapshot   jsonb NOT NULL,
  window_end      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'VOIDED')),
  void_reason     text CHECK (void_reason IS NULL OR void_reason IN
                    ('self_purchase', 'same_device', 'shared_payment', 'shared_address', 'cluster', 'creator_ineligible')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attributions_void_shape CHECK ((status = 'VOIDED') = (void_reason IS NOT NULL)),
  CONSTRAINT attributions_window CHECK (window_end > click_at)
);

CREATE INDEX attributions_creator_idx ON attributions (creator_id, created_at DESC);
CREATE INDEX attributions_buyer_idx ON attributions (buyer_user_id);

CREATE TABLE commissions (
  id               uuid PRIMARY KEY,
  creator_id       uuid NOT NULL REFERENCES creator_accounts (id),
  order_group_id   uuid NOT NULL REFERENCES attributions (order_group_id),
  order_line_id    uuid NOT NULL,
  base             bigint NOT NULL CHECK (base >= 0),
  rate_bps         integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  amount           bigint NOT NULL CHECK (amount >= 0),
  clawed_back      bigint NOT NULL DEFAULT 0 CHECK (clawed_back >= 0),
  refunded_base    bigint NOT NULL DEFAULT 0 CHECK (refunded_base >= 0 AND refunded_base <= base),
  state            text NOT NULL CHECK (state IN ('ACCRUING', 'ACCRUED', 'PAID', 'CLAWED_BACK', 'VOIDED')),
  hold_reason      text CHECK (hold_reason IS NULL OR hold_reason IN ('monthly_cap', 'creator_not_active')),
  void_reason      text CHECK (void_reason IS NULL OR char_length(void_reason) <= 64),
  month_key        text NOT NULL CHECK (month_key ~ '^[0-9]{4}-[0-9]{2}$'),
  closed_at        timestamptz NOT NULL,
  accrued_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commissions_line_creator_uq UNIQUE (order_line_id, creator_id),
  CONSTRAINT commissions_clawback_bound CHECK (clawed_back <= amount),
  CONSTRAINT commissions_hold_shape CHECK ((state = 'ACCRUING') = (hold_reason IS NOT NULL)),
  CONSTRAINT commissions_accrued_stamp CHECK (state IN ('ACCRUING', 'VOIDED') OR accrued_at IS NOT NULL),
  CONSTRAINT commissions_void_shape CHECK ((state = 'VOIDED') = (void_reason IS NOT NULL)),
  CONSTRAINT commissions_full_clawback CHECK (state <> 'CLAWED_BACK' OR clawed_back = amount)
);

CREATE INDEX commissions_creator_idx ON commissions (creator_id, created_at DESC);
CREATE INDEX commissions_group_idx ON commissions (order_group_id);
CREATE INDEX commissions_held_idx ON commissions (month_key, creator_id) WHERE state = 'ACCRUING';

-- Ledger intents. Each state change that moves money inserts its intent in the SAME transaction
-- as the change (seq 0 is the accrual, 1.. are clawbacks). A poster then posts the idempotent
-- entry with key creator_commission:{commission_id}:{seq} and stamps posted_at. A crash between
-- the claim and the post is repaired by replaying the key, and a clawback can never be posted
-- twice with a different amount because the amount is fixed here.
CREATE TABLE commission_postings (
  commission_id  uuid NOT NULL REFERENCES commissions (id),
  seq            integer NOT NULL CHECK (seq >= 0),
  kind           text NOT NULL CHECK (kind IN ('accrual', 'clawback')),
  amount         bigint NOT NULL CHECK (amount > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  posted_at      timestamptz,
  PRIMARY KEY (commission_id, seq),
  CONSTRAINT commission_postings_accrual_first CHECK ((kind = 'accrual') = (seq = 0))
);

CREATE INDEX commission_postings_unposted_idx ON commission_postings (created_at) WHERE posted_at IS NULL;

CREATE TABLE creator_monthly_accruals (
  creator_id  uuid NOT NULL REFERENCES creator_accounts (id),
  month_key   text NOT NULL CHECK (month_key ~ '^[0-9]{4}-[0-9]{2}$'),
  accrued     bigint NOT NULL DEFAULT 0 CHECK (accrued >= 0),
  PRIMARY KEY (creator_id, month_key)
);

ALTER TABLE affiliate_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_monthly_accruals ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_postings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON affiliate_clicks TO app_user;
GRANT SELECT, INSERT, UPDATE ON attributions, commissions, creator_monthly_accruals, commission_postings TO app_user;

-- Clicks carry no user id: only the module reads or writes them.
CREATE POLICY affiliate_clicks_all ON affiliate_clicks FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
-- Attributions name the buyer: system only (a creator never learns who bought).
CREATE POLICY attributions_all ON attributions FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY commissions_select ON commissions FOR SELECT
  USING (app_role() = 'system' OR EXISTS (
    SELECT 1 FROM creator_accounts a WHERE a.id = commissions.creator_id AND a.user_id = app_user_id()));
CREATE POLICY commissions_insert ON commissions FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY commissions_update ON commissions FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY commission_postings_all ON commission_postings FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY creator_monthly_accruals_all ON creator_monthly_accruals FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
