# Brand application flow (mobile)

Spec: docs/specs/brand-onboarding.md, contract: docs/specs/brand-onboarding-contract.md. Code: `apps/mobile/src/features/brand-apply`, routes `apps/mobile/src/app/brand/**`, i18n namespace `brandApply`.

## Routes
`/brand` (gate: resumes), `/brand/type`, `/country`, `/account` (`?signin=1` for a returning brand), `/factor`, `/details`, `/documents`, `/website`, `/review`, `/status`.
- The role choice calls `router.push('/brand')`. Push / notification deep-link target: `/brand/status`. Approved: primary button pushes `/brand-mode`.
- Resumability: draft id, kind, country, brand name and current step are stored under `brand.apply.draft` (SecureStore, no PII beyond the brand name). `/brand` reloads the application; a submitted one opens the status screen. A lost session routes to `/brand/account?signin=1`; a missing application clears the draft.

## Steps
1. Type: two glass cards over full-bleed hero art. 2. Country: searchable AR/EN, flags, Egypt pinned (local brands: Egypt; global: any). 3. Account: brand name, phone, email, language, OTP (seller audience). 4. Strong factor: passkey via `PasskeyPort` when supported, else authenticator app (otpauth link + manual key), 6-digit confirm, recovery codes shown once behind a forced "I saved them" check. Returning brands assert with the TOTP code. 5. Details: generated from `getBrandRequirements` (fields as data), inline validation, debounced autosave to DRAFT (valid values only). 6. Documents: checklist cards with the slot state machine (missing, uploading with progress, uploaded, scanning, accepted, rejected with reason, needs replacement, failed with retry). Camera, photo library, files; pdf/jpg/png, <= 10 MB checked client side; sha256 declared; file names and contents never logged. 7. Website: DNS TXT (copy name and value) or email code; honest pending state. 8. Review: summary, legal declaration, blockers with Fix buttons, submit. 9. Status: Submitted, Automated checks, In review, Decision; expected time only from `decision_due_at` (overdue says so); NEEDS_INFO fix-and-resubmit; REJECTED reason, one appeal within 30 days, reapply date; APPROVED restrained welcome and "Open brand dashboard"; withdraw.

## Ports
`BrandApplyPort` (in-memory fake: dev default, code 123456 for every verification; `api.ts`: generated client with a separate in-memory seller session, used when `EXPO_PUBLIC_API_BASE_URL` is set), `PasskeyPort` (`UnsupportedPasskey` stub: "unsupported on this build" so the UI falls back to TOTP; `FakePasskey` for tests), `FilePickerPort` (expo-image-picker, expo-document-picker). Own container: `registry.ts` (`getBrandApply`/`setBrandApply`), so the shared `state/ports.ts` is untouched.
Dev only: `/brand/status?demo=needs_info|rejected|approved|IN_REVIEW` jumps the fake to that status.

## Known gaps
- No native passkey module: real passkey enrol/assert is a stub. A brand that enrolled a passkey elsewhere can only assert with TOTP/recovery on this build.
- No QR renderer or clipboard module installed: setup uses the `otpauth://` link plus manual key; Copy opens the system share sheet (it offers Copy).
- Seller tokens are kept in memory only: an app restart re-verifies the phone (draft id persists). A secure seller-token store needs a runtime hook.
- `PATCH` field-code to wire mapping is in `wire-map.ts`; requirement field codes the server invents beyond that table stay local until mapped. National ID and DOB are never read back (by design).
- Legal declaration text is a draft (VERIFY WITH COUNSEL, with the Seller Agreement section 1.2). The agreement link is not yet in-app.
- Camera/photo permission strings in app.config.ts mention reviews and returns only; wording should add brand documents.
