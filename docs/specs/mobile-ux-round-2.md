# Spec: mobile UX round 2 (iOS)

- Status: Draft for builders. Phase: post-Phase-3 polish on fixtures. Nothing here touches real money, personal data or providers.
- Date: 2026-10-16. Owner requests 1-9. Checkout override: ADR-0053 (Accepted).
- Sources read: CLAUDE.md, `docs/design-system/ux-principles.md`, master prompt sections 3, 4, 5, 6, 7, 8, 12, 13, 18 and 25, `reports/Fashion listing filters benchmark.md` (the "benchmark"), `reports/Viral store recommendations home.md`, the current code under `apps/mobile/src/features/*`, and `packages/ui-native`.

## Status and decisions (updated 2026-10-18)
**Owner answers to section 13.**
- Item 7: three tiles per row (not three tabs).
- Brand filter: lists stores for now (brands when real product brand data exists).
- WP-API (facet counts, server sort, brand field) approved. Search already exposes `facet_counts` in the search module; confirm per-option filter counts, server `sort` and `ProductSummary.brand` against `docs/api/openapi.yaml` before closing.
- Sort lives inside the filter sheet as its first section.
- Guest rules: the owner overrode the account-first order; see ADR-0055 and `docs/specs/guest-browsing.md` (sign-up only at the Checkout gate, device-only bag and saved items, merge keeps the larger quantity, TTLs bag 30 days idle, saved 180 days, viewed 30 days).
- iPad zoom history (ADR-0054): 1.25x, then 1.75x ("way more zoomed in"), 1.25x ("too zoomed in"), 1.5x, then 1.725x as a continuous ramp from 600 pt (`IPAD_ZOOM = 1.725`, the maximum).
- Entrance page: bespoke iPad layout for the role chooser (`/role`) only; other bespoke iPad screens are later proposals.

**Built.** WP-1 Foundations, WP-2 Checkout (resume key in SecureStore, not MMKV), WP-3 Listings, WP-4 Home, WP-5 Discover, WP-6 Saved. Maestro flows 09 to 12 exist for them.

**Known gaps.** Questions 1, 3, 6 and 8 of section 13 (the "and also when i" message, Discover title, Shop all chip row, Saved Add to bag size behaviour) are not recorded as answered here; defaults in section 13 apply. Per-option filter counts and brand data depend on WP-API completion. The checkout quote still has no delivery options or coverage on the wire (`docs/plan/api-client-gap.md`). `supportsTablet` stays off (ADR-0054).

## 0. Rules for every item
- Arabic first. Every new string has AR and EN keys (parity CI). Layout uses logical start and end, and directional icons use `directional`. No item may break `08-rtl-critical-path`.
- States: loading uses the kit `Skeleton`/`LoadingState`. Empty uses `EmptyState` with one action. Errors use `ErrorState` with retry, and offline uses `ErrorState offline`. No state is ever blank or faked (rule 7).
- Dynamic Type: text uses kit `Text` variants. Rows wrap to two lines; nothing is truncated to one line except product titles (2 lines). Test at the largest accessibility size.
- Reduce Motion: only the kit motion helpers (`Reveal`, `Settle`, `Flow`, `PressScale`) are used. Sheets and accordions open without animation when Reduce Motion is on.
- Honesty (rule 12, section 18): no fake stock, timers, counts, discounts or social proof. Sponsored items carry the label. Budget data (section 12) never reaches ranking, promotions or any server-side personalisation call.
- Analytics: everything goes through `ClientAnalytics` and is consent-gated (`analytics`). No PII and no free text in properties. New events are added to `packages/analytics/src/analytics-events.ts` and `docs/analytics/events.md` (WP-1).
- Design gate: `node tooling/design/check-debt.mjs` must pass with no file growing. New files must be lint-clean, with no raw `TextInput`/`TouchableOpacity`, no hex colours and no raw font sizes in screens. Each WP runs `--update` after it shrinks a baseline file (for example `checkout/Choice.tsx`, `home/banner.tsx`).

## 1. Checkout as step pages (ADR-0053)
**Flow.** Bag -> `/checkout` (Delivery: saved or new address, then a delivery option per store shipment) -> Continue -> `/checkout/payment` (method list with availability reasons, installment line from the provider quote, vouchers with auto-best, store credit toggle, gift card) -> Continue -> `/checkout/review` (address summary, shipments, method, full totals, `You saved X`, price-delta re-confirmation, Place order) -> the existing done, awaiting-payment and Fawry states.
A step indicator (kit `StepIndicator`) shows Delivery, Payment and Review. Completed steps can be tapped to go back.

