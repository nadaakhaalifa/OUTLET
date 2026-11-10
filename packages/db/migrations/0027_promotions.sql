-- migration: 0027_promotions
-- phase: expand (new tables only)
-- Source: master prompt section 17 (promotions engine), 15.3 (vouchers); docs/data-model.md 7.22; docs/specs/ledger-chart-of-accounts.md 4.2;
--         ADR-0011 (roles and RLS contexts).
--
-- Tenancy. There is no 'admin' DB context (ADR-0011, see 0009): platform promotions (store_id NULL) are written by admin code running as
-- outlet_app / ctx 'user'; WHO may write them is enforced in @outlet/promotions through @outlet/policy (promotion.write, admin kind), the
-- policy here only pins the market. Seller promotions carry store_id and are isolated by <tbl>_store_isolation (a foreign store sees nothing).
-- Promotions are not personal data and the evaluator needs every active one, so ctx 'user' may READ any promotion in its market; a store ctx
-- reads only its own. voucher_redemptions is user-keyed (shopper reads own rows only) and APPEND-ONLY for every role (grants + trigger).
--
-- Deviations from data-model 7.22 (recorded here, ADR-0011 style):
--   * promotion_targets is not built: targeting lives in the Zod-validated rules jsonb (one document, versioned).
--   * promotion_budget_shards is replaced by one row per promotion in promotion_usage (atomic conditional UPDATE enforces budget and
--     total_limit); shards stay a Drop Hour optimisation (ADR to follow when a hot promotion is measured).
--   * vouchers gains store_id (seller-issued codes, store RLS). vouchers.uses and promotion_usage are bumped only by the SECURITY DEFINER functions at the end of this file (outlet_app has no
--     direct UPDATE), in the same transaction as the redemption row (a shopper cannot see other shoppers' redemptions, so the cap cannot be counted from them).
--   * voucher_redemptions is an event log: kind reserved | confirmed | released | reinstated (ref_id points at the reserved row).
--     UNIQUE (order_group_id, promotion_id, kind) makes a replay a no-op. order_group_id / seller_order_id are logical references (no FK):
--     the reservation is taken at place time, before the order rows exist.
--   * promotion_versions is new: immutable snapshot per version (order lines cite promotion id + version).

CREATE TABLE promotions (
  id                   uuid PRIMARY KEY,
  market_id            text NOT NULL CHECK (length(market_id) > 0),
  owner_type           text NOT NULL CHECK (owner_type IN ('platform', 'store', 'co_funded')),
  store_id             uuid REFERENCES stores (id),
  type                 text NOT NULL CHECK (type IN ('percent', 'fixed', 'free_shipping', 'bogo', 'tiered', 'bundle', 'first_order', 'birthday', 'win_back', 'payment_partner', 'store_follower')),
  name_ar              text NOT NULL CHECK (length(btrim(name_ar)) > 0),
  name_en              text,
  rules                jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  stacking_class       text NOT NULL CHECK (stacking_class IN ('platform_code', 'store_voucher', 'auto', 'payment_partner')),
  funding_platform_bp  int NOT NULL CHECK (funding_platform_bp BETWEEN 0 AND 10000),
  funding_seller_bp    int NOT NULL CHECK (funding_seller_bp BETWEEN 0 AND 10000),
  per_user_limit       int CHECK (per_user_limit IS NULL OR per_user_limit >= 1),
  total_limit          int CHECK (total_limit IS NULL OR total_limit >= 1),
  min_order_minor      bigint CHECK (min_order_minor IS NULL OR min_order_minor >= 0),
  max_discount_minor   bigint CHECK (max_discount_minor IS NULL OR max_discount_minor > 0),
  budget_minor         bigint CHECK (budget_minor IS NULL OR budget_minor > 0),
  currency             char(3) NOT NULL,
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED', 'EXHAUSTED')),
  version              int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (funding_platform_bp + funding_seller_bp = 10000),
  CHECK (ends_at > starts_at),
  CHECK ((owner_type = 'platform') = (store_id IS NULL) OR owner_type = 'co_funded'),
  CHECK (owner_type <> 'co_funded' OR store_id IS NOT NULL),
  CHECK (owner_type <> 'platform' OR funding_platform_bp = 10000),
  CHECK (owner_type <> 'store' OR funding_seller_bp = 10000)
);
CREATE INDEX promotions_active_idx ON promotions (market_id, status, starts_at) WHERE status IN ('SCHEDULED', 'ACTIVE');
CREATE INDEX promotions_store_idx ON promotions (store_id, status);

CREATE TABLE promotion_versions (
  promotion_id  uuid NOT NULL REFERENCES promotions (id),
  version       int NOT NULL CHECK (version >= 1),
  store_id      uuid REFERENCES stores (id),
  market_id     text NOT NULL CHECK (length(market_id) > 0),
  snapshot      jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  changed_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (promotion_id, version)
);

CREATE TABLE promotion_usage (
  promotion_id  uuid PRIMARY KEY REFERENCES promotions (id),
  store_id      uuid REFERENCES stores (id),
  market_id     text NOT NULL CHECK (length(market_id) > 0),
  used_minor    bigint NOT NULL DEFAULT 0 CHECK (used_minor >= 0),
  used_count    int NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  currency      char(3) NOT NULL
);

CREATE TABLE vouchers (
  id                uuid PRIMARY KEY,
  market_id         text NOT NULL CHECK (length(market_id) > 0),
  promotion_id      uuid NOT NULL REFERENCES promotions (id),
  store_id          uuid REFERENCES stores (id),
  kind              text NOT NULL CHECK (kind IN ('public_code', 'unique_code', 'auto')),
  code_display      text CHECK (code_display IS NULL OR code_display ~ '^[A-Z0-9]{8,32}$'),
  code_hash         bytea,
  last4             text CHECK (last4 IS NULL OR length(last4) = 4),
  assigned_user_id  uuid REFERENCES users (id),
  max_uses          int CHECK (max_uses IS NULL OR max_uses >= 1),
  uses              int NOT NULL DEFAULT 0 CHECK (uses >= 0 AND (max_uses IS NULL OR uses <= max_uses)),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void', 'expired')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'unique_code' OR (code_hash IS NOT NULL AND last4 IS NOT NULL)),
  CHECK (kind <> 'public_code' OR code_display IS NOT NULL)
);
CREATE UNIQUE INDEX vouchers_hash_uq ON vouchers (market_id, code_hash) WHERE code_hash IS NOT NULL;
CREATE UNIQUE INDEX vouchers_display_uq ON vouchers (market_id, code_display) WHERE code_display IS NOT NULL;
CREATE INDEX vouchers_assigned_idx ON vouchers (assigned_user_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX vouchers_promotion_idx ON vouchers (promotion_id);

CREATE TABLE voucher_redemptions (
  id                    uuid PRIMARY KEY,
  voucher_id            uuid REFERENCES vouchers (id),
  promotion_id          uuid NOT NULL REFERENCES promotions (id),
  promotion_version     int NOT NULL CHECK (promotion_version >= 1),
  user_id               uuid NOT NULL REFERENCES users (id),
  market_id             text NOT NULL CHECK (length(market_id) > 0),
  order_group_id        uuid NOT NULL,
  seller_order_id       uuid,
  kind                  text NOT NULL CHECK (kind IN ('reserved', 'confirmed', 'released', 'reinstated')),
  ref_id                uuid REFERENCES voucher_redemptions (id),
  amount_minor          bigint NOT NULL CHECK (amount_minor >= 0),
  platform_funded_minor bigint NOT NULL CHECK (platform_funded_minor >= 0),
  seller_funded_minor   bigint NOT NULL CHECK (seller_funded_minor >= 0),
  currency              char(3) NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_group_id, promotion_id, kind),
  CHECK (amount_minor = platform_funded_minor + seller_funded_minor),
  CHECK ((kind = 'reserved') = (ref_id IS NULL))
);
CREATE INDEX voucher_redemptions_user_idx ON voucher_redemptions (promotion_id, user_id, created_at);
CREATE INDEX voucher_redemptions_group_idx ON voucher_redemptions (order_group_id);
CREATE INDEX voucher_redemptions_ref_idx ON voucher_redemptions (ref_id) WHERE ref_id IS NOT NULL;

CREATE FUNCTION voucher_redemptions_append_only() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'voucher_redemptions is append-only'; END $$;
CREATE TRIGGER voucher_redemptions_no_update BEFORE UPDATE OR DELETE ON voucher_redemptions
  FOR EACH ROW EXECUTE FUNCTION voucher_redemptions_append_only();

-- Store-keyed tables: ctx store sees its own rows; ctx user reads the market (promotions are public config) and writes only platform rows
-- (store_id NULL; the admin check is in the application layer, see header).
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['promotions', 'promotion_versions', 'promotion_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (market_id = app.current_market_id() AND (store_id = app.current_store_id() OR app.ctx() = ''user''))
         WITH CHECK (market_id = app.current_market_id() AND (store_id = app.current_store_id() OR (store_id IS NULL AND app.ctx() = ''user'')))',
      t || '_store_isolation', t);
  END LOOP;
END
$do$;
-- usage counters are bumped by shoppers at place time for ANY store's promotion (aggregate counters, no personal data)
DROP POLICY promotion_usage_store_isolation ON promotion_usage;
CREATE POLICY promotion_usage_store_isolation ON promotion_usage
  USING (market_id = app.current_market_id() AND (store_id = app.current_store_id() OR app.ctx() = 'user'))
  WITH CHECK (market_id = app.current_market_id() AND (store_id = app.current_store_id() OR app.ctx() = 'user'));

ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vouchers FORCE ROW LEVEL SECURITY;
CREATE POLICY vouchers_store_isolation ON vouchers
  USING (market_id = app.current_market_id() AND (store_id = app.current_store_id()
         OR (app.ctx() = 'user' AND (assigned_user_id IS NULL OR assigned_user_id = app.current_user_id()))))
  WITH CHECK (market_id = app.current_market_id() AND (store_id = app.current_store_id() OR app.ctx() = 'user'));
-- WITH CHECK is loose for ctx user on purpose: a shopper's place-time transaction bumps vouchers.uses on any store's voucher (UPDATE re-checks the
-- new row). Who may ISSUE vouchers is enforced in @outlet/promotions (policy promotion.write); outlet_app has no UPDATE on any other voucher column.

ALTER TABLE voucher_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY voucher_redemptions_user_isolation ON voucher_redemptions
  USING (market_id = app.current_market_id() AND app.ctx() = 'user' AND user_id = app.current_user_id())
  WITH CHECK (market_id = app.current_market_id() AND app.ctx() = 'user' AND user_id = app.current_user_id());

REVOKE ALL ON promotions, promotion_versions, promotion_usage, vouchers, voucher_redemptions FROM outlet_app, outlet_worker, outlet_auth;
GRANT SELECT, INSERT ON promotions, promotion_versions, vouchers, voucher_redemptions TO outlet_app;
GRANT UPDATE (name_ar, name_en, rules, stacking_class, funding_platform_bp, funding_seller_bp, per_user_limit, total_limit, min_order_minor,
              max_discount_minor, budget_minor, starts_at, ends_at, status, version, updated_at, type) ON promotions TO outlet_app;
GRANT SELECT, INSERT ON promotion_usage TO outlet_app;
GRANT UPDATE (status) ON vouchers TO outlet_app;
-- No direct UPDATE of promotion_usage (used_minor/used_count) or vouchers.uses for outlet_app: counters move only through the two SECURITY
-- DEFINER functions below, which enforce the caps. (Voucher status stays updatable for void/expire by the issuing side.)

-- Both functions are owned by the migrator (migrations run as the owner, see 0002); the owner must be able to bypass FORCE RLS on the
-- tables it writes (superuser or BYPASSRLS), otherwise the promotions status write for a store promotion under ctx 'user' is refused.
-- They still require the caller's context: ctx 'user' and the caller's market.
-- Public voucher codes are >= 8 chars (guessing surface); the API layer must also rate-limit code attempts (CodeResolutionBudget).

-- Reserve: atomically adds (amount, 1) to the promotion counters if the promotion is ACTIVE, the amount is within max_discount, and
-- budget_minor and total_limit still allow it; bumps vouchers.uses (max_uses) in the same call; flips the promotion to EXHAUSTED when a cap is
-- reached. Returns 'ok' | 'inactive' | 'max_discount' | 'cap' | 'voucher_cap' | 'voucher_mismatch'. The caller rolls back on anything but 'ok'.
CREATE FUNCTION promotion_usage_bump(p_promotion_id uuid, p_amount bigint, p_voucher_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
DECLARE
  prom promotions%ROWTYPE;
  got  bigint;
BEGIN
  IF app.ctx() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'promotion_usage_bump requires ctx user'; END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN RAISE EXCEPTION 'invalid amount'; END IF;
  SELECT * INTO prom FROM promotions WHERE id = p_promotion_id AND market_id = app.current_market_id();
  IF NOT FOUND OR prom.status <> 'ACTIVE' THEN RETURN 'inactive'; END IF;
  IF prom.max_discount_minor IS NOT NULL AND p_amount > prom.max_discount_minor THEN RETURN 'max_discount'; END IF;
  -- check (and lock) the voucher first, then move the counters, so a refusal never leaves a partial write behind
  IF p_voucher_id IS NOT NULL THEN
    PERFORM 1 FROM vouchers v
     WHERE v.id = p_voucher_id AND v.promotion_id = p_promotion_id AND v.status = 'active' AND (v.max_uses IS NULL OR v.uses < v.max_uses)
       FOR UPDATE;
    IF NOT FOUND THEN RETURN 'voucher_cap'; END IF;
  END IF;
  UPDATE promotion_usage u SET used_minor = u.used_minor + p_amount, used_count = u.used_count + 1
   WHERE u.promotion_id = p_promotion_id
     AND (prom.budget_minor IS NULL OR u.used_minor + p_amount <= prom.budget_minor)
     AND (prom.total_limit IS NULL OR u.used_count < prom.total_limit);
  GET DIAGNOSTICS got = ROW_COUNT;
  IF got = 0 THEN RETURN 'cap'; END IF;
  IF p_voucher_id IS NOT NULL THEN UPDATE vouchers v SET uses = v.uses + 1 WHERE v.id = p_voucher_id; END IF;
  UPDATE promotions p SET status = 'EXHAUSTED', updated_at = now()
   FROM promotion_usage u
   WHERE p.id = p_promotion_id AND u.promotion_id = p.id AND p.status = 'ACTIVE'
     AND ((p.total_limit IS NOT NULL AND u.used_count >= p.total_limit) OR (p.budget_minor IS NOT NULL AND u.used_minor >= p.budget_minor));
  RETURN 'ok';
END
$$;

-- Give back (release / reinstate): subtracts (amount, 1) without going below zero and re-opens an EXHAUSTED promotion whose caps are no longer
-- reached (an abandoned checkout must not kill a promotion) while it is still inside its window.
CREATE FUNCTION promotion_usage_giveback(p_promotion_id uuid, p_amount bigint, p_voucher_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
BEGIN
  IF app.ctx() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'promotion_usage_giveback requires ctx user'; END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN RAISE EXCEPTION 'invalid amount'; END IF;
  UPDATE promotion_usage u SET used_minor = GREATEST(u.used_minor - p_amount, 0), used_count = GREATEST(u.used_count - 1, 0)
   WHERE u.promotion_id = p_promotion_id AND u.market_id = app.current_market_id();
  IF p_voucher_id IS NOT NULL THEN
    UPDATE vouchers v SET uses = v.uses - 1 WHERE v.id = p_voucher_id AND v.promotion_id = p_promotion_id AND v.uses > 0;
  END IF;
  UPDATE promotions p SET status = 'ACTIVE', updated_at = now()
   FROM promotion_usage u
   WHERE p.id = p_promotion_id AND u.promotion_id = p.id AND p.status = 'EXHAUSTED' AND now() < p.ends_at
     AND (p.total_limit IS NULL OR u.used_count < p.total_limit) AND (p.budget_minor IS NULL OR u.used_minor < p.budget_minor);
END
$$;
REVOKE ALL ON FUNCTION promotion_usage_bump(uuid, bigint, uuid), promotion_usage_giveback(uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION promotion_usage_bump(uuid, bigint, uuid), promotion_usage_giveback(uuid, bigint, uuid) TO outlet_app;
