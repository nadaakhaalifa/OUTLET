# Design board v4 (owner's final board, 2026-10-15)

Image: `screenshots/design-board-v4.png` (8 screens: Home, Shop Everything, View Stores, Category, Product detail, Shopping bag, Search and filters, Profile). Tab bar on every screen: Home, Discover, Saved, Bag, Profile.

This page records how the board maps to the Z-OUTLET mobile app, what the owner decided, where we deliberately differ from the board, and what is still open. It is a record, not code: routes and folders marked "target" may not exist yet in the tree when you read this; check `apps/mobile/src/app` before relying on them.

## 1. Screen mapping

| # | Board screen | Route (target) | Feature folder | Owner agent / file | Status |
|---|---|---|---|---|---|
| 1 | Home | `/(tabs)/index` | `features/home`, `features/home-banners` | home agent; `app/(tabs)/index.tsx` | Existing screen being reworked to the board (hero, two entry buttons, promo banner, category tiles) |
| 2 | Shop Everything | `/shop-all` | `features/shop-all`, `features/search` | shop-all agent; `app/shop-all.tsx` | Exists; redo with one filter button and density control |
| 3 | View Stores | `/stores`, `/stores/scope`, `/stores/list` | `features/stores-directory` | stores agent; `app/stores/` | Exists; flow per `docs/plan/stores-flow-in-store.md` |
| 4 | Category | `/shop-all?category=<id>` (target) | `features/shop-all` | shop-all agent | Reuses the grid; category header and sub-chips new |
| 5 | Product detail | `/product/<id>` | `features/pdp` | pdp agent; `app/product/` | Exists; restyle only |
| 6 | Shopping bag | `/(tabs)/bag` | `features/bag` | bag agent; `app/(tabs)/bag.tsx` | Exists; restyle only |
| 7 | Search and filters | `/search` | `features/search` | search agent; `app/search.tsx` | Exists; one filter button, tabs Products / Brands / Categories |
| 8 | Profile | `/(tabs)/me` (Profile) | `features/me` | tabs agent; `app/(tabs)/me.tsx` | Exists as Me; renamed Profile, dark panel per board |

Tabs: `app/(tabs)/_layout.tsx` (tabs agent). `app/(tabs)/explore.tsx` becomes Discover; a Saved tab (wishlists, `app/wishlists.tsx` content) is added; `app/(tabs)/stylist.tsx` stops being a tab.

## 2. Owner decisions (all 2026-10-15)

1. Tab set is Home, Discover, Saved, Bag, Profile. It replaces the Stylist tab. The Stylist stays reachable from Discover and from Profile. ADR: written by the tabs agent; at the time of writing the latest file in `docs/adr` is `0043-wardrobe-digitization.md` and no tabs ADR was present, so link it from `docs/adr/README.md` when it lands.
2. Home hero auto-advances every 10 s and is about 34% of screen height (already recorded in `discovery.md`).
3. One filter button next to the search field. No rows of dropdown pills (Category, Brand, Size, Price on the board are replaced by the sheet).
4. Grid density 1 / 2 / 3 / 4 columns, plus pinch to change.
5. Stores flow: Online or In-store, then Local / Global / Both, then the store list, then the store collection.
6. In-store has no data. It shows the honest empty state; nothing is invented (see `docs/plan/stores-flow-in-store.md`).

## 3. Deliberate deviations from the board

| Board shows | We do | Why |
|---|---|---|
| EUR prices | EGP, integer piastres, Arabic numerals per locale | Egypt-first; money rules |
| Star rating and review count (4.6, 124 reviews) | Only when real verified reviews exist | No fake reviews (CPL 181/2018, rule 12) |
| Colour swatches | Only when the SKU has real colour variants | No invented data |
| "Open, Closes 10 PM" and distances (2.4 km) | Hidden until store-location data and hours exist | No fake data; PDPL review for location |
| Discount pills (-50%, -40%) and struck-through prices | Only via a verified claim (price-integrity spec section 9, `claimOf`: reference above price, floor percent, at least 5) | CPL 181/2018 misleading-discount rule |
| "UP TO 70% OFF" banner copy | Only if backed by verified claims in the data; otherwise neutral copy | Same |
| "AD" label | Only on genuinely sponsored placements (max 2 in top 10) | Disclosure rule |
| Photography | Placeholder art until real image URLs are supplied | No stock photos with unclear rights |
| "Become a member" banner | Plus, commerce-only benefits, with auto-renew disclosure; hidden for members | ADR-0004 Plan A |
| "1,248 products" count | Real server count or hidden | No fake numbers |

### Asset slots (placeholder art today)
- Hero banners (Home carousel, 1 to N slides; 34% height, safe for centre crop)
- Promo banner (Home, below the two entry buttons)
- Category tiles (Women, Men, Kids, Lifestyle; Home row and Discover circles)
- Category header images (Category screen)
- Store covers and store directory tiles
- Product images (grid, PDP gallery, bag thumbnails)
- Profile member banner
- "Find your nearest store" card image (hidden while In-store has no data)

## 4. Open items and asset requests for the owner

- Supply real image URLs (or files with usage rights) for every slot above, with Arabic-safe crops.
- Confirm whether the In-store card is hidden until outlet data exists or kept as a visible placeholder (still Proposed in the stores note).
- Confirm the Saved tab content: wishlists with intent only, or also saved searches and recently viewed.
- Confirm Stylist entry points and labels (Discover and Profile).
- Provide approved Arabic copy for the hero, promo banner and tab labels (`arabic-review-pack.md`).
- Confirm the scope chosen in the stores flow should persist to the shared worlds preference (currently a route param).
- Decide whether Brands and Categories tabs in Search need their own result screens now or later.

## 5. Visual QA checklist

Run each screen in light, dark, English and Arabic RTL; also at the largest font size. Tick when checked on a device (none done yet).

| Screen | Light | Dark | AR RTL | Notes to check |
|---|---|---|---|---|
| 1 Home | [ ] | [ ] | [ ] | Hero 10 s advance, pager mirrors, entry buttons, promo banner, tab order mirrors |
| 2 Shop Everything | [ ] | [ ] | [ ] | Filter button, density 1/2/3/4 and pinch, no price/discount without claim |
| 3 View Stores | [ ] | [ ] | [ ] | Online/In-store, scope, list, honest empty state, no distances |
| 4 Category | [ ] | [ ] | [ ] | Header, sub-chips scroll, grid |
| 5 Product detail | [ ] | [ ] | [ ] | Size selector, price block, no fake rating, bar above home indicator |
| 6 Shopping bag | [ ] | [ ] | [ ] | Quantity steppers, totals in EGP, free-delivery progress |
| 7 Search and filters | [ ] | [ ] | [ ] | Cancel, tabs, filter sheet, Sponsored label |
| 8 Profile | [ ] | [ ] | [ ] | Dark panel contrast, Stylist entry, member banner |

Also: 44pt targets, VoiceOver names on icon buttons, Reduce Motion stops the hero advance, no raw keys or ids in copy.
