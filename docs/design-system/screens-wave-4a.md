# Screens wave 4a: Product page, Search, Wishlists, Size profile

Scope: spec sections 5, 4, 8 and 10. Built against ports with in-memory fakes. No live API; nothing
has been run on a simulator or device. Each feature has a pure `model.ts` (view model, validation, port
interface, fake) and a `*Screen.tsx`, following `features/worlds` and `features/bag`.

## Routes (apps/mobile/src/app)
- `product/[id].tsx`, `search.tsx`, `wishlists.tsx`, `size-profile.tsx`. Tab layout and entry links
  (Explore search button, Me menu) are not wired yet.

## Product page (`features/pdp`)
- PriceBlock shows the reference price and percent only when the port returns a claim AND the integer
  floor percent computed on the client is at least 5 and the price is below the reference. No claim: plain
  price. "Launch price" only for listings flagged as launch with no claim. Never a strike-through otherwise.
- Size selector (radio group). "Your size: M (91% confidence)" from the port; below 0.6 it says "not sure".
- Community fit with its count, shown only from 20 buyers. Stock text only when 5 or fewer in a size.
- Seller legal identity (legal name, commercial register, tax card, governorate), delivery ETA range,
  return eligibility (14/30 days or non-returnable), defect note for minor-defect items.
- Add to cart needs an in-stock size; paused or sold out disables it and offers "Notify me". Save with
  intent opens the eight intents.

## Search (`features/search`)
- Query normalised (Eastern digits folded, collapsed spaces, 100 char cap). Suggestions from the port.
- Filter sheet: budget (EGP whole numbers to piastres), my size, verified discount only, condition
  (4), installments and store credit. Live count from `SearchPort.count`. Installment amounts are never
  computed here.
- "Sponsored" label; at most 2 sponsored in the top 10 enforced client-side as a second line of defence.
- Zero results: least important filter is dropped one at a time (installments, credit, condition, my
  size, verified, budget) and the banner names what was removed. Nothing left: empty state with clear.
- Discount badge only with a verified percent of at least 5.

## Wishlists (`features/wishlists`)
- Eight intents, list budget with honest left/over, target date, gift lists need nickname and occasion.
- Cool-off (Want lists only, opt-in): Buy becomes "Remind me tomorrow"; the first tap starts a real 24h
  window stored through the port; Buy returns after it elapses. No invented countdown.
- Share link create and revoke; expired or revoked links show as inactive.
- Delisted items stay as ghosts with "Find similar" (action is a no-op until search deep-link exists).

## Size profile (`features/size-profile`)
- Guided wizard over 15 measurements with AR/EN tips, skip per step, back, review. Values are stored as
  integer tenths. Eastern digits and decimal comma accepted, one decimal place.
- Plausibility ranges per measurement; waist above 250 cm is rejected (250 allowed); cross-field checks
  (under bust vs bust, high hip vs hip, foot width vs length) block save.
- Quick start (height, optional weight, usual size), "Measure later" (empty profile), multiple profiles
  (me, partner, child). Child profiles hold a nickname and measurements only; the type has no DOB or photo.
- Fit preference and modest fit. Copy states that sellers never see measurements.

## Quality rules
- Money is bigint piastres via `features/money-display.ts`; counts and percents use `localizeDigits`.
- States: loading, offline, error with retry, empty, ready on every screen; action failures as banners.
- 44pt targets via ui-native components and the shared `search/Chip`; accessible names on chips, size
  options (with stock), action buttons (with item name); progress/live count uses a polite live region.
- Reduce Motion: no animations used. RTL: only flex/wrap and `textAlign: auto` layout.
- No counters, timers, reviews or discounts are produced client-side; all come from the port.
- Copy parity AR/EN in namespaces `pdp`, `search`, `wishlists`, `sizeProfile` (`pnpm i18n-check`).

## Known gaps
- Not run on a simulator; layout, RTL mirroring, and screen reader behaviour are unverified visually.
- No real gallery (placeholder with accessible name), no size chart sheet, no Q&A or reviews list, no
  price-history sparkline or "how we verify" detail screen, no share/referral action.
- Search has no pagination UI (cursor is carried, not consumed), no saved searches, no voice, no NL parse.
- Add to bag and save-with-intent talk to PdpPort only; they do not yet call the Bag or Wishlists ports.
- Wishlists: no add/remove item UI, no edit list, no date picker (ISO text field).
- Size profile: no edit of an existing profile, no printable paper tape, no photo estimation (Phase 3),
  no `measurements` consent gate (belongs to the ML feed, not the on-device profile).
- Cool-off "Buy" and "Find similar" actions are no-ops until checkout and search deep links exist.
- Legal copy and Arabic strings need native review (add to the Arabic review pack).
