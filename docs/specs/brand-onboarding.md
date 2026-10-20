# Brand onboarding (shopper or brand, verification, storefront)

Template: master prompt A3. Decisions: ADR-0031. Operation list: docs/specs/brand-onboarding-contract.md. Wire: docs/api/openapi.yaml tag "Brand Onboarding". Phase 1 (Seller Center launch), mobile "brand mode" included.

## 1. Flow
1. App open (first launch, signed out): screen "I am a shopper" / "I am a brand". Choice stored on device, sent to `recordOnboardingPath` (analytics, consent-aware). Shopper -> existing section 1 onboarding. Brand -> step 2.
2. Choose **Local brand** or **Global brand**. Then country: local defaults to Egypt (EG, others allowed only if the requirements row exists, otherwise treated as global); global lists every ISO country (search, AR/EN names).
3. Create account: phone (E.164) + email, `requestSellerOtp` -> `verifySellerOtp` -> ENROL token. If the identity already has a strong factor, the next step is `sellerPasskeyAssert` / `sellerTotpAssert` using `otp_proof`.
4. Enrol a strong factor (`sellerPasskeyRegisterOptions` + `sellerPasskeyRegister`, fallback `sellerTotpEnrol` + `sellerTotpConfirm`). Drafting is allowed before this; submit is not.
5. `getBrandRequirements(kind,country)` renders the checklist. `createBrandApplication`, then `updateBrandApplication` per step (autosave), documents via `createBrandApplicationDocument` -> PUT to the signed URL -> `confirmBrandApplicationDocument`. Website ownership via `startBrandDomainVerification` / `confirmBrandDomainVerification`.
6. `submitBrandApplication` (DRAFT -> SUBMITTED). Applicant sees status screen with `decision_due_at` (5 business days) and push/email on change.
7. System: AUTO_CHECKS (scan, OCR, sanctions, trademark, domain, duplicate, signatory age, risk score) -> IN_REVIEW queue.
8. Admin (ops/trust_safety): `adminClaimBrandApplication`, reviews via `adminGetBrandApplication` + `adminCreateBrandDocumentReadUrl`, optional `adminRecordTrademarkLookup`, then `adminDecideBrandApplication`:
   - approve -> APPROVED + provisioning (section 6); high-risk global needs `adminCosignBrandApplication` first.
   - needs_info -> NEEDS_INFO with `requested_items[]`; applicant fixes and `resubmitBrandApplication` (restarts SLA).
   - reject -> REJECTED with reason code + AR/EN message + cooldown; applicant may `appealBrandApplication` once.
9. Approved brand: seller token memberships now include the new store (owner). First login shows `getSellerOnboardingChecklist` and the brand dashboard (section 7).

### State mapping (application -> kycMachine)
| Application | kycMachine | Notes |
|---|---|---|
| DRAFT | DRAFT | editable |
| SUBMITTED | SUBMITTED | locked |
| AUTO_CHECKS | AUTO_CHECKS | system running |
| IN_REVIEW | AUTO_CHECKS | checks done, human queue; admin sub-state `pending_cosign` |
| NEEDS_INFO | NEEDS_INFO | editable for requested items |
| APPROVED | APPROVED | store exists |
| REJECTED | REJECTED | cooldown, one appeal |
| SUSPENDED | SUSPENDED | via existing admin suspend/reinstate on the store |
| WITHDRAWN | (none, stays DRAFT) | application only, terminal |
Transitions: DRAFT->SUBMITTED, DRAFT->WITHDRAWN, SUBMITTED->AUTO_CHECKS->IN_REVIEW, IN_REVIEW->APPROVED|REJECTED|NEEDS_INFO, NEEDS_INFO->SUBMITTED|WITHDRAWN, REJECTED->IN_REVIEW (appeal), APPROVED->SUSPENDED->APPROVED. Anything else throws a typed `InvalidTransition` (409 `invalid_transition`). The application machine lives in `packages/domain` next to `kycMachine`, with a property test that every application transition projects to a legal kycMachine transition or none.

