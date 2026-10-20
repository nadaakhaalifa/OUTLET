# Brand application review and store provisioning

Parent spec: docs/specs/brand-onboarding.md. ADR: docs/adr/0031-brand-onboarding-and-verification.md. Operations: docs/specs/brand-onboarding-contract.md (Admin table). Code: `apps/api/src/modules/admin/brand-review`, `apps/api/src/modules/stores/provisioning`, `apps/api/src/modules/notifications/adapters/brand-templates.ts`, `apps/api/src/composition/brand-wiring.ts` and `brand-adapters.ts`.

## Flow
1. Submitted applications: the consumer of `brand_application.submitted` calls the sellers port `runAutoChecks` (SUBMITTED -> AUTO_CHECKS -> IN_REVIEW) and sends `brand_application_received`. Idempotent by message id; an already advanced application is success.
2. Reviewer (ops or trust_safety, passkey) lists the queue (`GET /v1/admin/brand-applications`, oldest decision due first, keyset cursor), opens detail (ETag `"v<version>"`), claims it, reads documents through audited short-lived URLs and decides.
3. approve | reject | needs_info. A GLOBAL application whose auto-check report says dual approval is required (high-risk country or sanctions warn/fail, or no report at all: fail closed) stays IN_REVIEW with `pending_cosign=true` until a different admin cosigns.
4. approve emits `brand_application.approved` (sellers outbox, same transaction). The provisioning consumer creates the store, grants the owner, seeds the checklist, writes the store id back (`markProvisioned`), emits `store.provisioned`, then sends `brand_application_approved`.

## Rules
- Reviewer must not be the applicant: same user id (seller or linked shopper), same phone hash, or work e-mail on the brand domain -> 409 `reviewer_is_applicant` on claim, decision, cosign and document read.
- Decision requires the claim (409 `not_assignee`), status IN_REVIEW (409 `invalid_transition`), optimistic version (`If-Match: "v<n>"`, stale -> 409 `version_conflict`), no open claim conflict for approve (409 `claim_conflict_open`).
- reject: reason_code != ok and both public messages. needs_info: at least one requested item and both public messages. approve: reason_code ok. Violations -> 400 with pointers. `internal_note` is stored, never returned in applicant fields, never written to the audit diff.
- Cosign: different admin than the first approver (409 `cosign_same_admin`), holding ops or trust_safety through a live JIT elevation (403 `elevation_required`), request not older than 24 h (409 `cosign_expired`), a request must exist (409 `cosign_not_requested`). The admin approval kinds are a closed enum in `packages/domain/admin`, so the cosign record mirrors `approvalCovers` (distinct approver, unexpired) in `cosignCovers` instead of adding a kind there.
- Sanctions evidence for the sellers approval guard (`sanctionsClear`) is true only when the stored report has a passing sanctions check.
- Document read URL: reason code mandatory (kyc_review | appeal_review | fraud_investigation | legal_request), assignee only, clean-scanned documents only (409 `document_not_readable`). The audit row is appended BEFORE the URL is created; a failed append returns 503 and no URL exists. A URL expiring later than 15 minutes is refused (503, fail closed). Response is `Cache-Control: no-store`; the URL is never logged.
- SLA: `decision_due_at` is 5 business days (Africa/Cairo, Friday/Saturday weekend, `computeDecisionDueAt`) set by the sellers module at submit/resubmit. `sla_breached` = open (SUBMITTED, AUTO_CHECKS, IN_REVIEW) and now > due; NEEDS_INFO pauses it.
- Every mutation writes the hash-chained admin audit row with reason code `kyc_review` and a PII-free diff. An audit failure is a closed 503.

## Provisioning
- Store id is derived from the application id (UUID v5-shaped), so replays, retries and concurrent duplicates can only address one store row. Every follow-up step is idempotent and is re-run on retry.
- Identity facts (owner, legal identity) come from the application via `ProvisioningApplicationPort.payloadFor`, never from the event payload.
- Store: kind from the application, slug from the brand name (Latin) or hint, numeric suffix on collision, `brand-<8 hex>` for Arabic-only names, status ACTIVE, seller KYC APPROVED, no verified badge, B5 legal identity projection (governorate or country code), free-delivery threshold 2,000 EGP default.
- Duplicate normalized store name (casefold, Arabic letter folding, diacritics and punctuation stripped) -> conflict queue entry + application parked `PROVISIONING_FAILED/store_name_conflict`, no store, no approval notice.
- Any other failure -> parked `provisioning_error`, message still marked processed, `RetryFailedProvisioning.retry/sweep` completes it without a second store.
- Notification failure never undoes provisioning.
- Egypt: ETA registration placeholder from the declared value (`unknown` default); the real ETA enrolment is later.

## Notifications
Templates `brand_application_{received,needs_info,approved,rejected,appeal_result}` on in_app, push and email, AR and EN, category transactional, type ORDER_UPDATES (the notification type CHECK in migration 0018 has no onboarding type). Only `{{brand_name}}` is interpolated: reviewer messages stay in the application and are read through the deep link `/seller/applications/<id>`. Copy is synthetic until marketing and counsel approve.

## Wiring status
Production composition (`apps/api/src/production/compose.ts`, `brandReviewProduction` in `composition/brand-wiring.ts`):
- Real: sellers admin port (SELLERS_ADMIN_PORT), brand-verification store, SendNotification, seller auth `SellerMembershipService.grantStoreRole` (owner), stores repository, admin store and audit, the Postgres review overlay (`KyselyBrandReviewOverlay`, migration 0054 `brand_review_overlay`: cosign first approver, PROVISIONING_FAILED parking, conflicting store id, retry counters), `store.provisioned` through the transactional outbox (`KyselyProvisioningEvents`, idempotent per store id).
- Delivery: the worker's outbox relay routes `brand_application.*` to `BrandApplicationEventConsumer` (`BrandEventsPublisher`, inbox consumer `brand-onboarding.relay`; dedupe row and handler share one transaction, a throw retries with backoff and DLQ).
- Admin retry: `POST /v1/admin/brand-applications/{id}/retry-provisioning` (operationId `adminRetryBrandProvisioning`), only from PROVISIONING_FAILED, audited first, idempotent.
- Intentional no-op: the onboarding checklist is derived from application and seller settings state, so `seedChecklist` and `setEtaRegistration` do nothing (`DerivedStoreOnboarding`).
Fallback (in-memory, listed by `composeBrandOnboarding().fallbacks`, dev boot only): everything above for `in-memory-dev`.

## Gaps for owners
- No scheduled sweeper for parked applications yet (`RetryFailedProvisioning.sweep` exists; only the admin route calls retry).
- `ReviewerIdentityPort` in production is the userId-only default: the applicant-phone and brand-domain reviewer checks need an admin directory lookup.
- `claimConflictOpen`, `highRiskCountry` and `duplicateClaimApplicationIds` are still not populated by the sellers adapter.
- `adminRecordTrademarkLookup` and `adminResolveBrandClaimConflict` are not implemented here (not in the brief); `claimConflictOpen` is false until brand-verification exposes conflicts to this port.
- Phone hash scheme: the adapter uses SHA-256 of E.164; the reviewer identity directory must match.
- Production templates must be seeded outside the dev seed (templates are only auto-seeded in dev).
- `SELLER_MEMBERSHIPS` is the Nest token; provisioning consumes the same service through `AuthSellerMemberships`.

## Acceptance
`brand-review.http.test.ts` (negative matrix per route and role, decisions, dual approval, read URL), `provisioning.test.ts`, `composition/brand-wiring.test.ts`, `notifications/brand-templates.test.ts`, authz matrix rows.
