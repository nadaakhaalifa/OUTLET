-- 0048 ad click reviews: admin decisions on invalid-click queue entries (spec 18 abuse controls, ads spec).
-- Additive only. One review per click; the decision never moves money (credit-back has its own path).
-- PII: none. decided_by is an admin user id (P1). Rows are append-only (forbid_mutation).

CREATE TABLE ad_click_reviews (
  click_id    uuid PRIMARY KEY,
  decision    text NOT NULL CHECK (decision IN ('confirm_invalid', 'flag_store')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  decided_by  uuid NOT NULL,
  decided_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ad_click_reviews_decided_idx ON ad_click_reviews (decided_at DESC);

ALTER TABLE ad_click_reviews ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON ad_click_reviews TO app_user;
CREATE POLICY ad_click_reviews_select ON ad_click_reviews FOR SELECT USING (app_role() = 'system');
CREATE POLICY ad_click_reviews_insert ON ad_click_reviews FOR INSERT WITH CHECK (app_role() = 'system');

CREATE TRIGGER ad_click_reviews_no_mutation_trg BEFORE UPDATE OR DELETE ON ad_click_reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