## 2. Rules
- Sign-up country allow-list for OTP: Egypt at launch for local; global brands phone prefixes behind flag `brand_onboarding.global_phone_prefixes` (default off until SMS pumping budget per prefix exists, otherwise global applicants sign up with email OTP fallback `channel=email`, same limits). VERIFY SMS cost.
- Signatory must be 21+ (B6, section 19) for EG; for global the age floor is the country's majority or 21, whichever is higher, using the DOB from the signatory ID check.
- Max 3 open applications per seller identity, 1 open per (normalized brand name, country).
- One approved application creates one store. Same company with several brands: separate applications, may share a store only via admin merge (out of scope).
- Required fields/docs come from `brand_requirement_sets`; baseline (editable data):
  - local EG fields: legal_name, commercial_register_no, tax_card_no, signatory (name, 14-digit national ID, DOB), contact, eta_registration (unknown|registered|not_registered), website/handles (optional). Docs: commercial_register, tax_card, signatory_id, ownership_proof (group: trademark_certificate | brand_authorization | proof_of_purchase for third-party brands). `ownership_basis` brand_owner needs the trademark certificate or registered-business evidence; authorized_distributor needs brand_authorization; third_party_reseller needs proof_of_purchase and is flagged for counterfeit review (section 27).
  - global: legal_name, company_reg_no + company_reg_country, vat_or_tax_id (optional), signatory, trademark (register + number) or distributor letter, website domain. Docs: company_registration_extract, signatory_id, ownership_proof group (trademark_registration_certificate | distributor_authorization_letter), plus website verification `required` (DNS TXT or email at the domain).
- Upload: pdf/jpg/png only, <= 10 MB, 20 docs max, sha256 declared and verified, one object per slot, AV scan before a reviewer can read.
- Decision SLA: 5 business days from SUBMITTED, `sla_breached` surfaces in the queue; NEEDS_INFO pauses SLA. Applications idle in NEEDS_INFO 30 days auto-WITHDRAWN with notice at day 14 and 27.
- Rejection cooldown: default 30 days (`reapply_after_days`, 0-365) keyed by (normalized brand name, country, seller identity and phone hash). Counterfeit/sanctions: 365 days, no appeal.
- Appeals: one, within 30 days, different reviewer, statement 20-2000 chars + optional docs.
- Reviewer != applicant: blocked when same user id, same phone hash, or the reviewer's work email domain equals the brand domain. Dual approval: GLOBAL + (country in high_risk_countries OR sanctions check warn/fail).
- Admin config (audited, dual-approved on change): requirement sets, high_risk_countries, SLA, cooldowns.
- Public store identity (B5) is projected at approve: legal_name, commercial register no (or company reg no + country), tax card (EG), governorate/country, store kind local|global. Arabic title/description for the store is mandatory before the first product publish (checklist), not for approval.

## 3. Edge cases
- **Already a shopper**: signs in to seller audience with same phone; OTP verified on both sides creates the link; seller session is separate (different token audience, refresh family). Account deletion of the shopper does not delete the seller identity; deletion of the seller identity is blocked while memberships exist.
- **Rejected then reapply**: `createBrandApplication` returns 409 `reapply_cooldown` with `reapply_after`. An appeal is not a reapply.
- **Duplicate brand claims by two applicants**: normalized name + country (and trademark number, domain) matching flags both with `duplicate_claim_application_ids`. First verified wins priority (earliest of domain_verified_at / trademark evidence matched to applicant / `submitted_at` as tiebreak); the other stays IN_REVIEW and goes to trust_safety conflict review; outcomes keep_first, replace_with_this, both_valid (distributor in another market), reject_all. Approving a brand with an open conflict is blocked (409 `claim_conflict_open`).
- **Counterfeit risk**: third_party_reseller basis, brand names matching a protected-brand list, image reuse across applications (pHash of documents/logo), trademark owner mismatch -> forced manual trademark lookup and reviewer checklist; approval of third-party reseller brands requires brand authorization or purchase proof and sets store flag `restricted_listing=true` (extra catalog checks, section 27).
- Unreadable/oversized/infected file: slot reset, applicant told with a code; infection counts toward abuse score.
- Domain: TXT lookup lag -> `pending`, retry allowed 20/h; domain owned by a free-mail/marketplace host (gmail.com, instagram.com, shopify store subdomain is allowed only with email proof) -> rejected for verification.
- Applicant edits while SUBMITTED -> 409. Withdraw during AUTO_CHECKS cancels jobs.
- Sanctioned country applicant -> application can be created but submit returns 422 `country_not_supported`.
- Network drops mid-upload: document stays `awaiting_upload`, URL expires 15 min, a new `createBrandApplicationDocument` with the same Idempotency-Key replays.
- RTL/AR: all labels and messages bilingual; Arabic is authoritative for Egyptian applicants.
- Approval race: two admins deciding concurrently -> optimistic lock on application version, loser gets 409.
- Store slug collision -> numeric suffix, never overwrite.

