# Seller settings (approved brand operations)

Status: implemented in `apps/api/src/modules/seller-settings`, domain rules in `packages/domain/src/seller-settings`, migration `0055_seller_settings.sql`. Closes gaps (1) to (6), (8), (9) of `docs/specs/brand-onboarding.md` section 7. Master prompt refs: section 19, B5, T4 (payouts), A2.5, T5.

## Flow
Store-scoped routes under `/v1/seller/stores/{storeId}/...` (audience `seller_api`): profile (PUT replaces), vacation, storefront-preview, media uploads (+confirm, product bulk), payout-account (+history), shipping, notification-preferences, team (+invites, members), eta-enrolment. Two self routes: `POST /v1/seller/team-invites/accept|decline`.

## Rules
- Display name Arabic mandatory. Return policy cannot be configured below the statutory minimum (14 days change of mind, 30 days defects, B5), max 90, enforced in the domain and by CHECK constraints; English policy text requires Arabic text.
- Free-delivery threshold default 200,000 piastres, bounded by the admin maximum (`PlatformLimitsPort`, default 500,000).
- Vacation requires an end (max 90 days), pauses new orders and adds ETA days; it lapses on its own (no job).
- Images: JPEG, PNG, WebP; logo 2 MB min 256 px, cover 5 MB min 1200x300, product 8 MB min 500 px. Signed PUT URL (10 min) bound to `stores/{storeId}/{slot}/{uploadId}.ext`. Confirm inspects the stored object through `UploadScanPort`: AV verdict, magic bytes and dimensions decide, never the declared type. Bulk product URLs: 1 to 20 per call.
- Payout bank account: Egyptian IBAN mod-97, holder name fuzzy-matched to the approved application legal name (explainable score, min 85, evidence codes), recent strong factor (300 s) via `StrongFactorPort`. IBAN and holder name are P3 field-encrypted; only last4 is stored in clear and returned. First account is active at once; a replacement is ACTIVE with `activates_at = now + 48 h` and the public `SellerPayoutAccountPort` reports `holdUntilMs`, so payouts to the new account stay held. Every change writes `seller_settings_events`.
- Shipping: origin (governorate, city, street, landmark, contact; phone P3 encrypted, Egypt bounding box for the pin), handling time 12 to 168 h (default 48), courier preference per governorate (Bosta default), packaging options.
- Notification preferences per event and channel; transactional events keep `in_app` (and `account_security` keeps email) and cannot be disabled.
- Team: invite by Egyptian phone, token 256-bit random, stored as SHA-256, 72 h TTL, single use; unknown token and someone else's token look identical (404). Owner only for invite, revoke, change role, remove; the last owner cannot be demoted or removed. Grants are created through `SellerMembershipsAdminPort` (seller auth owns memberships).
- ETA enrolment: status and timestamps only; credentials never touch this module (secrets belong to the SecretsPort).

## Authorization
Central policy per store (foreign store = 404): `store_settings` (owner, manager), `store_payout` (owner, manager, finance read), `store_staff` (owner write), `store_product` (bulk images). The policy's `store_settings` write rule is owner-only; this module authorises settings through the read rule and then requires owner/manager plus scope `seller:write` itself (ADR candidate: add a manager write rule to the policy). Payout bank writes additionally require owner or finance. Writes require `Idempotency-Key`; rate limits per route; Problem+JSON.

## Edge cases and failure
Optimistic version on profile and shipping (409 `version_conflict`); duplicate pending invite 409; expired invite 409 `invite_expired`; accept closes the invite before creating the grant (single use wins over retry). Production ports (identity, uploads, scan, name match, strong factor, memberships, invite delivery, ETA verifier) are Unconfigured and answer 503 until composed.

## Acceptance
Covered by `test/seller-settings.http.test.ts` (per-route 401/403/404 matrix, role splits, minimum windows, bank flow, invite lifecycle), the repository contract on in-memory and PGlite, and domain tests.
