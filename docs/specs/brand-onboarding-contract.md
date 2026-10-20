# Brand onboarding: operation contract (poll this file)

Spec: docs/specs/brand-onboarding.md. ADR: docs/adr/0031-brand-onboarding-and-verification.md. Wire: snake_case, Problem+JSON, Idempotency-Key on writes, keyset cursors. Status: FINAL. All 34 operations are in docs/api/openapi.yaml and validate-openapi passes. Path params use {id} and {document_id}; high-risk approve sets pending_cosign=true (status stays IN_REVIEW).

Status enum (application): DRAFT, SUBMITTED, AUTO_CHECKS, IN_REVIEW, NEEDS_INFO, APPROVED, REJECTED, SUSPENDED, WITHDRAWN. Maps to kycMachine: IN_REVIEW is an application sub-state of AUTO_CHECKS (auto checks done, awaiting human); WITHDRAWN is application-only (terminal, kyc stays DRAFT).

## Seller auth (audience=seller, public/enrol token)
| operationId | method path | meaning |
|---|---|---|
| requestSellerOtp | POST /v1/seller/auth/otp/request | phone OTP for seller identity (phone, email, locale) |
| verifySellerOtp | POST /v1/seller/auth/otp/verify | verify OTP; returns ENROL token (scope seller:enrol only, amr otp) |
| sellerPasskeyRegisterOptions | POST /v1/seller/auth/passkey/register/options | WebAuthn creation options (enrol token) |
| sellerPasskeyRegister | POST /v1/seller/auth/passkey/register | finish passkey enrolment; marks strong factor |
| sellerTotpEnrol | POST /v1/seller/auth/totp/enrol | start TOTP fallback; returns otpauth uri + recovery codes once |
| sellerTotpConfirm | POST /v1/seller/auth/totp/confirm | confirm TOTP code; marks strong factor |
| sellerPasskeyAssertOptions | POST /v1/seller/auth/passkey/assert/options | sign-in challenge |
| sellerPasskeyAssert | POST /v1/seller/auth/passkey/assert | sign-in with passkey; returns full seller session |
| sellerTotpAssert | POST /v1/seller/auth/totp/assert | sign-in with phone+TOTP (after OTP step); full seller session |
Refresh/logout: reuse POST /v1/auth/refresh and /v1/auth/logout (token audience decides).

## Applicant (sellerBearer; enrol token allowed for requirements/list/create/patch/documents; submit needs strong factor)
| operationId | method path | meaning |
|---|---|---|
| getBrandRequirements | GET /v1/seller/applications/requirements?kind=&country= | document + field checklist as data |
| listMyBrandApplications | GET /v1/seller/applications | my applications, cursor |
| createBrandApplication | POST /v1/seller/applications | create DRAFT (kind, country, brand_name) |
| getBrandApplication | GET /v1/seller/applications/{id} | full application, docs, requested items, public decision |
| updateBrandApplication | PATCH /v1/seller/applications/{id} | edit fields in DRAFT/NEEDS_INFO |
| submitBrandApplication | POST /v1/seller/applications/{id}/submit | DRAFT -> SUBMITTED (needs strong factor + complete checklist) |
| resubmitBrandApplication | POST /v1/seller/applications/{id}/resubmit | NEEDS_INFO -> SUBMITTED |
| withdrawBrandApplication | POST /v1/seller/applications/{id}/withdraw | withdraw before decision |
| appealBrandApplication | POST /v1/seller/applications/{id}/appeal | one appeal of a REJECTED within 30 days |
| createBrandApplicationDocument | POST /v1/seller/applications/{id}/documents | signed upload URL + document id |
| confirmBrandApplicationDocument | POST /v1/seller/applications/{id}/documents/{document_id}/confirm | upload done, start scan |
| deleteBrandApplicationDocument | DELETE /v1/seller/applications/{id}/documents/{document_id} | remove doc while editable |
| startBrandDomainVerification | POST /v1/seller/applications/{id}/domain-verification | DNS TXT challenge or email at brand domain |
| confirmBrandDomainVerification | POST /v1/seller/applications/{id}/domain-verification/confirm | check TXT / submit emailed code |
| getSellerOnboardingChecklist | GET /v1/seller/onboarding-checklist | first-login checklist after APPROVE |

## Admin (adminBearer, passkey, roles ops/trust_safety)
| operationId | method path | meaning |
|---|---|---|
| adminListBrandApplications | GET /v1/admin/brand-applications | queue with filters status, kind, country, assignee, sla_breached, cursor |
| adminGetBrandApplication | GET /v1/admin/brand-applications/{id} | full detail + auto-check results + history |
| adminClaimBrandApplication | POST /v1/admin/brand-applications/{id}/claim | assign to self (409 if applicant) |
| adminReleaseBrandApplication | POST /v1/admin/brand-applications/{id}/release | unassign |
| adminDecideBrandApplication | POST /v1/admin/brand-applications/{id}/decision | approve / reject / needs_info |
| adminCosignBrandApplication | POST /v1/admin/brand-applications/{id}/cosign | second approver for high-risk-country GLOBAL (dual approval) |
| adminCreateBrandDocumentReadUrl | POST /v1/admin/brand-applications/{id}/documents/{document_id}/read-url | signed read URL <=15 min, reason code, audited |
| adminRecordTrademarkLookup | POST /v1/admin/brand-applications/{id}/trademark-lookup | run/record trademark register lookup as evidence |
| adminResolveBrandClaimConflict | POST /v1/admin/brand-applications/{id}/conflict-resolution | resolve duplicate claim dispute |

## Funnel (shopper/anon)
| operationId | method path | meaning |
|---|---|---|
| recordOnboardingPath | POST /v1/onboarding/path | app-open choice shopper|brand (+kind); consent-aware analytics only |

Existing, reused for brand mode: see docs/specs/brand-onboarding.md section 7.
