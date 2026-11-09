-- migration: 0029_review_fixes_breach_onboarding
-- phase: expand (new columns, new index, new function, extra grants; nothing dropped)
-- Chief-review fixes.
-- 1. breach_records: a recorded_at next to each *_notified_at. notified_at is the claimed send time (validated detected_at <= notified_at <= now
--    in the service); recorded_at is the system clock when the register was updated, so a backdated notice is visible against its recording time.
-- 2. kyc_cases: one live onboarding case per applicant. The partial unique index covers every state except REJECTED (a rejected applicant may
--    start over); it is a superset of the editable states DRAFT/NEEDS_INFO so a submitted or approved applicant cannot open a second seller either.
-- 3. Applicant-driven draft creation no longer runs as the 'seller.kyc' worker job from the request path.
--    * Both rows (sellers + kyc_cases) are written by create_seller_draft(): SECURITY DEFINER, callable only in the 'user' context with a bound
--      user and market, seller status forced to 'draft', kyc_cases.applicant_user_id forced to app.current_user_id() and seller_id to the draft
--      seller just created, so an applicant can never point a case at another seller. created_at is clamped to now() (a caller-supplied clock
--      may not post-date). outlet_app keeps no direct INSERT on sellers or kyc_cases (chief-review fix 6/7).
--    * sellers has no RLS (ADR-0010: public seller identity is read by catalog) so a per-row policy is not possible without changing every reader.

ALTER TABLE breach_records ADD COLUMN pdpc_recorded_at timestamptz, ADD COLUMN subjects_recorded_at timestamptz;
GRANT UPDATE (pdpc_recorded_at, subjects_recorded_at) ON breach_records TO outlet_app;

CREATE UNIQUE INDEX kyc_cases_applicant_active_uidx ON kyc_cases (market_id, applicant_user_id) WHERE kind = 'onboarding' AND state <> 'REJECTED';

CREATE FUNCTION create_seller_draft(
  p_id uuid, p_case_id uuid, p_legal_type text, p_legal_name_ar text, p_legal_name_en text, p_commercial_register_no text,
  p_tax_card_no text, p_governorate_code text, p_governorate_name_ar text, p_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
DECLARE
  v_at timestamptz := LEAST(p_at, now());
BEGIN
  IF app.ctx() IS DISTINCT FROM 'user' OR app.current_user_id() IS NULL OR app.current_market_id() IS NULL THEN
    RAISE EXCEPTION 'create_seller_draft needs the user context with a bound user and market' USING ERRCODE = '42501';
  END IF;
  INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no,
                       governorate_code, governorate_name_ar, status, created_at, updated_at)
  VALUES (p_id, app.current_market_id(), app.current_market_id(), p_legal_type, p_legal_name_ar, p_legal_name_en, p_commercial_register_no,
          p_tax_card_no, p_governorate_code, p_governorate_name_ar, 'draft', v_at, v_at);
  INSERT INTO kyc_cases (id, seller_id, market_id, applicant_user_id, created_at, updated_at)
  VALUES (p_case_id, p_id, app.current_market_id(), app.current_user_id(), v_at, v_at);
END
$$;
REVOKE ALL ON FUNCTION create_seller_draft(uuid, uuid, text, text, text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_seller_draft(uuid, uuid, text, text, text, text, text, text, text, timestamptz) TO outlet_app;
