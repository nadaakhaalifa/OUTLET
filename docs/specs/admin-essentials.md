# Admin essentials (spec section 23, Admin security)

Status: implemented as API only (no web UI). Code: `apps/api/src/modules/admin`, `packages/domain/src/admin`, migration `0029_admin.sql`.

## Flow
1. Dual approval: a requester files an approval for a guarded action; a different person holding the approver scope approves or rejects before expiry. Only the approval RECORD exists here. The owning module (refunds, payouts, plans, exports, role grants) must call `approvalCovers(record, {kind, subject, amount}, now)` and then act. No money moves here.
2. Just-in-time elevation: `POST /v1/admin/elevations` creates an elevation plus a `role_elevation` approval (security or super_admin approves). The requester then activates it; the window (default 1 h, max 4 h) starts at activation. Break-glass is an elevation to `super_admin`: only a standing super_admin can open it, approval kind `break_glass`, max 30 min.
3. PII views: `POST /v1/admin/pii-views` with an enum reason code. The audit row (with reason_code) is written first; if the append fails the call fails and no data is returned.
4. Flags and kill switches: list, read and set. Registry keys only; unknown key is 404. Audit before change.
5. Seller KYC: queue read model over `stores.seller_kyc_state`; suspend and reinstate run the shared `kycMachine`. Every suspension opens a human review due in 5 business days (Africa/Cairo, weekend Fri/Sat). The reviewer must not be the suspender.

## Rules
- Requester can never approve. Approver must hold a role in `APPROVER_ROLES[kind]`. Expiry is exclusive (`now >= expires_at` is expired) and checked on every decision.
- Thresholds (admin-editable config, audited): refund 5,000 EGP, payout 50,000 EGP (piastres, bigint). Missing amount fails closed. Every other kind always needs approval.
- Standing `super_admin` opens no route; it only allows requesting break-glass. A live break-glass session adds the `super_admin` role until it lapses or is revoked.
- Roles come from unexpired standing grants plus live elevations, evaluated on every request (no caching). Passkey assurance is mandatory.
- Missing role: 403 without detail. Object not visible to the caller (approval, elevation): 404.

## API (all under /v1/admin, audience admin_api)
| Route | Roles (effective) |
|---|---|
| GET/POST approvals, GET approvals/:id, POST approvals/:id/approve and reject | any standing admin; visibility and scope per kind |
| POST elevations, GET elevations/mine, POST elevations/:id/activate and revoke | any standing admin; owner only (security/break-glass super_admin may revoke) |
| GET elevations | security, super_admin (break-glass) |
| POST pii-views | support, trust_safety, dpo |
| GET flags, kill-switches, flags/:key | ops, security, super_admin (break-glass) |
| PUT flags/:key | ops |
| GET kyc/queue, kyc/sellers/:id | ops, trust_safety, support |
| POST kyc/sellers/:id/suspend, reinstate; POST kyc/suspension-reviews/:id/uphold | ops, trust_safety |
| GET kyc/suspension-reviews | ops, trust_safety, security |

## Data
`admin_approval_requests`, `admin_elevations`, `kyc_suspension_reviews` (migration 0029, RLS by app.role and app.user_id). Audit rows go to `audit_log` (0005) in chain `admin:YYYY-MM` with `reason_code`.

## Failure handling
Audit append failure fails the action (503). Compare-and-set on every state write; a lost race is 409. Expired approvals are persisted as EXPIRED on first touch.

## Security notes
STRIDE: spoofing (passkey, admin audience), tampering (hash chain, CHECK constraints), repudiation (reason-coded audit), disclosure (404 for unseen objects, values never logged), DoS (rate limits), elevation of privilege (dual approval, TTL caps, break-glass).

## Acceptance
See `admin.http.test.ts` (negative matrix for every route and sub-role) and the shared contract suite run against in-memory and Kysely/PGlite.