## 4. Data (PII classes P0 public, P1 internal, P2 personal, P3 sensitive, field-encrypted)
All new columns go into `data_inventory.yaml` (CI fails otherwise).
- `seller_users(id, phone_e164 P3-enc, phone_hash, email P2-enc, email_hash, locale, shopper_user_id nullable, strong_factor bool, status, created_at)`; `seller_credentials(seller_user_id, kind passkey|totp, ...)`, `seller_sessions` (family, device, revoke).
- `brand_applications(id, applicant_seller_user_id, status, version, brand_kind, country, brand_name, brand_name_norm, legal_name P3, registration jsonb P3-enc, trademark jsonb P2, ownership_basis, website_domain P1, social_handles P1, contact jsonb P2, signatory jsonb P3-enc (national_id enc + blind index, DOB enc), eta_registration, requested_items jsonb, decision jsonb, appeal_used, assignee_admin_id, decision_due_at, submitted_at, store_id nullable, requirement_set_version)`. Indexes: (status, decision_due_at), (brand_name_norm, country), (applicant_seller_user_id, created_at), unique partial (applicant, brand_name_norm, country) where status open.
- `brand_documents(id, application_id, requirement_code, storage_key random, content_type, size_bytes, sha256, upload_status, scan_status, review_status P3 content)`.
- `brand_domain_verifications(application_id, domain, method, token_hash, status, expires_at, verified_at)`.
- `brand_trademark_evidence(id, application_id, source, register_number, found, owner_name, status, classes, retrieved_at, raw_ref)`.
- `brand_auto_checks(application_id, code, result, detail, ran_at)`; `brand_application_events` (append-only history); `brand_requirement_sets(id, kind, country, version, definition jsonb, active)`; `brand_claim_conflicts(id, brand_name_norm, country, application_ids[], status, resolution)`.
- Retention: approved -> KYC contract+5y; rejected/withdrawn documents purged 30 days after decision, application row kept pseudonymized 24 months for cooldown/abuse; audit log per section B1.
- RLS: applicant rows by `applicant_seller_user_id` (app.current_seller_user_id); admin access through the admin module only. After approve, store data uses `app.current_store_id` as today.
- No PII in logs, traces, analytics events or error bodies; national ID never returned after submit (last 4 only).

