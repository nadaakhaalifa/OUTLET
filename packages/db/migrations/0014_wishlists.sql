-- migration: 0014_wishlists
-- phase: expand
--
-- Wishlists with intent (spec section 8, docs/specs/wishlists.md, docs/data-model/cart.md).
-- Expand only: three new tables, no change to existing ones.
--
--   * product_id and sku_pref_id are logical references to the catalog; the FK is added by the
--     catalog migration when those tables exist (data model: L, not E).
--   * The share token is never stored: only its SHA-256 (32 bytes). One share per list;
--     rotation overwrites the columns, so the previous token stops resolving at once.
--   * Money is integer piastres (bigint) plus currency.
--   * Row level security follows packages/policy/RLS.md class A (user-owned), per verb.
--     The shared-token read and the alert jobs run with app.role = 'system'.

CREATE TABLE wishlists (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id),
  intent             text NOT NULL
                       CHECK (intent IN ('need', 'want', 'treat', 'buy_later_this_month',
                                         'birthday', 'eid_ramadan', 'gift_for_someone', 'custom')),
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  target_date        date,
  budget_amount      bigint CHECK (budget_amount IS NULL OR budget_amount > 0),
  budget_currency    char(3) CHECK (budget_currency IS NULL OR budget_currency = 'EGP'),
  cool_off_enabled   boolean NOT NULL DEFAULT false,
  gift_nickname      text CHECK (gift_nickname IS NULL OR char_length(gift_nickname) BETWEEN 1 AND 40),
  gift_occasion      text CHECK (gift_occasion IS NULL OR char_length(gift_occasion) <= 40),
  gift_date          date,
  share_token_hash   bytea CHECK (share_token_hash IS NULL OR length(share_token_hash) = 32),
  share_created_at   timestamptz,
  share_expires_at   timestamptz,
  share_revoked_at   timestamptz,
  share_hide_prices  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wishlists_budget_pair CHECK ((budget_amount IS NULL) = (budget_currency IS NULL)),
  CONSTRAINT wishlists_cool_off_want_only CHECK (NOT cool_off_enabled OR intent = 'want'),
  CONSTRAINT wishlists_gift_for_intent CHECK (
    (intent = 'gift_for_someone' AND gift_nickname IS NOT NULL)
    OR (intent <> 'gift_for_someone' AND gift_nickname IS NULL AND gift_occasion IS NULL AND gift_date IS NULL)),
  CONSTRAINT wishlists_share_consistent CHECK (
    (share_token_hash IS NOT NULL AND share_created_at IS NOT NULL)
    OR (share_token_hash IS NULL AND share_created_at IS NULL AND share_expires_at IS NULL
        AND share_revoked_at IS NULL)),
  CONSTRAINT wishlists_id_user_uq UNIQUE (id, user_id),
  CONSTRAINT wishlists_share_token_uq UNIQUE (share_token_hash)
);

CREATE INDEX wishlists_user_created_idx ON wishlists (user_id, created_at DESC, id DESC);
CREATE INDEX wishlists_target_date_idx ON wishlists (target_date) WHERE target_date IS NOT NULL;

CREATE TRIGGER wishlists_touch_updated_at_trg
  BEFORE UPDATE ON wishlists
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE wishlist_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wishlist_id     uuid NOT NULL,
  user_id         uuid NOT NULL,          -- denormalised owner, RLS rule 9
  product_id      uuid NOT NULL,          -- logical FK to catalog
  sku_pref_id     uuid,                   -- logical FK to catalog
  added_amount    bigint NOT NULL CHECK (added_amount >= 0),
  added_currency  char(3) NOT NULL DEFAULT 'EGP' CHECK (added_currency = 'EGP'),
  note            text CHECK (note IS NULL OR char_length(note) <= 200),
  cool_off_until  timestamptz,
  added_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wishlist_items_owner_fk FOREIGN KEY (wishlist_id, user_id)
    REFERENCES wishlists (id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX wishlist_items_unique_idx ON wishlist_items
  (wishlist_id, product_id, COALESCE(sku_pref_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX wishlist_items_product_idx ON wishlist_items (product_id);

CREATE TABLE wishlist_alert_dedupe (
  dedupe_key   text PRIMARY KEY CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  wishlist_id  uuid NOT NULL REFERENCES wishlists (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wishlist_alert_dedupe_wishlist_idx ON wishlist_alert_dedupe (wishlist_id);

-- Row level security --------------------------------------------------------------------
ALTER TABLE wishlists ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON wishlists TO app_user;
CREATE POLICY wishlists_owner_select ON wishlists FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wishlists_owner_insert ON wishlists FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wishlists_owner_update ON wishlists FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wishlists_owner_delete ON wishlists FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON wishlist_items TO app_user;
CREATE POLICY wishlist_items_owner_select ON wishlist_items FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wishlist_items_owner_insert ON wishlist_items FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wishlist_items_owner_update ON wishlist_items FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wishlist_items_owner_delete ON wishlist_items FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE wishlist_alert_dedupe ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON wishlist_alert_dedupe TO app_user;
CREATE POLICY wishlist_alert_dedupe_system_select ON wishlist_alert_dedupe FOR SELECT
  USING (app_role() = 'system');
CREATE POLICY wishlist_alert_dedupe_system_insert ON wishlist_alert_dedupe FOR INSERT
  WITH CHECK (app_role() = 'system');
