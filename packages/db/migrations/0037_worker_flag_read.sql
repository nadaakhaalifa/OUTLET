-- migration: 0037_worker_flag_read
-- phase: expand (one grant, no table or policy change)
-- Source: docs/adr/0016-worker-process.md, chief review of the worker (F4a). The worker process reads kill switches (`workers.*`, `refunds.enabled`,
-- `promotions.enabled`) on every loop turn. Until now it read feature_flags through its outlet_app credential, so the money switches depended on the
-- credential ADR-0011 says a worker should not hold. outlet_worker gets SELECT only: feature_flags has no RLS by design (0005: a global/market
-- switch table with no personal data), writes stay with the Admin Console on outlet_app (FlagAdmin, audited), and no other privilege is added.
GRANT SELECT ON feature_flags TO outlet_worker;
