# Mobile navigation

Source: `apps/mobile/src/features/navigation/model.ts` (pure, tested), `src/app/(tabs)/_layout.tsx`, `src/app/(tabs)/me.tsx`.

## Tabs
Home, Discover (worlds; route `explore`), Saved (wishlists), Bag, Profile (route `me`), in that logical order (ADR-0044). The stylist is not a tab: it is reached from the Discover "Style me" row and the Profile row, route `/stylist`. The platform mirrors the bar in RTL, so Home sits on the right in Arabic; there is no manual reversal (reversing would double-flip). Each tab sets `tabBarAccessibilityLabel` and `tabBarButtonTestID` (`tab-home`, `tab-discover`, `tab-saved`, `tab-bag`, `tab-profile`); selected state comes from the navigator's tab button.

## Me menu
Orders, Z-OUTLET credit (wallet, closed loop), Budget, Wishlists, Size profile, Plus, Rewards, Gift cards, Privacy Center, Help, Settings. The list has `accessibilityRole="list"`; each row is a button with its title as the name (Plus adds a hint).
- Gift cards is shown only when `giftVisibility(capabilities).visible` is true. While capabilities are unknown (loading or failed) the row stays hidden, matching the Gift Cards screen.
- Cancel Plus: Me, Plus row (tap 1), Cancel (tap 2). The Plus screen shows Cancel for members without a confirm-shaming step.

## Flows wired
- Bag: checkout CTA (`bag-checkout`) pushes `/checkout`.
- PDP: add-to-bag calls `BagPort.addLine`; save-with-intent calls `WishlistsPort.saveItem`. Both come from the shared container, so the Bag and Wishlists screens see the change.
- Stylist: `addOutfit` validates through the stylist port, then writes each accepted item through `BagPort.addLine`.
- Drops: the drop screen holds the admission token in memory and pushes `/checkout?drop=<id>`; checkout takes it once with `takeAdmission(dropId)` (kept for retries, never in the URL). A missing token disables Place order with an explanation.
- Checkout: "Plus would save you X" appears only when the server quote carries `plusSavings > 0` for a non-member. The app never computes it.
- Search results open `/product/<id>`; Orders rows open Returns for a line (`/returns?line=`).

## Services container
`src/state/ports.ts` holds every feature port. Screens use `props.port ?? getFeaturePorts().<x>`. Development builds use the in-memory fakes; a real API client calls `setFeaturePorts(...)` once at startup. Nothing else changes.

## Accessibility notes
Roles: tab buttons (navigator), list and button rows, radiogroup for worlds with `selected` state, progressbar for free delivery. Unverified on device: VoiceOver reading order in RTL, tap-through of `TestId` wrappers.