**Rules.**
- The `CheckoutSummaryBar` (sticky footer on every step) shows the total and a "Details" disclosure. The disclosure lists merchandise, delivery per store, every `quote.fees` line, the voucher, store credit and the payable amount, all from `computeTotals`. No fee may appear for the first time on Review. A method fee shows on the method row the moment it is in the quote.
- `You saved X` appears only when `totals.verifiedSavings > 0n`, on Review and in the details.
- Continue is enabled only when the step's blockers are clear. Delivery checks `address` and `delivery`; Payment checks `paymentMethod` and `methodUnavailable`; Review checks `reconfirm`, `emptyBag` and the admission token. Add a pure `stepBlockers(step, q, sel, delta)` built from the existing `placeBlockers`, without changing it.
- Idempotency key, fingerprint, duplicate-tap guard, resume and drop admission are unchanged and live in `CheckoutSessionProvider`.
- Resume uses a SecureStore key (`services.storage`, as built in WP-2; not MMKV) `checkout.session.v1:{bagFingerprint}`, holding `{step, savedAddressId, delivery, paymentMethodId, voucherCodes, useStoreCredit, savedAtMs}`. It is discarded after `priceLockSeconds` or when the bag changes. Typed address fields are never written to disk.
- Back moves to the previous step and keeps choices. Back is blocked while `submitting` or `awaitingPayment`; a banner explains why and offers "View orders".
- A COD selection on Payment that makes the address need a pin or landmark sends the shopper back to Delivery with the field highlighted. `validateAddress` already takes `codSelected`.

**Edge cases.** A quote that fails on any step shows `ErrorState` with retry, and the selection is kept. Offline: Continue still works between steps on the cached quote, but Place order shows an offline error. If the price lock expired before Review, re-quote and, if the delta is non-zero, show the existing re-confirm block. An empty bag mid-flow shows the empty state on whichever step is open. A method that becomes kill-switched between steps drops the selection, and Review sends the shopper back to Payment. RTL: the step indicator and the Continue chevron mirror. Dynamic Type: the summary bar wraps the total onto a second line.

**Data/API.** No new endpoints. Known gaps stay as documented (`docs/plan/api-client-gap.md`: the quote has no delivery options or coverage on the wire).

**Analytics.** `checkout_started` (existing, on Delivery mount), new `checkout_step_viewed{step, store_count}`, new `checkout_step_completed{step, ms_on_step}`, and `payment_selected` (existing).

**Acceptance.**
- Given a three-store bag, when Delivery first renders, then the details list every delivery fee and every quote fee, and the total equals the Review total for the same selection.
- Given verified savings of 0, then no "You saved" line appears on any step.
- Given a double tap on Place order, then one OrderGroup is created (flow 05 still green).
- Given the shopper is on Review and goes back to Payment, changes the method and continues, then Review shows the new method and an updated total, with no new idempotency key until Place order.
- Given the app is killed on Payment within the price lock, when checkout reopens, then it opens on Payment with the same choices, and typed address text is not restored.
- In Arabic, the steps read right to left and the edge swipe goes back one step.

**Files.** Remove `app/checkout.tsx`. Add `app/checkout/_layout.tsx`, `index.tsx`, `payment.tsx` and `review.tsx`. Split `features/checkout/CheckoutScreen.tsx` into `CheckoutSession.tsx` (provider), `DeliveryStep.tsx`, `PaymentStep.tsx`, `ReviewStep.tsx`, `SummaryBar.tsx` and `DoneStates.tsx`. Change `model.ts` (add `stepBlockers`, `CheckoutStep`, `sessionSnapshot`/`restoreSession`), `Choice.tsx` and `checkout.test.ts`. Update `.maestro/subflows/place-order.yaml` and `flows/05`, `08`.

## 2. Category window with real subcategory counts
**Flow.** Tapping a department or category (Home `DepartmentGrid`, the Discover department avatars, the Discover category tiles) opens a `CategoryWindow` bottom sheet in place. It shows the category name, "See all in {name}" as the first row, then the child categories from `GET /v1/public/categories`, each with an item count when one is available. Tapping a row opens Shop all with `category`/`department` params. The sheet closes on back or swipe-down.

