-- migration: 0054_brand_review_overlay
-- phase: expand
--
-- Review overlay for brand applications (docs/specs/brand-review-and-provisioning.md, ADR-0031): state the
-- sellers module does not model. (1) the first approver of a dual-approval application, so a second admin can
-- cosign within 24 h; (2) the PROVISIONING_FAILED parking flag with its failure code and, for a duplicate store
-- name, the conflicting store id (the admin conflict queue), plus retry bookkeeping.
-- Expand only: new table. application_id is a plain uuid with NO foreign key (the sellers module owns
-- applications). All access is through the API as role 'system'. PII: staff user ids only (P2).

CREATE TABLE brand_review_overlay (
  application_id          uuid PRIMARY KEY,
  cosign_first_approver_id uuid,
  cosign_requested_at     timestamptz,
  provisioning_state      text NOT NULL DEFAULT 'NONE' CHECK (provisioning_state IN ('NONE', 'PROVISIONING_FAILED')),
  provisioning_failure    text CHECK (provisioning_failure IN ('store_name_conflict', 'provisioning_error')),
  conflicting_store_id    uuid,
  failed_at               timestamptz,
  retry_count             integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_retry_at           timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_review_overlay_cosign_pair_chk
    CHECK ((cosign_first_approver_id IS NULL) = (cosign_requested_at IS NULL)),
  CONSTRAINT brand_review_overlay_failure_chk
    CHECK ((provisioning_state = 'PROVISIONING_FAILED') = (provisioning_failure IS NOT NULL AND failed_at IS NOT NULL))
);
-- The admin retry sweep and the PROVISIONING_FAILED list read only parked rows.
CREATE INDEX brand_review_overlay_failed_idx ON brand_review_overlay (failed_at, application_id)
  WHERE provisioning_state = 'PROVISIONING_FAILED';

CREATE TRIGGER brand_review_overlay_touch_updated_at_trg
  BEFORE UPDATE ON brand_review_overlay FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE brand_review_overlay ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON brand_review_overlay TO app_user;

CREATE POLICY brand_review_overlay_select ON brand_review_overlay FOR SELECT USING (app_role() = 'system');
CREATE POLICY brand_review_overlay_insert ON brand_review_overlay FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY brand_review_overlay_update ON brand_review_overlay FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY brand_review_overlay_delete ON brand_review_overlay FOR DELETE USING (app_role() = 'system');
