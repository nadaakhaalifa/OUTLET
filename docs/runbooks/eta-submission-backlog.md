# Runbook: ETA e-invoice / e-receipt submission backlog

Owner: Finance engineering with Tax lead. Roles: on-call engineer, tax lead, finance lead. Severity: Sev3 for a backlog under 24 h; Sev2 if rejections are systematic, or documents age toward a statutory deadline (VERIFY deadline with tax counsel); Sev1 not expected unless wrong tax amounts were issued.

## Trigger
- Documents stuck `pending/awaiting status`, dead-lettered submissions, or ETA rejections rising.
- Daily reconciliation report (submitted vs accepted vs rejected, spec B4) shows differences: `GET /v1/admin/tax/reconciliation?date=`.
- NOT available (2026-10-11): the live ETA production adapter (`apps/api/src/modules/tax-eta/domain/ports.ts` states the production adapter, signing and live calls are not implemented; only the port and in-memory/fake paths exist), a scheduler for status polling, and alerting on backlog age. Everything marked "live" below is VERIFY BEFORE LAUNCH (register row 6).

## Known facts from code
- Admin endpoints in `apps/api/src/modules/tax-eta/adapters/tax-eta.controller.ts`:
  - `GET /v1/admin/tax/documents` and `GET /v1/admin/tax/documents/{documentId}`
  - `GET /v1/admin/tax/reconciliation?date=`
  - `POST /v1/admin/tax/submissions/{documentId}/requeue` (idempotent, requires `Idempotency-Key`, only for dead-lettered submissions; others return 409 `invalid_transition`)
  - `GET /v1/admin/tax/categories`, `PUT .../categories/{code}/exemption`, `POST .../exemption/clear`, `GET /v1/admin/tax/exemption-audit`
- Port events: `eta.submission_accepted`, `eta.submission_rejected`, `eta.submission_dead_lettered`. Internal IDs are idempotent so resubmission cannot duplicate.
- Seller view: `GET /v1/seller/invoices`.

## Steps
1. Scope: `GET /v1/admin/tax/documents` filtered by status; count by state and age. Check the reconciliation report for the affected date.
2. Classify:
   - ETA unreachable / timeouts: wait, backoff continues; do nothing aggressive. Check ETA portal status. Provide daily count to tax lead.
   - Rejections with reasons: read reasons on the document; common causes to check are tax category or exemption set wrongly (exemption-audit), missing seller registration data, rounding or net/vat/gross mismatch. Fix the data first, then requeue. Never requeue blindly: the same rejection repeats.
   - Dead-lettered: after the fix, `POST /v1/admin/tax/submissions/{documentId}/requeue` one at a time, then in small batches.
3. Do not edit or delete a document; corrections use credit/debit documents (VERIFY with tax counsel which document type applies).
4. Signing token or credential expired or revoked: follow secret-rotation.md; rotate and requeue.
5. Notify sellers with delayed invoices if more than 24 h (copy: Arabic first).

## Verification
- Reconciliation for each affected date has zero unmatched; accepted count equals submitted minus rejected-with-reason.
- Document detail shows ETA UUID and QR where applicable (spec B4).
- VAT totals per document equal ledger `platform_vat_output` entries for the period (cross-check with ledger-integrity.md tooling).

## Rollback
Requeue is the only mutation and is idempotent; exemption changes are reversible with `/exemption/clear` and are audited. Nothing to undo for ETA-accepted documents beyond issuing corrections.

## Escalation
On-call -> tax lead -> counsel (deadline exposure, penalties) -> owner. Penalty figures are VERIFY.

## Post-mortem checklist
- Documents affected, oldest age, any missed deadline.
- Cause class (ETA, credentials, data, bug) and the test added in `apps/api/src/modules/tax-eta/test/`.
- Add backlog-age alert and polling schedule if still missing.
- Update verify register row 6.