## 5. API (full schemas in openapi.yaml; auth scope / idempotent / rate limit)
Seller auth (public via App Attest unless noted):
| operationId | Route | Scope | Idem | Rate limit |
|---|---|---|---|---|
| requestSellerOtp | POST /v1/seller/auth/otp/request | public | yes | 3/15min phone, 10/day ip |
| verifySellerOtp | POST /v1/seller/auth/otp/verify | public | yes | 10/15min phone |
| sellerPasskeyRegisterOptions / sellerPasskeyRegister | POST /v1/seller/auth/passkey/register[/options] | seller:enrol | opt / yes | 10/h user |
| sellerTotpEnrol / sellerTotpConfirm | POST /v1/seller/auth/totp/{enrol,confirm} | seller:enrol | yes | 5/h, 10/15min |
| sellerPasskeyAssertOptions / sellerPasskeyAssert / sellerTotpAssert | POST /v1/seller/auth/{passkey/assert[/options],totp/assert} | public + otp_proof | no | 20/15min ip |
Applicant (sellerBearer, scopes seller:enrol or seller:kyc.read/write; submit/resubmit/appeal/withdraw need a strong-factor token = scope seller:kyc.write only issued with amr webauthn|totp):
getBrandRequirements GET (60/min), listMyBrandApplications GET, createBrandApplication POST (5/h), getBrandApplication GET (ETag), updateBrandApplication PATCH (If-Match), submit/resubmit/withdraw/appeal POST (10/h), documents create/confirm/delete (30/h), domain-verification start (5/h)/confirm (20/h), getSellerOnboardingChecklist GET. Pagination: keyset `cursor` + `limit` (max 50), `page.next_cursor`. Errors: Problem+JSON with stable `code`; ownership via 404.
Admin (adminBearer, passkey, roles ops/trust_safety; scope admin:brand_applications.read|write): adminList/Get/Claim/Release/Decide/Cosign/CreateBrandDocumentReadUrl/RecordTrademarkLookup/ResolveBrandClaimConflict, 120/min per admin. `adminDecideBrandApplication` and `adminCosignBrandApplication` require Idempotency-Key and JIT elevation for cosign.
Funnel: recordOnboardingPath POST /v1/onboarding/path (public, 30/min ip, 204).
Stable problem codes: strong_factor_required, checklist_incomplete, document_pending_scan, document_infected, reapply_cooldown, invalid_transition, reviewer_is_applicant, already_claimed, claim_conflict_open, cosign_required, cosign_same_admin, country_not_supported, domain_not_verified, appeal_not_allowed.

## 6. Events
Outbox (domain): `brand_application.created`, `.submitted`, `.checks_completed`, `.claimed`, `.needs_info`, `.resubmitted`, `.approved` (carries store_id, owner seller_user_id), `.rejected`, `.withdrawn`, `.appealed`, `.suspended`, `brand_document.scanned`, `brand_domain.verified`, `brand_claim_conflict.opened/resolved`, `store.provisioned`, `seller_user.registered`, `seller_user.linked_to_shopper`.
Provisioning consumer on approved (single tx, idempotent by application_id): create store (kind, slug, status active, legal identity projection), owner membership + grants, `seller_onboarding_checklist` rows, set application.store_id; then notifications consumer sends in-app + push + email (AR/EN templates `brand_application_approved|rejected|needs_info|received`), WhatsApp optional with consent. Transactional messages need no marketing consent. The seller token picks up the membership on next refresh (`/v1/auth/refresh` with seller audience reloads grants); app polls `getBrandApplication` or reacts to the push.
Analytics (Zod-typed, consent-aware, no PII): `brand_path_selected(path, brand_kind?, country?)`, `brand_application_started(brand_kind,country)`, `brand_application_step_completed(step)`, `brand_application_submitted(brand_kind,country,doc_count)`, `brand_application_needs_info(reason_codes)`, `brand_application_approved(brand_kind,country,days_to_decision)`, `brand_application_rejected(reason_code)`, `brand_first_product_published`. Add to docs/analytics/events.md.