**Rules.** A count is shown only when it comes from the API for the current world and store scope. With no count, the row has no number. It never shows "0+", "many" or a guess. A child with a confirmed count of 0 stays visible but is disabled with "No items right now" (layout stability, benchmark). Children are ordered by `position`.

**Options for counts (choose 1 now, 3 next).**
1. No counts until the API provides them (chosen for the client now). Cost and complexity are zero, accuracy is exact, it scales.
2. One `GET /v1/search?limit=1` per child, reading `total_estimate`. This is N calls against a limit of 30 per 10 s per user, and the value is an estimate. Rejected.
3. Add `facet_counts.category_ids` to `GET /v1/search` (exact `GROUP BY` in the Postgres fallback, Typesense facets later). One call serves both this sheet and the filter-sheet counts in item 6. **This is the API follow-up (WP-API).** Until it ships, the client shows no counts.

**Data/API gap.** `PublicCategory` and `SearchResults` carry no counts (`docs/api/openapi.yaml` PublicCategoryList, SearchResults). The `Lifestyle` department is a text query, not a node. It opens Shop all directly, with no sheet.

**Edge cases.** If the tree fails, show the sheet with "See all in {name}" plus an inline error and retry. A node with no children opens Shop all directly. Loading shows a 4-row skeleton. Offline uses the cached tree (ETag) if present. RTL: chevrons mirror. Dynamic Type: the count moves under the name at large sizes.

**Analytics.** `category_window_opened{category_id, source}` and `category_window_selected{category_id, has_count}`.

**Acceptance.** Given the API returns no counts, no number is rendered (component test asserts no digit). Given `facet_counts` is mocked, each row shows its localized number. Given a child with count 0, the row is disabled and announced as "No items right now".

**Files.** New `features/category-window/{CategoryWindow.tsx, model.ts, api.ts, category-window.test.ts}` (WP-1). Wiring changes go to `home/sections.tsx` (WP-4) and `worlds/WorldsScreen.tsx` (WP-5).

## 3. Brand and store names bolder everywhere
**Rule.** Add a typography role `brandName` to `packages/ui-tokens` (both scales). It is caption size plus one step (EN 13/18, AR 14/20 with the Arabic line-height bump), weight 600, colour `textPrimary` (not secondary), and no uppercase, which harms Arabic and reads as shouting in EN. Add kit `<StoreName name verified? />` in `ui-native`. It uses this role, takes one line with a tail ellipsis on tiles and two lines on rows, and includes a `verified` glyph only when `StoreSummary.verifiedBadge` is true. Contrast is checked in `drift.test.ts` against `background` and `surface` (AA 4.5:1) in light and dark.

**Where.** `ProductCard.sellerName` (kit), home `ProductTile`, `BoardParts` (drop `toUpperCase()`), `BoardResults`, home `StoreListRow`, `StoresScreen` rows, PDP seller chip (unchanged file; follow-up), Saved cards (item 9) and checkout shipment headers.

**Acceptance.** No screen renders a store or brand name with `secondary` or `caption`. A grep test in `ui.test.ts` checks the kit and the AA pair test passes. AR at the largest Dynamic Type size keeps names on two lines at most in rows.

## 4. Home: Stores and All pieces sections, clearer, with a reason line
**Flow.** Home order is unchanged except for these two blocks. Each gets the kit `SectionTitle` plus a one-line `reason` caption under the title, and a clear "See all" action.
- **Stores** shows "Stores near {area} with live drops first" when a location is set, otherwise "Stores with live drops and verified deals". It uses `homeStoreRows` ordering today (drops first, server order). It must not claim "trending" or "viral": per the viral-stores report, `trending_score` is fixture or zero data, so the copy says nothing about popularity until the score is real.
- **All pieces** (renamed from `home.gridTitle`) shows "Every item from every store, newest first" (EN). The ordering text must match the real sort; if the server order is unknown, use "Every item from every store in one place".
- The quick actions (`QuickActions`) keep both buttons. The hints become the same reason lines, so the copy is shared, not duplicated.

**Rules.** A reason line states a fact about the data source or order, never social proof. The section is hidden when empty (current behaviour). Each block gets a hairline separator, never a card inside a card.

**Analytics.** `home_section_viewed{section: "stores"|"all_pieces"}` (impression, once per session) and `home_section_see_all{section}`.

**Acceptance.** The reason line is visible under each title in AR and EN. With no location, the generic line shows. The copy-lint passes (no "trending", "popular" or "viral" strings).

