# Admin module

Operations: approvals, KYC, reconciliation, audit log (list, verify), feature flags and kill switches, just-in-time elevations.

## Audit-log verify and elevations
- `GET audit-log/verify` (`audit.read`, 6 per minute per staff user): `PgAuditStore.verifyChain` through the SECURITY DEFINER page function as `outlet_app` (no admin-only role needed). A broken chain answers 200 with `ok:false`, `broken_seq`, `reason`. A truncated tail needs the external seal (`audit_seals`), not covered here.
- `GET/POST elevations`, `POST elevations/{id}/decision` (`elevation.request` / `elevation.approve`): all writes go through `@outlet/admin-access` (audited in the same transaction, idempotency key required). Approvers see every elevation of the market; others see their own.
- `super_admin` (break-glass) cannot be approved here (409 `dual-approval-required`): it activates when its approval request (`approval_request_id`) gets two votes on `approval-requests/{id}/decision`; the last vote runs `activateElevation`.
- Composition: `ops.elevations` (`PgElevationReader`) must be added to the production wiring in `src/cli.ts`; until then the three elevation routes answer 503 (fail closed). Not done here because cli.ts is being edited by another agent.

## Ops table (served routes)
| Method + path | Policy action | Notes |
|---|---|---|
| `GET kyc-cases`, `POST kyc-cases/{id}/decision` | `seller_kyc.review` | decision runs `SellerOnboardingService.decide` (idempotent, seller.kyc worker job) |
| `GET kyc-cases/{id}` | `seller_kyc.read` (ops, trust_safety; reason code required) | documents (pointers only), checks, seller legal identity. The signatory is stored as the 21+ result only, so `signatory` is null and `signatory_revealed` is never returned. Every read writes `pii_access_log` + a `pii.viewed` audit entry before data leaves |
| `GET roles` | `rbac.read` (security; super_admin only in break-glass) | static catalogue from `@outlet/policy` (admin roles, then seller roles), keyset cursor |
| `GET approval-requests`, `POST approval-requests/{id}/decision` | `approval.read` / `approval.decide` | the final vote and its execution are two transactions |
| `POST approval-requests/{id}/execute` | `approval.decide` | recovery for APPROVED + `executed_at` NULL (crash or 422 after the last vote). Claim and effect share one tx; replay or non-approved = 409 `approval-not-approved`; requester = 403; action without an executor (e.g. `role.grant`) = 422 |
| `GET reconciliation/runs`, `.../runs/{id}/items` | `ledger.read` (reason code) | worker job `finance.reconcile` |
| `GET audit-log`, `GET audit-log/verify` | `audit.read` | |
| `GET/POST elevations`, `POST elevations/{id}/decision` | `elevation.request` / `elevation.approve` | |
| `GET feature-flags`, `POST feature-flags/{key}/kill-switch` | `kill_switch.read` / `kill_switch.engage` | releasing a switch needs dual approval unless it is explicitly registered as class `ui` (policy decides; a missing class counts as money) |

Not served yet (need a new DB role/grant or a design decision): store suspend/reinstate (`store.suspend` is ALWAYS_DUAL_APPROVAL and `SellerOnboardingService` has no reinstate; the contract keys on store id, the use case on seller id), staff list (no staff directory table; email/name are encrypted `users` columns), `privacy/pii-access-log` (no SELECT grant on `pii_access_log` for `outlet_app`), privacy/tax/price-integrity consoles (no readers yet), user lookup (not in the contract).
