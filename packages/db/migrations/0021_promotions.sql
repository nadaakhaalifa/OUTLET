-- migration: 0021_promotions
-- phase: expand
--
-- Promotions and vouchers core (spec 17, docs/specs/promotions.md, docs/data-model/promotions.md).
-- promotions: one row per promotion. Economic terms (kind, scope, value, funding, targeting) are
-- immutable by application contract; `status`, `ends_at`, caps and `title` are the only edited
-- fields and each edit bumps `version`. Orders cite the version they used (redemptions).
-- promotion_redemptions: one row per (promotion, order group); the source of per-user, per-day and
-- spend counters. Money is BIGINT piastres, EGP only.
-- No column here refers to the budget suite and no FK points at budget tables (spec 12).
-- order_group_id and sku/store ids in targeting are LOGICAL references: orders and catalog FKs are
-- added by expand migrations when those modules land.

CREATE TABLE promotions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind            text NOT NULL CHECK (owner_kind IN ('platform', 'store')),
  store_id              uuid,
  kind                  text NOT NULL CHECK (kind IN ('percent', 'fixed', 'free_shipping', 'bogo', 'tiered')),
  scope                 text NOT NULL CHECK (scope IN ('item', 'store', 'order', 'shipping')),
  code                  text CHECK (code IS NULL OR code ~ '^[A-Z0-9_-]{3,40}$'),
  auto_apply            boolean NOT NULL DEFAULT false,
  title_ar              text NOT NULL CHECK (char_length(title_ar) BETWEEN 1 AND 2000),
  title_en              text CHECK (title_en IS NULL OR char_length(title_en) <= 2000),
  funding_platform_pct  smallint NOT NULL CHECK (funding_platform_pct BETWEEN 0 AND 100),
  funding_seller_pct    smallint NOT NULL CHECK (funding_seller_pct BETWEEN 0 AND 100),
  percent_bp            integer CHECK (percent_bp IS NULL OR percent_bp BETWEEN 1 AND 10000),
  fixed_amount          bigint CHECK (fixed_amount IS NULL OR fixed_amount > 0),
  bogo_buy_qty          integer CHECK (bogo_buy_qty IS NULL OR bogo_buy_qty BETWEEN 1 AND 100),
  bogo_get_qty          integer CHECK (bogo_get_qty IS NULL OR bogo_get_qty BETWEEN 1 AND 100),
  bogo_get_percent_bp   integer CHECK (bogo_get_percent_bp IS NULL OR bogo_get_percent_bp BETWEEN 1 AND 10000),
  tiers                 jsonb,
  min_order_amount      bigint CHECK (min_order_amount IS NULL OR min_order_amount > 0),
  max_discount_amount   bigint CHECK (max_discount_amount IS NULL OR max_discount_amount > 0),
  total_budget_amount   bigint CHECK (total_budget_amount IS NULL OR total_budget_amount > 0),
  per_user_cap          integer CHECK (per_user_cap IS NULL OR per_user_cap >= 1),
  per_day_cap           integer CHECK (per_day_cap IS NULL OR per_day_cap >= 1),
  target_store_ids      uuid[] NOT NULL DEFAULT '{}',
  target_sku_ids        uuid[] NOT NULL DEFAULT '{}',
  target_payment_methods text[] NOT NULL DEFAULT '{}'
    CHECK (target_payment_methods <@ ARRAY['card', 'apple_pay', 'meeza', 'mobile_wallet', 'instapay', 'fawry', 'bnpl', 'cod']::text[]),
  plus_only             boolean NOT NULL DEFAULT false,
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'active', 'paused', 'ended')),
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  currency              char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotions_window_ck CHECK (ends_at > starts_at),
  CONSTRAINT promotions_funding_ck CHECK (funding_platform_pct + funding_seller_pct = 100),
  CONSTRAINT promotions_owner_ck CHECK (
    (owner_kind = 'platform' AND store_id IS NULL)
    OR (owner_kind = 'store' AND store_id IS NOT NULL AND funding_platform_pct = 0)),
  CONSTRAINT promotions_code_xor_auto_ck CHECK ((code IS NOT NULL) <> auto_apply),
  CONSTRAINT promotions_value_ck CHECK (
    (kind = 'percent' AND percent_bp IS NOT NULL AND scope IN ('item', 'store', 'order'))
    OR (kind = 'fixed' AND fixed_amount IS NOT NULL AND scope IN ('item', 'store', 'order'))
    OR (kind = 'bogo' AND bogo_buy_qty IS NOT NULL AND bogo_get_qty IS NOT NULL
        AND bogo_get_percent_bp IS NOT NULL AND scope = 'item')
    OR (kind = 'tiered' AND tiers IS NOT NULL AND jsonb_typeof(tiers) = 'array' AND scope IN ('store', 'order'))
    OR (kind = 'free_shipping' AND scope = 'shipping'))
);