**Files.** `home/HomeScreen.tsx`, `home/parts.tsx` (SectionTitle gets a `reason` prop), `home/banner.tsx` (StoreListRow uses StoreName), `home-banners/QuickActions.tsx`, and `home/home-layout.test.ts`.

## 5. Discover rebrand: "For you"
**Intent.** "What do I really want to see": the Discover tab becomes a personal page built from saves, bag and history, with honest fallbacks. The tab label stays "Discover" (deep link `/explore` unchanged); the screen title becomes "For you" (open question 3).

**Modules (top to bottom; each hidden when empty; at most 10 items per rail).**
| Module | Source (exists) | Shown when |
|---|---|---|
| Inline search (item 8) | `GET /v1/search/suggestions`, local recents | always |
| Because you saved {item} | `GET /v1/products/{id}/similar` for the newest saved item (`GET /v1/me/wishlists/{id}`) | personalization on and at least 1 saved item |
| Goes with your bag | `POST /v1/stylist/complete-look` with bag product ids (`GET /v1/cart`), rules-only engine | personalization on, bag not empty, `kill.stylist` open |
| Price dropped on things you viewed or saved | `RecommendationItem.price_drop` from `GET /v1/feed` | personalization on and the server returns it |
| Picked for you | `GET /v1/feed?personalized=true`, using `reason` as the caption | `feed.personalized === true` |
| Popular now | `GET /v1/feed?personalized=false` | personalization off, or the personalized feed is empty or degraded |
| Recently viewed | `GET /v1/me/recently-viewed` | history not paused |
| Explore categories (item 7), Stores entry, Style me | static plus tree | always |

**Rules.**
- With the setting off (`GET /v1/me/settings`), the client sends `personalized=false`, calls none of the saved, bag or similar personal modules, and shows a one-line note: "Personalization is off. Turn on in Settings". This mirrors section 13 acceptance. The server is still authoritative (`recommendations.ts` checks setting and consent).
- `affordable` is never sent from Discover, and no budget data is used (section 12).
- Every module caption is factual ("Because you saved Linen dress"). No "people love", no counts.
- A % off shows only from `verified_discount_pct`, and a price drop only from `price_drop`. Sponsored items (from the ads module if ever mixed in) carry the kit "Sponsored" badge. Today `RecommendationItem.sponsored` is the constant false.
- Modules load in parallel. Each fails alone, with an inline retry, and never blanks the page.

**Gaps.** `RecommendationItem` has no title, image or store name. The client hydrates them via the existing product summary path the home rail uses. If hydration fails, the tile is dropped and nothing is invented. There is no "because you saved" reason on the wire, so the caption is composed client-side from the source module (that is a fact, not a model claim).

**Analytics.** `recommendation_impression`/`recommendation_click` (existing) with `surface:"discover"` and a new `module` property. `personalization_changed` is existing.

**Acceptance.**
- Given personalization off, the feed request has `personalized=false` and no wishlist, cart or similar call is made (port spy test).
- Given 0 saves and an empty bag, the page shows search, Popular now, Recently viewed and categories, with no empty rails.
- Given an offline start, cached modules show with an offline banner and others show retry.

**Files.** `app/(tabs)/explore.tsx`, `worlds/WorldsScreen.tsx`, `worlds/model.ts`, `worlds/worlds.test.ts`, and new `features/discover/{model.ts, api.ts, DiscoverModules.tsx, discover.test.ts}`.

## 6. Filters everywhere: one filter icon, accordion sections
**Flow.** Each product listing (Shop all, Home product filters, Search results, Saved) has exactly one filter icon button with a count badge, and a row of applied-filter chips under the header. Each chip removes one filter. The row scrolls horizontally with a faded edge and an "N filters applied" label. The icon opens `FilterSheet`, a bottom sheet of accordion sections with a sticky footer: "Reset" and "Show N items". N is the live `total_estimate`, debounced 250 ms, with a request sequence id so stale answers are dropped. Without a count, the footer says "Show items".

