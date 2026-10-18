# Seller Center web: onboarding and store settings

Status: implemented in `apps/seller-web`. Contracts: `docs/specs/brand-onboarding.md`, `brand-onboarding-contract.md`, `seller-settings.md`. Master prompt refs: section 19, B1, B5, T5, A2.

## Flow
1. `/login`: phone OTP (`requestSellerOtp`, `verifySellerOtp`) then the strong factor. Passkey through `navigator.credentials.create/get` with options from `sellerPasskeyRegisterOptions` / `sellerPasskeyAssertOptions`; TOTP (`sellerTotpEnrol` + `sellerTotpConfirm`, `sellerTotpAssert`) when WebAuthn is unsupported or chosen. TOTP shows a locally generated QR (no third-party service), the manual key, and 8 recovery codes once; continuing requires ticking the acknowledgement.
2. Tokens: the enrol token and `otp_proof` live in the httpOnly `sc_enrol` cookie (never in JS); the full session lives in `sc_session`. The enrol token can drive `/apply*` only; the proxy rejects it elsewhere.
3. `/start` routes: no store -> `/apply` (or the open application); store with open required checklist items -> `/onboarding`; else `/dashboard`.
4. `/apply` and `/apply/[id]`: kind, country, brand name; details form generated from `getBrandRequirements` (unknown requirement codes are surfaced, never dropped); documents with SHA-256 and signed-URL PUT with progress; domain verification (DNS TXT or email code); review with acknowledgements and submit. Non-editable applications show the timeline, decision reason, reapply date and appeal. NEEDS_INFO shows requested items and resubmits only when all are satisfied.
5. `/onboarding`: `getSellerOnboardingChecklist` as a progress-tracked guide, next step chosen by role.
6. `/settings/{profile,returns,delivery,payout,shipping,team,notifications,eta}`.

## Rules enforced in the UI (server re-validates, domain is authoritative)
- Return policy: change of mind >= 14 days, defects >= 30 days, max 90; English text needs Arabic text.
- Free-delivery threshold: EGP input converted to integer piastres; platform maximum is enforced by the API.
- Vacation: end required, within 90 days, extra ETA 0..60 days, Cairo time.
- Payout: Egyptian IBAN (29 chars, mod-97); only the masked value is displayed; name-match result and 48 h hold notice are shown; a `strong_factor_required` problem sends the user to re-verify (`/login?stepup=1&next=...`).
- Team: owner-only mutations; the last owner cannot be demoted or removed; self-removal blocked.
- Notifications: transactional events keep in-app (and account security keeps email); locked cells are not sent.

## Concurrency and idempotency
Every write form carries a client-generated UUID `Idempotency-Key` (a double submit is a replay; rotated after success). Profile and shipping forms carry the loaded `version`; the action re-reads the profile and refuses to write when it moved (409 style message), and the server's own `version_conflict` is mapped to the same message. Application PATCH sends `If-Match` with the ETag from the GET.

## Security
Zod at the API boundary, strict CSP with nonce (no inline scripts or style attributes), upload origins are an explicit `SELLER_UPLOAD_ORIGINS` allow-list added to `connect-src`, open-redirect guard on `next`, no PII in console logs, tokens only in httpOnly cookies, 401 -> re-auth, 403/404 explained, offline state.

## Gaps and assumptions (see verify register)
- Step-up has no dedicated endpoint: re-verification repeats phone OTP + factor (OTP proof is required by the assert endpoints).
- Governorate list is ISO 3166-2:EG codes; there is no city list endpoint, so the city code is a slug input.
- Seller Agreement and DPA versions stamped on submit are draft constants (`draft-2026-10`) pending counsel.
- Requirement field codes are mapped by name (`META` in `view-models/application-form.ts`); a new code needs a mapping.
- The `/v1/seller/stores/{storeId}/...` settings routes are documented as free-form objects in OpenAPI; schemas here follow the controller Zod.