## 7. Brand dashboard API surface (existing, with operationIds)
Store/profile: getSellerStore, updateSellerStore, getSellerKyc/updateSellerKyc/submitSellerKyc/createKycDocumentUpload (legacy, see gaps), listSellerTeam, inviteSellerTeamMember, removeSellerTeamMember, sellerMe.
Catalog: listSellerProducts, createSellerProduct, getSellerProduct, updateSellerProduct (status draft/active/paused handled here, no separate publish op), updateSellerSkuPrice, updateSellerSkuStock, listSellerSizeCharts, createSellerSizeChart, getSellerSizeDemand, createSellerCatalogImport, getSellerCatalogImport, connectSellerChannel, listSellerChannels, disconnectSellerChannel.
Orders: listSellerOrders, getSellerOrder, acceptSellerOrder, rejectSellerOrder, packSellerOrder, createSellerShipment, getSellerShipment, getSellerShipmentLabel, listSellerReturns, inspectSellerReturn, sellerListHubConsolidations.
Marketing: listSellerPromotions, createSellerPromotion, getSellerPromotion, updateSellerPromotion, deleteSellerPromotion, listSellerDrops, createSellerDrop, getSellerDrop, updateSellerDrop, deleteSellerDrop, scheduleSellerDrop.
Price integrity: listSellerPriceClaims, appealSellerPriceClaim, getSellerPriceTrust, uploadSellerPriceEvidence.
Finance/analytics: getSellerBalance, listSellerPayouts, getSellerPayout, listSellerStatements, getSellerStatement, getSellerInvoices, getSellerInvoicesByDocumentId, getSellerAnalyticsSummary, getSellerStoresByStoreIdAnalytics* (aging, funnel, geography, returns, sales, search-terms, sell-through, size-curve, traffic), postSellerStoresByStoreIdAnalyticsExports, sellerStylistInclusion, getSellerQuestions/postSellerQuestionsByQuestionIdAnswer, getSellerReviews/postSellerReviewsByReviewIdReply.
**Gaps** (not in openapi; owners to add later, not in this change): (1) public storefront read for a brand store by slug in the marketplace is covered by Stores/Catalog buyer endpoints, but a seller-side "preview my storefront" is missing; (2) store logo/cover upload slot (needs a signed-upload op like documents); (3) payout IBAN set/verify (name match) for the seller (checklist item add_payout_iban; only payout reads exist); (4) shipping origin / pickup address set; (5) bulk image upload; (6) ETA credentials enrolment for e-receipts; (7) legacy /v1/seller/kyc* overlaps with applications: keep them for the post-approval store KYC refresh (annual re-verify) and mark `x-deprecated-for-onboarding`; the new applications resource is the onboarding path. (8) notification preferences for sellers. (9) seller-side team invite acceptance flow (accept link). 

## 8. Failure handling
- Upload/confirm: timeouts 10 s, retry idempotent x3; scan worker retries with backoff+jitter, DLQ after 5, applicant sees "checking" and the reviewer queue shows scan error (never readable).
- Trademark/sanctions/OCR ports down: check result `error`, application still reaches IN_REVIEW with the check flagged; admin can re-run. Fail closed: no auto decision.
- OTP provider down: failover per section 1 (second SMS provider, WhatsApp, email for global).
- Provisioning failure: tx rollback, application stays IN_REVIEW with `provisioning_failed` alert; admin retry is idempotent by application_id; applicant is never told "approved" before commit.
- Notification failure: provider failover, in-app always written in the same tx via outbox.

## 9. Security and abuse
- AuthZ: applicant objects by owner (404 otherwise), admin by role; deny by default; mass-assignment DTO allow-lists; BOLA negative tests on every `{id}` route (seller A -> seller B application = 404; shopper token on seller route = 401 wrong audience; seller token on admin route = 401; ops without scope = 403).
- OWASP API: API2 (strong factor, OTP limits, lockouts), API4 (size/count caps, 10 MB), API6 (OTP/SMS pumping: prefix allow-list, budget caps, attest; application spam: 5 creates/h, 3 open), API7 (domain verification SSRF guard, no URL fetch from user input beyond the DNS lookup of a validated registrable domain; no document URL fetch), API8 (CORS strict), API10 (port responses schema-validated).
- Documents: no PII in object keys/logs, private bucket, signed URLs <= 15 min, reader audited with reason code, EXIF stripped on image re-encode for derived thumbnails only (originals kept for evidence, encrypted at rest SSE-KMS), AV scan, content sniff, PDF active content blocked.
- Applicant lockout cannot enumerate brands: duplicate-claim data is admin only; applicants get a generic `duplicate_claim` only after submit.
- Reviewer integrity: claim audit, dual approval, reviewer != applicant, no self-approval via linked identities, decisions append to the hash-chained audit log with before/after (PII redacted).
- Phishing of brand owners: the TXT token is per application, 7 day expiry, hashed at rest.
- LLM use (OCR extraction, summaries) via llm-gateway: document text is untrusted data (LLM01), no P3 to external models without cross-border consent (B1), outputs advisory only.
- Privacy: DPIA entry for KYC documents; consent at sign-up for processing of identity documents (purpose `seller_kyc`, lawful basis contract/legal); DPA acceptance version-stamped.

