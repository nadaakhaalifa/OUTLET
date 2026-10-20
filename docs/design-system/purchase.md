# Purchase screens (bag, checkout, orders, returns, wishlists)

Built on the foundation: hairline sections with tracked step eyebrows (`features/purchase/Section`), placeholder art thumbnails (`ItemArt`, silhouette chosen from the title by `art-kind.ts`), hairline `Choice` rows (ink radio/checkbox), glass `StickyBar` footers and `BottomSheet` pickers. Emerald marks only real savings or price drops, coral only errors and unavailable states, gold only the Plus nudge.

## Bag (tab)
- Lines grouped by store; thumbnail, size, line total, `QuantityStepper` (1..10, spec §6), save for later, remove.
- Honest movement: "dropped by X / rose by X since you added it" (both directions).
- Per store `ProgressBar` and "add X to unlock free delivery"; threshold from the store config; Plus shows "free with Plus".
- In-size suggestions rail (add through the same `BagPort.addLine`), sold-out / paused / suspended-store states (locked, excluded from total).
- Sticky glass footer: total + Checkout. New port methods: `setQuantity`, `removeLine` (API: `updateCartLine` qty with If-Match, `removeCartLine`).

## Checkout (one page)
1 address (saved addresses from `listAddresses` via new `AddressesPort`, or governorate -> city sheet pickers, landmark, map pin port), 2 delivery per shipment with item thumbnails, 3 payment (server availability: kill-switched hidden, unavailable shows the server AR/EN reason, installment line only from the provider quote and labelled "estimated from provider"), 4 vouchers and Z-OUTLET credit split tender, 5 review (every fee on first render, "You saved" from verified savings only, Plus nudge from `plus_savings`). Price-change re-confirmation, Idempotency-Key duplicate-tap protection, drop admission handoff and resume-from-Orders are unchanged logic. Success: check illustration, order number, what happens next (COD variant).

## Orders
Filter chips (All / In progress / Delivered / Closed), thumbnail strips, status badge (headline status is the least advanced active seller order), per-seller vertical timeline and courier tracking, cancel before shipped behind a confirmation sheet, e-receipt (https only), return entry per delivered line.

## Returns
Single flow: reason taxonomy, exchange-first resolution, refund target, photos (expo-image-picker, upload through `PhotoUploadPort`, submit blocked while uploading/failed), method; eligibility message from the server in AR/EN; windows from `delivered_at`.

## Wishlists
Intent lists, real 24h cool-off on Want lists (via port), budget bar with left/over, delisted ghost items with Find similar (search), share link create/send/revoke, new list in a glass sheet.

## Dev preview
`/__purchase?s=bag|checkout|success|orders|returns|wishlists&lang=ar|en&theme=light|dark/system` forces language, direction and theme (dev only).

## Screenshots
`docs/design-system/screenshots/purchase-*.png` (bag EN light and AR dark, checkout EN light and AR light, success, orders, returns AR dark, wishlists dark).

## Open gaps
See `docs/plan/api-client-gap.md` "Purchase screens": no shopper signed-upload operation, no address create/edit, no cart sold-out vs paused, no return-eligibility preview.