**Sections (in order; one open at a time; header shows "Brand, 2 selected").**
1. **Sort**: relevance, price low to high, price high to low, biggest verified discount. Sort is client-side on loaded pages today; the caption says so (gap: no server `sort`).
2. **Brand**: search field inside, then a checkbox list with selected items pinned on top. Its source today is stores (`store_ids`), because each store is a brand storefront and product `brand` is not on the wire (gap: `brand_ids` and `ProductSummary.brand`; open question 2). Max 30.
3. **Price range**: min and max EGP fields (existing `parseBudgetFields`, Eastern Arabic digits folded) plus presets. No histogram until facet counts exist.
4. **Budget**: "Fits my remaining budget" switch. It is shown only when signed in with a monthly budget and the `budget_insights` consent. Otherwise the row reads "Set a monthly budget" and links to `/budget`. It is applied as a request-time filter only (section 12), and its copy says it is not saved or shared.
5. **Categories**: the existing searchable `CategoryPicker` tree, multi-select up to 30.
6. **Verified discount**: any, 10, 20, 30 or 50% (server min 5), plus "Lowest price in 30 days".
7. **More**: condition, department, free delivery, new arrivals.
Hidden until data exists (per the benchmark): size, my size, colour, material, rating, and per-option counts. Each value shows only if the current results contain it; with no facet counts, values show without numbers.

**Rules.**
- Remove every inline filter control from screens: the Shop all quick chips (on sale, new, free delivery, lowest 30d), the category `BoardChip` row, the dead Brand and Size pills, the Search on-sale toggle and budget text field, the `__DEV__` facet chips, and the Home `HomeFilterSheet`/`FilterRow` (replaced by the shared icon plus chips). Navigation tiles (categories, departments) are not filters and stay.
- One state model `ListingFilters = {storeIds, categoryIds, priceMin, priceMax, fitsBudget, minDiscountPct, lowest30d, conditions, department, freeDelivery, newArrivals, sort}`, with a pure reducer, `appliedChips()`, `toSearchFilter()`, `badgeCount()` and route param round-trip. Logged-out users get no Budget section (the server returns 400 for budget, size and account facets).
- Changes are drafts inside the sheet. "Show N items" applies them; closing without applying discards them. Reset clears the draft.

**Edge cases.** A count request that fails keeps the last confirmed N with a "Count unavailable" caption. Offline: the sheet opens, the footer says "Show items" and applying runs the search, which shows the offline state. Thirty facets max (API4): the 31st pick is disabled with a message. RTL: accordion chevrons and the chip fade mirror. Dynamic Type: the footer buttons stack vertically. Reduce Motion: no accordion animation.

**Analytics.** `filter_sheet_opened{surface}`, `filter_applied` (existing, once per apply, per key), `filter_reset{surface}` and `filter_chip_removed{filter_key}`.

**Acceptance.**
- No listing screen renders any filter control outside the sheet except the icon and the applied chips (component test per screen).
- Apply then reset returns `EMPTY_LISTING_FILTERS` (property test). Chips match the applied state 1:1.
- Footer N equals the `total_estimate` of the last response. A stale response never overwrites a newer one.
- Budget section is absent when logged out or without consent.

**Files.** New `features/filters/{model.ts, FilterSheet.tsx, sections.tsx, AppliedChips.tsx, FilterButton.tsx, filters.test.ts}` and kit `packages/ui-native/src/components/accordion.tsx` (WP-1). Refactor `shop-all/model.ts` to re-export from `filters/model.ts`. Delete `shop-all/FiltersSheet.tsx`. `BudgetSheet.tsx`, `CategorySheet.tsx` and `StoreFilterSheet.tsx` become section bodies. `search/api.ts` gets the new wire fields. Adoption per screen happens in WP-3, WP-4 and WP-6.

## 7. Explore categories: three in a single row
**Default reading.** The Discover category tiles become a uniform grid of three tiles per row (replacing the "one wide, then pairs" rhythm). Each tile is 3:4 with the name below the art, not over a scrim, for contrast and Dynamic Type. Tapping a tile opens the item 2 window. A different reading is open question 4.
**Rules.** `tileRows` is replaced by a `rowsOf(count, 3)` chunk. A last row with 1 or 2 tiles is start-aligned with spacers. Tiles keep a minimum width of 96 pt; at accessibility text sizes the grid falls back to two per row.
**Acceptance.** 12 tiles make 4 rows of 3. In RTL the first tile is at the right. Names wrap to two lines and are never clipped.
**Files.** `worlds/model.ts` and `worlds/WorldsScreen.tsx` (WP-5).

