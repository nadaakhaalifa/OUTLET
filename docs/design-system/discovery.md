# Discovery screens (Home, Discover, Search, Product page)

> 2026-10-15: tabs are Home, Discover, Saved, Bag, Profile (owner's board, `design-board-v4.md`). Explore is now Discover; Stylist is no longer a tab and is reached from Discover and Profile.

Built on the foundation (`foundation.md`). Logic lives in `features/<x>/model.ts`; screens are thin.

## Home (tab 1) `features/home`
Board v4: hero, two entry buttons (Shop Everything, View Stores), promo banner (AD only if sponsored), Shop by Category tiles. Prices in EGP; discount pills only for verified claims.
- Full-bleed hero (HeroArt placeholder via FullBleedHero) with a glass caption. The countdown exists only for a drop with a real future start, ticking from SERVER time (`useServerNow`: offset fixed at load). No start, no timer.
- Glass worlds switch (Local / Global / All / My Stores), persisted per device (`worlds.selection`), horizontally scrollable, 12pt segment padding. Hidden suspended favourites are explained; empty My Stores offers one-tap widen.
- Rails: New drops, Biggest verified discounts (only claims that pass `claimOf`: reference > price, percent = floor, >= 5), For you (hidden entirely when the server says personalization is off), Ending soon (server time, within 72 h), Stores (StoreCover/StoreAvatar), then the edge-to-edge 2-column grid. Skeleton loading, pull to refresh.
- Port: `HomePort` (in-memory fake; `ApiHomePort` composes listPublicDrops + search + getFeed). Gaps in `docs/plan/api-client-gap.md`.

## Discover (tab 2, was Explore) `features/worlds`
Entry point to the Stylist and to the stores flow (Online/In-store, Local/Global/Both, list, store collection). The Saved tab (tab 3) holds wishlists.

Editorial category tiles (CategoryIcon + ProductArt, one wide tile then pairs, `tileRows`), glass sort/scope bottom sheet with a live store count, store directory with covers. Tapping a category or store opens Search with that query.

## Search `app/search.tsx`
Glass overlay header with the field, filters and close. Empty field: device-only recent searches (max 8, clear) plus category chips. Typing: instant suggestions (queries, stores, categories). Filter sheet (budget, my size, condition, verified only, installments, store credit) with live count. Results grid, "Sponsored" label (max 2 in the top 10, `arrangeResults`), zero-result relaxation message.

## Product page `features/pdp`
Paged full-bleed gallery with a glass page indicator (pinch/zoom is a placeholder: `zoomHint` only), seller chip with legal identity disclosure, PriceBlock (claim only when verified, "Launch price" variant), "Your size: M (91%)", SizeSelector, community fit only when >= 20 buyers, real stock only when <= 5, delivery and returns, "Complete the look" rail (`completeTheLook`), sticky glass bar (Add to cart, Buy now), save with intent sheet, share.

## Verified / not
Verified on the iOS simulator in light and dark (English). Arabic is covered by key parity and start/end styling but was not photographed: the shared simulator was driven by other sessions and the app language could not be switched reliably.

> Owner override (2026-10): Home hero auto-advance is 10 s (was 7 s in the master spec), slide transition 700 ms ease in-out, hero height 34% of window clamped 240-320pt.
