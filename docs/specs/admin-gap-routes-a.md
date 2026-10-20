# Admin gap routes: gift cards, subscriptions metrics, calendar

Scope: closes Admin Console Phase 2 gaps (a), (d), (f). Master prompt 15.1, 14, 17, 23.

## Flow, rules
- `POST /v1/admin/gift-cards/{id}/void` (finance, trust_safety, super_admin; passkey audience admin_api; Idempotency-Key required). Body `reason_code` (admin reason vocabulary) and optional `approval_id`. Allowed from ISSUED or DELIVERED. The unredeemed remainder is refunded to the original method (RefundRouter, key `gift-card-void:{id}`); the `gift_card.voided` outbox event (`by_admin`, `reason_code`) drives the ledger reversal of the remaining liability. At or above the refund dual-approval threshold the approval must be APPROVED, unexpired, requested by the caller, cover (refund, gift_card, id, remaining) and is consumed once (`approvalCovers`). Without a wired approval port production fails closed. Replay of a VOIDED card returns 200 `replayed: true`. Audit action `gift_card.admin_voided`.
- `GET /v1/admin/gift-cards/pots`: pots newest first with paid, pending, refunded totals and a `discrepancy` (funded_below_target, paid_after_refund, refund_failed, overdue_close) or null.
- `GET /v1/admin/gift-cards/throttle-events`: throttled redemption attempts; only 12-char references of device and network hashes.
- `GET /v1/admin/subscriptions/metrics?window_days=`: counts from stored subscriptions (active incl. trialing and past_due, paused, cancelled at period end, expired, new and ended in window). `churn_bps` is null when nothing was live at window start.
- `GET|PUT /v1/admin/calendar` (marketing, ops, passkey, admin:access): planning events (mega_event, promotion_window, drop_window, release_freeze). PUT upserts by client id; update needs `expected_version` (409 otherwise). Event row and audit row (before and after) commit in one transaction. The calendar never changes prices or starts promotions.

## Edge cases
Unknown card 404; card in other states 409 not_voidable; missing/foreign/consumed/expired approval 422 approval_required; bad cursor, limit outside 1..50, unknown fields 400; ends_at <= starts_at 400.

## Data
Migration `0060_admin_calendar.sql` (expand only): `admin_calendar_events`, `admin_calendar_audit`. PII class P1 (admin ids only).

## API, authz
Lists use opaque keyset cursors (base64url JSON {ms,id}) validated by Zod. Money is `{amount,currency}`. Wrong audience 401, missing role 403. Rows in `docs/security/authz-matrix.md`.

## Tests
gift-cards.admin.http.test.ts, store contract (listThrottledAttempts, listPotsPage), subscriptions contract (metricsCounts) and HTTP, promotions/test/calendar.test.ts (contract on in-memory and PGlite, HTTP authz).
