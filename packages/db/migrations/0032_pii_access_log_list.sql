-- migration: 0032_pii_access_log_list
-- phase: expand (one function, no table change)
-- Source: admin console privacy read (GET /v1/{market}/admin/privacy/pii-access-log), master prompt 23 (every PII view logged with a reason code), ADR-0011.
-- Access. Same mechanism as audit_log_page (0028): outlet_app has NO SELECT on pii_access_log; the read goes through a SECURITY DEFINER function
-- that pins app.current_market_id(). Who may call it (pii_access.read: security, dpo, super_admin break-glass) is decided in the service layer.
-- pii_access_log_page (0028) has no date range, so this adds pii_access_log_list with from/until and an action filter. The table holds ids and
-- reason codes only (no personal data), so the function returns whole rows.
CREATE FUNCTION pii_access_log_list(
  p_cursor timestamptz, p_cursor_id uuid, p_limit int, p_actor_id text, p_target_type text, p_from timestamptz, p_until timestamptz
) RETURNS SETOF pii_access_log
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
  SELECT p.* FROM pii_access_log p
   WHERE p.market_id = app.current_market_id()
     AND (p_cursor IS NULL OR (p.occurred_at, p.id) < (p_cursor, p_cursor_id))
     AND (p_actor_id IS NULL OR p.actor_id = p_actor_id)
     AND (p_target_type IS NULL OR p.target_type = p_target_type)
     AND (p_from IS NULL OR p.occurred_at >= p_from)
     AND (p_until IS NULL OR p.occurred_at < p_until)
   ORDER BY p.occurred_at DESC, p.id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION pii_access_log_list(timestamptz, uuid, int, text, text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pii_access_log_list(timestamptz, uuid, int, text, text, timestamptz, timestamptz) TO outlet_app;