CREATE TRIGGER promotions_touch_updated_at_trg
  BEFORE UPDATE ON promotions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Codes are unique across the platform and every store (one namespace, no ambiguity at redemption).
CREATE UNIQUE INDEX promotions_code_uidx ON promotions (code) WHERE code IS NOT NULL;
CREATE INDEX promotions_store_idx ON promotions (store_id, id) WHERE store_id IS NOT NULL;
CREATE INDEX promotions_live_idx ON promotions (status, starts_at, ends_at);

CREATE TABLE promotion_redemptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id             uuid NOT NULL REFERENCES promotions (id),
  promotion_version        integer NOT NULL CHECK (promotion_version >= 1),
  user_id                  uuid NOT NULL REFERENCES users (id),
  order_group_id           uuid NOT NULL,
  discount_amount          bigint NOT NULL CHECK (discount_amount >= 0),
  platform_funded_amount   bigint NOT NULL CHECK (platform_funded_amount >= 0),
  seller_funded_amount     bigint NOT NULL CHECK (seller_funded_amount >= 0),
  status                   text NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED', 'REINSTATED')),
  day_key                  date NOT NULL,
  redeemed_at              timestamptz NOT NULL DEFAULT now(),
  reinstated_at            timestamptz,
  CONSTRAINT promotion_redemptions_funding_ck
    CHECK (platform_funded_amount + seller_funded_amount = discount_amount),
  CONSTRAINT promotion_redemptions_once_ck UNIQUE (promotion_id, order_group_id)
);

CREATE INDEX promotion_redemptions_user_idx ON promotion_redemptions (promotion_id, user_id) WHERE status = 'APPLIED';
CREATE INDEX promotion_redemptions_day_idx ON promotion_redemptions (promotion_id, day_key) WHERE status = 'APPLIED';
CREATE INDEX promotion_redemptions_order_idx ON promotion_redemptions (order_group_id);
CREATE INDEX promotion_redemptions_user_time_idx ON promotion_redemptions (user_id, redeemed_at);

-- Row level security ---------------------------------------------------------------------
-- promotions: tenant by store for sellers, platform rows for marketing and ops, system for the
-- evaluation and commit paths. There is no DELETE policy: promotions are ended, never removed.
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON promotions TO app_user;
CREATE POLICY promotions_select ON promotions FOR SELECT
  USING (
    app_role() IN ('system', 'marketing', 'ops', 'super_admin')
    OR (store_id IS NOT NULL AND store_id::text = ANY (app_store_ids())));
CREATE POLICY promotions_insert ON promotions FOR INSERT
  WITH CHECK (
    app_role() IN ('system', 'marketing', 'ops')
    OR (owner_kind = 'store' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY promotions_update ON promotions FOR UPDATE
  USING (
    app_role() IN ('system', 'marketing', 'ops')
    OR (owner_kind = 'store' AND store_id::text = ANY (app_store_ids())))
  WITH CHECK (
    app_role() IN ('system', 'marketing', 'ops')
    OR (owner_kind = 'store' AND store_id::text = ANY (app_store_ids())));

-- promotion_redemptions: a shopper reads their own rows; only the system role writes.
ALTER TABLE promotion_redemptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON promotion_redemptions TO app_user;
CREATE POLICY promotion_redemptions_select ON promotion_redemptions FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('system', 'ops', 'finance', 'super_admin'));
CREATE POLICY promotion_redemptions_insert ON promotion_redemptions FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY promotion_redemptions_update ON promotion_redemptions FOR UPDATE
  USING (app_role() = 'system')
  WITH CHECK (app_role() = 'system');