## 10. Metrics
Product: path choice split, start->submit conversion (target >= 60%), time-to-submit median, time-to-decision p80 <= 5 business days, approval rate by kind/country, NEEDS_INFO loop count, appeal overturn rate (<10%), first-product-published within 14 days of approval (>= 50%). SLI/SLO: requirements read p95 < 300 ms, document confirm->scan clean p95 < 2 min, SLA breach rate < 5%. Guardrails: counterfeit takedowns per approved brand cohort, post-approval suspension rate in 90 days, SMS cost per verified seller.

## 11. Acceptance (Gherkin)
- Given the app first opens, when the user taps "I am a brand", then choosing Local defaults country to Egypt and choosing Global lets any country be selected.
- Given a verified OTP and no strong factor, when the applicant calls submit, then 422 `strong_factor_required` and no state change.
- Given a local EG requirements row, when a required document is missing, then submit returns 422 with errors pointing at its requirement_code.
- Given a 12 MB or exe file declared, when createBrandApplicationDocument is called, then 422 and no upload URL.
- Given an infected scan result, then the document slot resets and a reviewer cannot obtain a read URL (409).
- Given a global application with a TXT record present, when confirm is called, then domain_verified_at is set and the auto check domain_verified passes.
- Given an admin who is the applicant (same phone hash), when claiming, then 409 `reviewer_is_applicant`.
- Given a GLOBAL brand from a high-risk country, when admin A approves, then no store exists until admin B cosigns; B == A gets 409 `cosign_same_admin`.
- Given needs_info with two requested_items, when the applicant resubmits without satisfying one, then 422; when satisfied, status is SUBMITTED and the SLA restarts.
- Given a rejection with cooldown 30 days, when the applicant creates the same brand+country in 10 days, then 409 `reapply_cooldown`.
- Given two applicants claiming the same normalized brand, when the first verifies its domain, then the second is queued for conflict review and cannot be approved until resolved.
- Given an approved application, then within one transaction a store with the application's kind exists, the applicant is owner, `brand_application.approved` is in the outbox, and the applicant receives in-app + push + email in AR or EN per locale; replaying the consumer creates no second store.
- Given seller A's token, when GET /v1/seller/applications/{B's id}, then 404 identical to a missing id.
- Given a shopper who becomes a brand owner, then shopper and seller sessions are independent: revoking one does not revoke the other.
- Given consent for analytics is not granted, then `brand_path_selected` is not stored.
- Replaying approve with the same Idempotency-Key returns the stored response and creates no second store; a different body with the same key returns 422.

## 12. Implementation split (suggested, for parallel agents)
(1) packages/domain: application machine + tests. (2) sellers module: seller identity/auth controller, token audience handling (reuse auth-core), applications + requirements + documents + domain verification + provisioning use case, ports (`DocumentStorePort`, `MalwareScanPort`, `TrademarkRegistryPort`, `SanctionsScreenPort`, `DomainProofPort`). (3) admin module: BrandApplicationAdmin review use cases. (4) stores: `ProvisionStore`. (5) notifications templates. (6) mobile: path chooser + brand wizard; web: Seller Center onboarding + Admin queue. Each new route needs a row in apps/api/test/authz-matrix.test.ts (DELEGATED to the owning module) and docs/security/authz-matrix.md when it is registered; this change adds none because no route is registered yet.