## 8. Discover search: inline, simpler
**Flow (default).** Tapping the Discover search field expands it in place: the header collapses, the field takes focus and a panel under it shows up to 5 recent searches (each removable, plus "Clear") and, while typing, up to 5 suggestions from `GET /v1/search/suggestions`, as queries first, then stores and categories, each labelled. Submit or a suggestion tap shows results inline (grid plus filter icon) on the same screen. Cancel collapses back. There is no navigation to `/search`; the route stays for deep links. Removed from the panel: tabs, the brand and category lists, the budget field, the on-sale toggle and the visual-search button (camera stays only if `kill.visual_search` is open, as a single icon in the field).
**Rules.** Recents stay on the device only (`RECENTS_KEY`), never sent. The query is trimmed, at most 100 characters. Suggestions are debounced 200 ms, and stale responses are dropped.
**Edge cases.** Suggestions fail: show recents only, with no error noise. Offline: recents only, and submit shows the offline state. RTL: the cancel button sits at the start of the reading direction. Reduce Motion: no expand animation.
**Analytics.** `search_performed` (existing, with `scope:"discover_inline"`), `search_no_result` (existing) and `search_suggestion_tapped{kind, position}`.
**Acceptance.** Tapping search does not change the route (router spy). At most 5 recents and 5 suggestions show. Cancel restores the Discover scroll position.
**Files.** New `features/search/InlineSearch.tsx`. Change `search/SearchScreen.tsx` (reuses the shared panel) and `search/model.ts` (suggestion grouping). Wire it into `worlds/WorldsScreen.tsx` (all WP-5). Open question 1 covers the cut-off message.

## 9. Saved tab polish
**Observed problems (fixtures).** There is a big gap above the title. "Saved items: 2" is plain text. The list chips cut off "New list" with no scroll hint. The budget bar has no context. Art tiles are two per row and huge. Cards show no store or brand name. There is no heart, remove or add-to-bag control. "Remind me tomorrow" and "Find similar" are underlined links. An unavailable item is not greyed and has no badge. The cool-off row is squeezed against the tab bar with clipped text. There is no sort, filter or share.

**Layout.**
- Header: large title "Saved" with the safe-area top only (no extra spacer), and a subtitle "{n} items in {m} lists" (plural keys). On the trailing side, a filter icon (item 6) and a share icon. Share appears only for gift and birthday lists, and only for the selected list.
- List picker: horizontal chips with a faded trailing edge and inset padding so the last chip is fully visible when scrolled. "New list" is a trailing `+` chip that is always reachable (it is also the first action in the empty state).
- Budget context, shown only when the list has a budget: "Budget {B}. Items {T}. {Left} left" or "{Over} over budget", with `ProgressBar` and a caption "Prices are today's prices". The bar uses `savings` colour under budget and `danger` over.
- Items: compact rows (thumbnail 72 pt, 3:4) instead of two huge tiles. Each row shows StoreName (item 3), a 2-line title, the current price, and the honest price line "Was {added} when saved, now {current}" only when `addedPrice !== currentPrice`, both from server fields, with no % off and no "drop" wording unless the current price is lower. Trailing controls: a filled heart (remove, with Undo snackbar 5 s, `DELETE /v1/wishlists/{id}/items/{itemId}`), then the primary action button.
- Primary action per `buyAction`: "Add to bag" (kit `Button` size compact; with a `sku_pref`, `POST /v1/cart/lines` with an idempotency key; otherwise it opens the PDP size selector), "Remind me tomorrow" (secondary button), "Available in {h} h" (disabled, real server time only), or "Unavailable".
- Unavailable (delisted or out of stock): 50% opacity on the art, a "No longer available" badge, the price hidden, and a secondary button "Find similar". In-bag (product id present in `GET /v1/cart`): an "In your bag" badge and the action becomes "View bag".
- Cool-off setting (section 8 must stay): moves out of the list footer into a "List settings" row at the top of Want lists. It opens a sheet with the switch, the full helper text and the share controls. Content gets bottom padding of `tabBarInset` so nothing sits under the tab bar.
- Sort and filter: the shared `FilterSheet` with Saved-only sections. Sort is newest saved, price low to high, price high to low, or price changed. Filter is store, "available only" or "in budget" (list budget, not monthly budget).

**States.** Loading: a skeleton of 4 rows. Empty with no lists: illustration, "Save things you love", and one "Discover" action. Empty list: "Nothing in this list yet" plus "Discover". Error and offline: `ErrorState` with retry; offline keeps cached lists read-only (remove and add are disabled with a reason). A remove that fails restores the row and shows the error. Price dropped: the line uses `savings` colour. In-bag: as above.

