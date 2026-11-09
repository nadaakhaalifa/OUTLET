# Admin module

Operations: approvals, KYC, reconciliation, audit log (list, verify), feature flags and kill switches, just-in-time elevations.

## Audit-log verify and elevations
- `GET audit-log/verify` (`audit.read`, 6 per minute per staff user): `PgAuditStore.verifyChain` through the SECURITY DEFINER page function as `outlet_app` (no admin-only role needed). A broken chain answers 200 with `ok:false`, `broken_seq`, `reason`. A truncated tail needs the external seal (`audit_seals`), not covered here.
- `GET/POST elevations`, `POST elevations/{id}/decision` (`elevation.request` / `elevation.approve`): all writes go through `@outlet/admin-access` (audited in the same transaction, idempotency key required). Approvers see every elevation of the market; others see their own.
- `super_admin` (break-glass) cannot be approved here (409 `dual-approval-required`): it activates when its approval request (`approval_request_id`) gets two votes on `approval-requests/{id}/decision`; the last vote runs `activateElevation`.
- Composition: `ops.elevations` (`PgElevationReader`) must be added to the production wiring in `src/cli.ts`; until then the three elevation routes answer 503 (fail closed). Not done here because cli.ts is being edited by another agent.
