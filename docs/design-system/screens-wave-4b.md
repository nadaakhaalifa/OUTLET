# Screens wave 4b: Checkout, Orders, Returns, Privacy Center

Scope: spec section 7 (Checkout), section 20.1 (Orders), section 22 (Returns), section 2 (Privacy Center).
Built against ports with in-memory fakes; no live API and no PSP SDK. Nothing has been run on a
simulator or device.

## Checkout (`features/checkout`, route `/checkout`)
- One page: address (governorate, then city, street, building, floor, apartment, landmark, map pin via
  `MapPinPort`), delivery option per shipment, payment, vouchers plus store credit, review.
- Server quote is authoritative. Totals are shown from the quote; the client never zeroes a fee.
- Payment list: kill-switched methods are not rendered; unavailable methods stay visible with the
  server reason (COD cap or risk). Installment line comes only from the provider quote and always says
  "estimated from provider" with provider name, tenor, admin fee and a terms link (https only).
- Split tender: vouchers, then store credit up to the balance, remainder to one external method. When
  credit covers everything no external method is required.
- "You saved X" uses only lines with a verified reference price above the unit price; hidden at zero.
- Every fee (items, per-shipment delivery, other fees, vouchers, credit) is on the first render.
- Price change: the shopper must accept the exact delta; if the delta moves again they are asked again.
- Idempotency: a UUIDv7 key is generated once per attempt (CSPRNG required, fail closed). Taps while
  submitting or awaiting payment start nothing. A retry after a network drop with the same request body
  reuses the key; a changed body gets a new key.
- Payment goes through `PaymentLauncherPort` (fake). Card data is never entered in the app.
- After the redirect, and when resuming from Orders (`/checkout?resume=<orderGroupId>`), the server
  order-group status decides the outcome.

## Orders (`features/orders`, route `/orders`)
- List newest first; unfinished payments show "Resume payment". Detail per seller order: status, progress
  steps (named for screen readers), tracking timeline, courier and AWB, ETA.
- Cancel is offered only before SHIPPED; after that the shopper is told refusal or return applies.
- E-receipt: opens only https links; otherwise "not available yet". Return entry only after delivery.

## Returns (`features/returns`, route `/returns?line=<id>`)
- Exchange-first: for size reasons with a swap in stock, exchange is preselected above refund.
- Reason taxonomy: too small, too large, not as described, defective, changed mind, late, wrong item.
- Photos required for defective and not as described (max 5). Window counted from `delivered_at`
  using server-supplied day counts (14 change of mind, 30 defects). Ineligibility text is the server's
  Arabic and English message. Refund target choice only when the server allows more than one.

## Privacy Center (`features/privacy-center`, route `/privacy-center`)
- Consents: nothing pre-ticked, one tap to withdraw, applied to the screen before the network call.
- Export: none, requested (due date), ready (https download only).
- Deletion: blockers listed with exact counts in fixed order; forfeiture shown with explicit
  acknowledgement; after request shows the cooling end date with "Cancel the deletion".
- Sessions: current first, then most recent; sign-out only when the port supports revoke.

## Quality rules
- Money: integer piastres via `features/money-display.ts`. Dates: `formatDay` (UTC calendar day, locale digits).
- States on every screen: loading, offline, error with retry, empty, ready. Choices use 44pt rows with
  radio/checkbox roles and selected/checked state. Layout has no start/end hard-coding; text align auto.
- Copy parity AR/EN: namespaces `checkout`, `orders`, `returns`, `privacyCenter` (`pnpm i18n-check`).

## Known gaps
- Not run on a simulator; RTL mirroring, focus order and VoiceOver reading unverified.
- Map pin, PSP launcher, photo picker are fakes; real adapters are not built. Receipt/terms links use
  `Linking.openURL` directly.
- Privacy route adapter keeps export and cooling state in memory (the API has no read endpoints for
  them); sessions cannot be revoked until the API exposes DELETE /v1/me/sessions/{id} in the port.
- No live price-lock countdown (the server quote carries only the hold length); no saved addresses.
- Order cancellation and return submit use UUIDv7 keys but no Pact/contract tests exist yet.