**Share rules (section 8).** Gift and birthday lists only. The link is unguessable, stored hashed and revocable, with optional expiry (`POST`/`DELETE /v1/me/wishlists/{id}/share`). The viewer sees the nickname only and no address; buyers must be 18+. "Hide prices from owner" maps to `hide_prices_from_owner`. Gap: the wire does not return an existing link's URL (`api.ts` comment), so the UI shows "Shared" plus "Create a new link" and "Stop sharing", never a stale URL.

**Data/API.** `WishlistItem.product` (ProductSummary) supplies the store name and image, and the mapper must read it (today it is dropped). The remove endpoint exists, cart lines exist, and in-bag status comes from the cart. New port methods are `removeItem` and `addToBag`.

**Analytics.** `wishlist_item_removed{intent}`, `wishlist_add_to_bag{intent, cool_off}`, `add_to_bag` (existing, `source:"saved"`), `wishlist_shared{intent}` and `filter_applied` with `surface:"saved"`.

**Acceptance.**
- Every card shows the store name with the `brandName` role.
- Remove then Undo within 5 s makes no API delete call; after 5 s, exactly one call is made.
- A delisted item is dimmed, badged and offers only "Find similar".
- A Want list with cool-off on shows "Remind me tomorrow" as a button. After the server sets `cool_off_until`, it shows a disabled "Available in N h" computed from server time.
- The cool-off helper text is fully visible at the largest Dynamic Type size and nothing is hidden under the tab bar.
- The price line appears only when the prices differ.

**Files (WP-6).** `features/wishlists/{WishlistsScreen.tsx, model.ts, api.ts, wishlists.test.ts}`, new `features/wishlists/{SavedRow.tsx, ListSettingsSheet.tsx}` and `app/(tabs)/saved.tsx`.

## 10. Work packages (no shared files; WP-1 first)
| WP | Scope | Owns (exclusive) | Depends on |
|---|---|---|---|
| **WP-1 Foundations** (Sonnet builder; Opus review of the filter model) | Items 2, 3 and 6 shared parts, all i18n keys for items 1-9, all analytics events | `packages/ui-tokens/src/index.ts`, `drift.test.ts`; `packages/ui-native/src/components/{accordion.tsx (new), commerce.tsx}`, `ui-native/src/index.ts`, `logic/ui.test.ts`; `packages/i18n/src/{ar,en}.ts`; `packages/analytics/src/analytics-events.ts`, `docs/analytics/events.md`; `apps/mobile/src/features/filters/*` (new); `features/category-window/*` (new); `shop-all/{model.ts, FiltersSheet.tsx (delete), BudgetSheet.tsx, CategorySheet.tsx, StoreFilterSheet.tsx, shop-filters.test.ts}`; `search/{api.ts, model.ts, search.test.ts}` | none |
| **WP-2 Checkout** | Item 1 | `app/checkout.tsx` (delete), `app/checkout/*` (new), `features/checkout/*`, `.maestro/subflows/place-order.yaml`, `.maestro/flows/{05,08}*.yaml`, new `flows/09-checkout-steps.yaml`, `docs/specs/checkout.md` (one-line note) | WP-1 (keys, events) |
| **WP-3 Listings** | Item 6 adoption in Shop all and search results, item 3 on result tiles | `shop-all/{ShopAllScreen.tsx, BoardParts.tsx, shop-all.test.ts, selection-persist.test.ts}`, `app/shop-all.tsx`, `search/{BoardResults.tsx, BoardControls.tsx}`, new `flows/10-filter-sheet.yaml` | WP-1 |
| **WP-4 Home** | Items 2 (Home wiring), 3 (home tiles, stores), 4, 6 (home) | `home/{HomeScreen.tsx, sections.tsx, parts.tsx, banner.tsx, model.ts, home*.test.ts}`, `home-banners/QuickActions.tsx`, `stores-directory/StoresScreen.tsx` | WP-1 |
| **WP-5 Discover** | Items 5, 7, 8 and 2 (Discover wiring) | `app/(tabs)/explore.tsx`, `app/search.tsx`, `worlds/{WorldsScreen.tsx, model.ts, worlds.test.ts}`, `features/discover/*` (new), `search/{SearchScreen.tsx, InlineSearch.tsx (new)}`, new `flows/11-discover-inline-search.yaml` | WP-1 |
| **WP-6 Saved** | Item 9 | `features/wishlists/*`, `app/(tabs)/saved.tsx`, new `flows/12-saved.yaml` | WP-1 |
| WP-API (follow-up, needs approval) | `facet_counts` (categories, stores) and `sort` on `GET /v1/search`; `brand_ids` plus `ProductSummary.brand` | `apps/api/src/modules/search/*`, `docs/api/openapi.yaml`, generated client | none; the client already handles "no counts" |

Ordering: WP-1, then WP-2 to WP-6 in parallel. A WP that needs an extra string adds it in a follow-up commit to WP-1's files after merge, never in parallel. The `search/model.ts` grouping for item 8 is written by WP-1 as `groupSuggestions()` so WP-5 does not edit it.

## 11. Test plan
- **Unit (vitest, pure models; domain coverage at least 90% on new models):**
  - `filters/model.ts`: reducer, chips, wire mapping, route round-trip; fast-check apply/reset idempotence, the 30-facet cap and stale-count sequencing.
  - `checkout/model.ts`: `stepBlockers` per step, session snapshot TTL and bag-fingerprint invalidation, no address text in the snapshot.
  - `category-window/model.ts`: count rendering only from API values.
  - `discover/model.ts`: module visibility matrix (personalization on/off, empty saves or bag, kill switch).
  - `worlds/model.ts`: `rowsOf`.
  - `wishlists/model.ts`: row view (price line, unavailable, in-bag), undo timer, sort.
- **Component (React Native Testing Library):**
  - FilterSheet: one section open, footer N, Reset, Budget hidden when logged out.
  - Each listing screen: no filter controls outside the sheet.
  - Checkout: summary details equal across steps, back keeps choices.
  - CategoryWindow: no digits without counts.
  - SavedRow: a11y labels ("Remove {title} from {list}").
  - All of the above in AR and EN.
- **Maestro (iOS, AR and EN envs):**
  - 05/08 updated.
  - 09 checkout steps: Delivery -> Payment -> back -> Payment -> Review -> place; kill app on Payment and resume.
  - 10 filter sheet: open, brand search, select, Show N, chip remove, reset.
  - 11 Discover: tap search, the route stays, recents shown, submit shows results inline, cancel.
  - 12 Saved: remove and undo, add to bag, unavailable row, cool-off settings sheet.
  - Run `visual-smoke` for light, dark, AR and EN.
- **Gates:** typecheck strict, eslint, `check-debt.mjs` (no growth; run `--update` on shrink), i18n parity, copy-lint (no social proof, no "trending" or "viral"), analytics `events-doc.test.ts` and `pii.test.ts`.

## 12. Design-lint and debt notes
- New files must start at zero debt. Use kit `Text`, `Button`, `Chip`, `Checkbox`, `SearchField`, `BottomSheet`, `ProgressBar` and `StepIndicator` and the new `Accordion`/`StoreName`. No raw `Animated`, `TextInput` or `TouchableOpacity`, and no hex values. Brand colours come only through the theme.
- Baseline files touched: `checkout/Choice.tsx`, `home/banner.tsx`, `home-banners/OffersCarousel.tsx` (untouched) and `purchase/motion.tsx` (untouched). WP-2 and WP-4 should fix and shrink the files they touch, never raise them.
- `QuickActions.tsx` uses `brand.ink`/`brand.ivory` shadows inline. If touched, move them to theme tokens.
- `WorldsScreen.tsx` uses inline `radius`/hairline styles and `brand.ivory` over a scrim. Item 7 removes the scrim text, which reduces that risk.

## 13. Open questions (owner)
1. Item 8: your message stopped at "and also when i". What should happen after that? Default: the inline search as specified.
2. Brand filter: should "Brand" list stores (works today), or wait for real product brands (needs WP-API and seller data)? Default: stores now, brands when data exists.
3. Discover title: should the screen title change to "For you", or keep "Discover" and only change the content? Default: tab "Discover", screen title "For you".
4. Item 7: does "three sections in a single row" mean three tiles per row (default), or three section tabs (for example Women, Men, Kids) side by side in one row?
5. Sort lives inside the filter sheet as its first section. Is that acceptable, or do you want a separate sort control? A separate control would be an exception to "nothing else on screens".
6. Should the Shop all category chip row (navigation-like) be removed too, as specified, or kept as navigation?
7. Approve WP-API (facet counts, server sort, brand field) so the category counts and per-option filter counts can appear?
8. Saved: should "Add to bag" without a saved size open the product page's size selector (default), or a quick size sheet in place?
