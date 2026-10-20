# Spec: iPad adaptation (iOS app)

- Status: Draft for builders. Design only. Decision record: ADR-0054 (Proposed). iPad support (`supportsTablet`, question 1) is **not** decided and stays off.
- **Decision history (owner, 2026-10-16):**
  1. Zoom went 1.25x ("zoomed in 25%"), then 1.75x ("way more zoomed in"), then 1.25x ("too zoomed in"), then 1.5x, then **1.725x (current, "15% more" on top of 1.5)**. The value lives in one constant, `IPAD_ZOOM = 1.725`, in `packages/ui-tokens`. `IPAD_ZOOM` is now the **maximum** zoom: the zoom in force ramps with the window width (section 3). History: 1.25 → 1.75 → 1.25 → 1.5 → 1.725 (max).
  2. After seeing the zoomed role chooser: "looks so odd; I need it designed for the iPad screen, and another design for the iPhone screen".
  3. **Scope now: a bespoke iPad layout for the entrance page only** (role chooser, route `/role`). The other bespoke layouts (6B) are proposals, not approved.
- Date: 2026-10-16.
- Sources:
  - CLAUDE.md; master prompt sections 25, B7, T2, P4.
  - `docs/design-system/{ux-principles,density-v2}.md`.
  - `packages/ui-tokens`, `packages/ui-native`.
  - `apps/mobile/app.config.ts`; `features/{grid-density,role-choice,account-creation,chrome}/*`; `app/role.tsx`.
  - `docs/specs/{mobile-ux-round-2,guest-browsing}.md`.
- Sequencing: **tablet work starts only after round-2 WP-1 has merged.** T5 also waits for T0 (section 13).

## 1. What the evidence shows
- **First screenshot (Expo Go).** Expo Go is universal, so the phone layout stretched to 1032 pt. A production build with `supportsTablet: false` runs in iPhone compatibility mode instead: letterboxed, upscaled, with no Split View or landscape.
- **No size-class system.** About 13 files read `useWindowDimensions`, each in its own way.
- **Role chooser at 1.75x (earlier T0 build).** The phone layout was scaled into a narrow centred column with wide margins, and "Already have an account?" was clipped with no scroll affordance. Causes in `RoleChoiceScreen.tsx`:
  - a raw `MAX_WIDTH = 560` and `paddingHorizontal: 20` (physical numbers that ignore the zoom);
  - a stacked composition designed only for the phone;
  - the kit `Screen` hides the vertical scroll indicator.
- **Account creation.** `AccountCreateScreen` shows a narrow phone column with tiny text. It is out of scope for now (6B.1).
- **Orientation.** `orientation: 'portrait'` also locks iPad. iPadOS 26 resizable windows deprecate `UIRequiresFullScreen` (**VERIFY**).

## 2. Options compared
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| A. Max-width only | Very low | Poor: the phone column the owner rejected | Low | Poor |
| B. Zoom only (phone compositions) | Medium | Poor: tried at 1.75x and rejected by the owner | Medium | Poor |
| C. `isTablet` branches everywhere | High | Uneven; breaks in Split View | High | Poor |
| **D. Theme zoom 1.725x and width classes app-wide, plus bespoke compositions screen by screen as approved, entrance first (chosen)** | Medium | Good: designed for iPad, works in any window, Dynamic Type-aware | T0 + T5 now | Good: other screens adopt 6B when approved |

- **Zoom mechanism.** A root `transform: scale` blurs text and modals escape it, so it is rejected. The zoom is applied **at token level** instead.
- **Controls.**
  - Option 1, every control at the full zoom (a 76 pt button): rejected as heavy.
  - **Option 2, a derived `CONTROL_ZOOM = 1 + (IPAD_ZOOM - 1) * CONTROL_ZOOM_SHARE` with share 0.62 (= 1.45, a 64 pt button): chosen.** It matches the owner's "~1.45x" and stays at 44 pt or more.
- **Choice: D.** It meets "designed for the iPad", keeps Split View correct by construction, and limits bespoke work to what the owner approved.

## 3. Size classes, zoom and effective width
- The class comes from the window width only (`useWindowDimensions().width`), never from the device.
- **The zoom in force is a continuous function of the window width:** `z(w) = 1` for `w < 600`, and `z(w) = min(IPAD_ZOOM, 1 + (w - 600) / 375)` for `w >= 600` (rounded to 0.01, exactly `IPAD_ZOOM` on the plateau). So `z(600) = 1` (no jump at the class boundary), `z` reaches 1.725 at about 872 pt, and **no window is ever laid out narrower than an iPhone**: `effective = w / z >= 375`. Property-tested: monotonic, in `[1, IPAD_ZOOM]`, continuous at 600, effective >= 375.
- `effectiveWidth = window / z(w)`. All layout decisions use effective points. `CONTROL_ZOOM(z) = 1 + (z - 1) * 0.62` follows the same `z`.

| Class | Rule | Window → z → effective → content (minus gutters) | Gutter pt | Section gap pt | Grid gap pt |
|---|---|---|---|---|---|
| `compact` | window < 600 | iPhones, Slide Over, 1/3 Split View: **iPhone layouts, unchanged** (z = 1) | 16 | 14 | 12 |
| `regular` | window >= 600, effective < 760 | 600 → 1.00 → 600 → 568; 650 → 1.13 → 575 → 543; 700 → 1.27 → 551 → 520; iPad mini portrait 744 → 1.38 → 539 → 507; 11-inch portrait 834 → 1.62 → 515 → 483; from 872: z = 1.725: 1032 → 598 → 567; mini landscape 1133 → 657 → 625; 11-inch landscape 1194 → 692 → 662 (Pro M4 1210 → 703) | 16 → 28 (ramps with z) | 14 → 24 | 12 → 21 |
| `expanded` | effective >= 760 (window >= 1311) | 13-inch landscape 1376 → 1.725 → 798 → 761 | 35 | 28 | 21 |

- **Two-pane** (only for the later 6B screens) uses `expanded`, which means **13-inch landscape only**. 11-inch landscape (692), 13-inch portrait (598) and 11-inch portrait (483) are single-pane.
- **The entrance page has its own threshold:** split at effective width >= 640 (section 6A).
- **Compact is pixel-identical** to today (regression test at 390 pt).
- **Class changes are live**, with no state lost when crossing 600 pt, 640 effective or 760 effective.

## 4. The 1.725x zoom: tokens, controls, type
- **Spacing, radii and art** scale by 1.725 (`round(x * 1.725)`). Hairlines and `pill` stay as they are.
- **Control heights and icon glyphs** scale by `CONTROL_ZOOM` (1.45), rounded to even (glyphs to an integer). The minimum touch target is **44 pt**.

| Token | Compact | Regular/expanded |
|---|---|---|
| spacing xs..huge | 4, 8, 12, 16, 24, 32, 48, 64 | 7, 14, 21, 28, 41, 55, 83, 110 |
| radius xs, sm, md, tile, lg, xl, xxl | 4, 8, 14, 16, 18, 24, 32 | 7, 14, 24, 28, 31, 41, 55 |
| button / buttonCompact (x1.45) | 44 / 40 | 64 / 58 |
| field / fieldCompact | 46 / 44 | 66 / 64 |
| chip / chipCompact / chipLarge | 34 / 30 / 40 | 50 / 44 / 58 |
| sizeCell, search, iconDisc | 40, 44, 36 | 58, 64, 52 |
| categoryDisc, appBar, listRow | 48, 48, 48 | 70, 70, 70 |
| icon glyph 20 / 24 | 20 / 24 | 29 / 35 |

When zoomed text needs more height, `controlMinHeight` grows the control. Text is never clipped.

**Type.** The kit multiplies each base `nativeTypography` size by `k = z` (the zoom in force; compact `k = 1`). **Dynamic Type is not faded:**
```
T(fs) = z * min(fs, 2)          maxFontSizeMultiplier = MAX_FONT_SCALE = 2 (unchanged)
fontSize = roundHalf(base * z); lineHeight = roundEven(base * z); Arabic +10% after
```
- **Cap = 2 x the zoom in force (3.45x the phone size at full zoom).** This supersedes the earlier 2.45x cap with a fade. Reasoning (WCAG 1.4.4, resize text up to 200%): the user's text-size setting must keep its full 2x effect on top of the iPad's default rendering. A fade made the same setting grow iPad text by less than it grows iPhone text (1.4x instead of 2x), so a low-vision user would get a weaker accessibility response on iPad than on iPhone. Without a fade `T(2) / T(1) = 2` on both devices.
  - T is monotonic in `fs`, never above `2z`, and never below the phone size at the same setting.
  - Cost: at the largest Dynamic Type size, full-zoom iPad text is 3.45x the phone base size. Layouts must scroll or reflow (flow 15), and `controlMinHeight` grows controls.
  - The alternative is the earlier fade to a 2.45x cap. **Owner flag (question 2).**
- **Default sizes:** body 15 → 26, caption 12 → 20.5, `micro` 10.5 → 18, headline 16 → 27.5, title1 24 → 41.5, display 32 → 55, hero 40 → 69.
- **Kit API:** `useLayout()` returns `{ sizeClass, z, controlZ, effectiveWidth, contentWidth, s(n), sc(n) }`. Screens never multiply by hand.

## 5. Max content width and centring (effective points)
| `Screen width` | Max eff | Physical at the zoom in force | Used by |
|---|---|---|---|
| `form` | 440 | 759 at z = 1.725 (440 at z = 1) | address, settings, privacy, onboarding forms |
| `reading` (default) | 560 | 966 at z = 1.725 (560 at z = 1) | orders, me, wallet, budget, help, legal, returns |
| `grid` | none | none (the window caps it) | Shop all, search, Home, Discover, stores, Saved |
| `full` | none | none | full-bleed art and the entrance split (6A) |

- **Centring.** Columns are centred, with the gutter as the minimum margin. Backgrounds stay full-bleed.
- **Bars.** The app bar and `StickyBar` content align to the column. The tab bar is centred, at most 480 eff (828 pt). Toasts are at most 360 eff (621 pt). The centred form sheet is min(420 eff, effective width - 2 gutters), 725 pt at most, from an effective window of 460. With the ramp every zoomed window is at least 505 eff, so every window >= 600 pt gets the form sheet (the bottom-sheet branch below 460 eff stays for safety).
- **Scroll indicator.** On regular and expanded, the kit `Screen` **shows the vertical scroll indicator** (section 12).

## 6. Grids (kit, app-wide in T0)
`columns = clamp(floor((w + gap) / (minCard + gap)), 1, cap)`, using the effective content width. Grid gap is 12 eff. `minCard` grows x1.25 at `fs >= 1.3` and x1.5 at `fs >= 1.5`. Card detail level (`DensityProductCard`) follows the card width in effective points on regular and expanded windows (`detailDensityForWidth`; iPhone keeps the density). `useGridDensity` applies this on iPad so existing grids stop showing two giant cards. This is generic sizing, not a bespoke layout.

| Pref | minCard | cap | 700 (520) | mini P 744 (507) | 11" P 834 (483) | 13" P 1032 (567) | 11" L 1194 (662) | 13" L 1376 (761) |
|---|---|---|---|---|---|---|---|---|
| 1 (large) | 240 | 3 | 2 | 2 | 1 | 2 | 2 | 3 |
| 2 (default) | 140 | 5 | 3 | 3 | 3 | 3 | 4 | 5 |
| 3 | 92 | 6 | 5 | 4 | 4 | 5 | 6 | 6 |
| 4 (dense) | 68 | 8 | 6 | 6 | 6 | 7 | 8 | 8 |

## 6A. Bespoke iPad layout: entrance page (role chooser, `/role`) — APPROVED, T5
**Layout modes.** Chosen by effective width, with no orientation branch:

| Mode | When | Windows |
|---|---|---|
| `phone` | window < 600 pt | Today's iPhone layout, unchanged. Split View and Slide Over below 600 pt |
| `band` | window >= 600 pt and effective < 640 (window < 1104 at full zoom) | iPad mini portrait (539), 11-inch portrait (515), 13-inch portrait (598), Split View 1/2 (~551), 600-700 pt windows (effective 551-600) |
| `split` | effective >= 640 (window >= 1104) | iPad mini landscape (657), 11-inch landscape (692), 13-inch landscape (798) |

```
iPhone (unchanged)        11-inch portrait, band (556 eff)          13-inch portrait, band (598 eff)
+----------------+        +--------------------------------+        +-----S brand 42%-----+------E choices-------+
| [AR|EN][◐]  E  |        |                     [AR|EN][◐] E|        | hero art (cover,    |          [AR|EN][◐] E|
| WORDMARK       |        | +----------------------------+ |        | full height, under  | Choose how you start |
| promise        |        | | hero art band (28% height) | |        | the status bar)     | +------------------+ |
| heading        |        | | WORDMARK                   | |        |                     | | Shop             | |
| [shop card+art]|        | | promise (over scrim)       | |        | WORDMARK            | | body (<= 3 lines)| |
| [sell card]    |        | +----------------------------+ |        | promise             | | [Start shopping] | |
| Already have.. |        | Choose how you start           |        |                     | +------------------+ |
| [Sign in]      |        | +-------------+ +------------+ |        |                     | | Sell (eyebrow)   | |
+----------------+        | | Shop        | | Sell       | |        |                     | | [Apply as brand] | |
                          | | [CTA]       | | [CTA]      | |        |                     | +------------------+ |
                          | +-------------+ +------------+ |        |                     | Already have an      |
                          | Already have an account?       |        |                     | account? [Sign in]   |
                          | [Sign in]                      |        +---------------------+----------------------+
                          +--------------------------------+
11-inch landscape, split (692 eff)                         13-inch landscape, split (798 eff)
+-------S brand 50%------+-----E choices (col <= 400)---+   +---------S brand 50%---------+-------E choices (col 400)-----+
| hero art               |                  [AR|EN][◐] |   | hero art                    |                   [AR|EN][◐]  |
| WORDMARK               | Choose how you start         |   |                             |   Choose how you start        |
| promise                | [Shop card]                  |   | WORDMARK                    |   [Shop card]                 |
|                        | [Sell card]                  |   | promise                     |   [Sell card]                 |
|                        | Already have an account? ↓   |   |                             |   Already have an account?    |
+------------------------+------------------------------+   +-----------------------------+-------------------------------+
```
**Composition**
- **Split mode, brand panel.**
  - Position and width: at the logical start, 42% wide below 760 effective and 50% at 760 or above.
  - Content: the existing hero art (`HeroArt` "atelier" or the photo, cover-cropped, full height, full bleed under the status bar), the wordmark at 1.5x and the promise, at the bottom-start over a gradient scrim.
  - Contrast: the `onImage`/scrim pair is AA-tested in `drift.test.ts`.
- **Split mode, choices pane.**
  - Content is vertically centred when it fits and top-aligned when it scrolls.
  - The column is at most 400 eff (600 pt), centred in the pane, with 24 eff padding.
  - The two choice cards stack. On iPad the shop card **drops its 16:9 hero art**, because the brand panel or band already carries the art, and this keeps the cards short.
- **Band mode.**
  - A top row holds the toggle.
  - The hero band is an inset card: radius `xl`, 28% of the window height and at most 260 eff. It carries the wordmark and promise over the scrim.
  - Below it come the heading, then the two choice cards, then the sign-in link.
  - The cards sit **side by side when content is >= 500 eff** (13-inch portrait: 566). They stack otherwise (11-inch portrait: 451; mini portrait: 399; Split View 1/2).
  - The page is centred, at most 576 eff.
- **One primary action (UX rule 1).** Only "Start shopping" is primary. "Apply as a brand" is secondary and Sign in is ghost.

**Language and theme toggle**
- iPhone: unchanged.
- `split`: top-end of the **choices pane**, inside the top safe area and aligned to the choices column end. It never sits over the art, so contrast stays simple. In Arabic, "end" is left.
- `band`: a row on the page background above the band, at the end. It is never overlaid on the image.
- The `LanguageThemeToggle` component (`features/chrome`) is used unchanged.

**Scrolling and no overflow**
- **What scrolls.**
  - Split: the brand panel is fixed and **only the choices pane scrolls**, with its indicator visible. When content overflows, a bottom fade over the last 24 eff hints that more is below.
  - Band: the whole page scrolls.
- **Fit at the default text size.**
  - 13-inch (portrait and landscape) fit without scrolling; 11-inch portrait and mini portrait scroll slightly (check in flow 15).
  - 11-inch landscape scrolls by about one card edge. The indicator and the fade show it.
  - iPad mini fits in portrait and scrolls slightly in landscape.
- **Largest Dynamic Type.** Everything scrolls, and "Sign in" (`role-signin`, the end marker) is always reachable. Nothing is clipped in any window from 600 to 1376 pt.

**Safe areas.** The art runs under the status bar and home indicator. Text, the toggle and the controls respect `useSafeAreaInsets`. The bottom padding is `insets.bottom + 24 eff`. This route has no tab bar.

**RTL.** In Arabic the brand panel moves to the right and the choices to the left, using logical `start`/`end` with `flexDirection: "row"`. The scrim gradient anchors to the start edge. Band-mode cards read right to left. The wordmark is never mirrored.

**Split View and Stage Manager.**
- Below 600 pt: the iPhone layout.
- From 600 pt to 640 effective: band.
- From 640 effective: split.
- The layout switches live during a resize, with no remount and no lost `busy` state.

**Files (T5).**
- `features/role-choice/RoleChoiceScreen.tsx` is refactored into:
  - `RoleChoicePhone` (the current markup, unchanged);
  - `RoleChoiceBand` and `RoleChoiceSplit`;
  - a shared `ChoiceCards` with an `art` flag.
- `role-choice.test.ts` is updated.
- The raw `MAX_WIDTH` and the padding literals are removed.
- Analytics and the API are unchanged.

**Acceptance (T5)**
1. At 390 pt the screen is pixel-identical to today.
2. The layout mode is `band` at 744, 834 and 1032 pt and `split` at 1133, 1194 and 1376 pt, in EN and AR.
3. The brand panel sits on the start side in each language, and the toggle sits at the top-end of the choices pane.
4. `role-signin` is visible after `scrollUntilVisible`, at the default and the largest Dynamic Type, on both iPads in both orientations.
5. The owner approves the side-by-side screenshots (flow 14).

## 6B. Other bespoke layouts — LATER, NOT APPROVED (proposals only)
For now these screens get only the generic zoom, max widths and grid columns from T0. Each proposal below waits for owner approval and uses the 1.5x effective widths.
1. **Account creation and sign-in sheet.** A centred 448 eff form card on a brand backdrop, instead of a phone column. Waits for guest-browsing G2.
2. **Home.** A full-bleed hero with the text block at the start. Rails become multi-column rows: drops show 2 per page at content >= 600 eff (13-inch portrait and landscape). Departments use min 120, which gives 5 or 6 per row. "All pieces" follows the section 6 table.
3. **Shop all.** In `expanded` (11-inch and 13-inch landscape), a 200 eff filter side panel that applies changes live. With the panel open, the grid has 3 columns on both. Otherwise filters open in a form sheet.
4. **Saved.** In `expanded`, a 200 eff lists sidebar plus an item-card grid (min 180). Columns: 13-inch portrait 3 (no sidebar), 11-inch landscape 2, 13-inch landscape 3.
5. **Checkout steps.** In `expanded`, the step column (max 448) sits beside a 280 eff sticky summary card from the shared `SummaryDetails`; the card and the bar must match. Elsewhere, the phone flow in a `form` column.
6. **Product page.** In `expanded`, the gallery takes 55% and the info 45%, and the info column scrolls.

## 7. Sheets, modals and popovers
- **Effective window >= 460** (iPad mini portrait and up, and Split View 1/2 on 13-inch): `BottomSheet` becomes a **centred form sheet**.
  - Size: width `min(420, effectiveWidth - 2*gutter)` eff (at most 630 pt), max height 85%.
  - Look and behaviour: zoomed `radius.xl`, a close button and no handle. It fades and scales in, with no motion under Reduce Motion.
- **Below 460 eff:** a zoomed bottom sheet.
- Popovers are out of scope. Toasts are at most 384 eff.

## 8. Orientation and landscape
- iPhone stays portrait-locked. iPad gets all four orientations only after approval (question 1).
- `app.config.ts` reads `IOS_SUPPORTS_TABLET`, which defaults to `false`; no EAS profile sets it.
  - Only when it is true does the build get `supportsTablet`, `requireFullScreen: false` and `UISupportedInterfaceOrientations~ipad`.
  - **VERIFY** that the `~ipad` key survives prebuild.
- Expo Go shows the iPad layouts even with the flag off.

## 9. RTL, keyboard, pointer, safe areas
- **RTL:** logical start/end everywhere (see 6A).
- **Keyboard:** Return submits, and focus follows the reading order. Esc closing sheets is best-effort (**VERIFY**), and there is always a visible close button.
- **Pointer:** hover tint only.
- **Safe areas:** `useSafeAreaInsets` only. Insets are physical, never zoomed.

## 10. supportsTablet and App Store (owner decision, still open)
The flag stays `false`. If the owner approves it:
- 13-inch iPad screenshots in AR and EN become mandatory.
- App Review may test on iPad (**VERIFY** guideline 2.4.1).
- Dropping iPad support later is likely refused (**VERIFY**).
- Mac "Designed for iPad" listing defaults to opt-out.

## 12. No-clip rule, design lint and debt
- **Rule: a screen must never clip or overflow.** Every screen scrolls or fits at windows from 600 to 1376 pt, in both orientations, and at the largest Dynamic Type.
  - On iPad the kit `Screen` shows its scroll indicator.
  - A `scroll={false}` screen must pass flow 15.
  - Each screen's last control has an end-marker testID.
  - This is an acceptance check for T0 (all tab screens, via the kit) and T5 (the entrance), and for any later package.
- **`DS-RN-WINDOW`** bans `useWindowDimensions`, `Dimensions` and `Platform.isPad` in screens.
- **`DS-RN-RAW-SIZE`** bans raw size and spacing literals of 2 or more in screen styles, because they do not zoom.
- **Debt baseline.** T0 records both rules once, as a new-rule baseline (this is not growth). T5 clears `role-choice/*` and runs `check-debt.mjs --update`. Every other file stays baselined as listed residual debt until its 6B layout is approved. After T0 the baseline only shrinks.

## 13. Work packages
| WP | Scope | Owns (exclusive) | Waits for |
|---|---|---|---|
| **T0 Foundation** (in progress) | Sections 3-5, 6, 7, 8, 12; kit `SplitLayout`; scroll indicator | `packages/ui-tokens/src/{index.ts, drift.test.ts}`; `packages/ui-native/src/logic/{size-class.ts, size-class.test.ts, type.ts, touch.ts, index.ts, ui.test.ts}`; `packages/ui-native/src/{theme.tsx, index.ts}`; `packages/ui-native/src/components/*`; `features/grid-density/{model.ts, model.test.ts, useGridDensity.ts}`; `apps/mobile/app.config.ts`; `tooling/design/{rules.mjs, debt-baseline.json}`, `docs/plan/design-debt.md`; `docs/design-system/density-v2.md`; `.maestro/{run.sh, flows/13-ipad-layout.yaml, 14-ipad-side-by-side.yaml, 15-ipad-no-clip.yaml}`; `docs/adr/README.md` row 0054 | WP-1 |
| **T5 Entrance page** (approved) | 6A only | `features/role-choice/*` (`RoleChoiceScreen.tsx`, new `RoleChoiceBand.tsx`, `RoleChoiceSplit.tsx`, `ChoiceCards.tsx`, `role-choice.test.ts`), `app/role.tsx` | T0 |
| Later, not approved | 6B.1-6B.6 | No files claimed until approved. Intended split: listings (shop-all, search, filters); Home and stores; Saved; checkout and bag; PDP; account creation (after G2) | Owner approval |

**What T0 must verify (built at 1.725x):**
1. `IPAD_ZOOM = 1.725` is the only zoom literal (the maximum). `z(w)` is monotonic, in `[1, IPAD_ZOOM]`, continuous at 600 and keeps effective >= 375. `CONTROL_ZOOM` (1.45, share 0.62) is derived from it, and a test checks that every table re-derives.
2. The boundaries are correct: window 599/600, effective 639/640 and 759/760 (window 1104 and 1310/1311 at full zoom).
3. The section 4 tables are exact.
4. The type curve holds: `T(fs)` is monotonic, `<= 2z`, `>= min(fs,2)`, and `T(1) = z`; `T(2)/T(1) = 2` (fast-check on [0.8, 3]).
5. Labels fit inside controls at fs 2 in Arabic.
6. `columnsFor` reproduces section 6, and the form-sheet switch happens at 460 eff.
7. iPhone output is pixel-identical.
8. Scroll indicators show, and `SplitLayout` panes scroll independently.

**T0 screenshots** (flow 14, side by side, EN and AR): iPhone 15 against iPad Pro 13-inch in portrait and landscape, for Home, Shop all, Saved, the three checkout steps and a sheet. These show the generic zoom only.

## 14. Test plan
- **Unit (vitest; >= 90% on `size-class.ts`):** T0 checks 1-4 and 6, a compact regression, and `drift.test.ts` (controls >= 44, AA pairs, the entrance scrim pair).
- **Component (RNTL; widths 375, 600, 700, 744, 834, 1032, 1133, 1194, 1376; LTR and RTL):**
  - the role chooser renders phone, band or split at the right width;
  - the brand panel sits at the start;
  - in split mode the toggle sits in the choices pane;
  - `busy` survives a mode change;
  - no feature file reads window dimensions directly.
- **Maestro:**
  - `run.sh --device <udid>`.
  - Flows 01-12 and visual-smoke in EN and AR on **iPad Pro 13-inch (M4) `C2256CDB-5411-4FE9-AC02-A2B92026D838`** and **iPad mini (A17 Pro)**, in portrait and landscape (`setOrientation`, **VERIFY**). Use Expo Go or a dev client with `IOS_SUPPORTS_TABLET=true`.
  - `13-ipad-layout.yaml`: the entrance is split on 13-inch in both orientations, and band on 11-inch and mini in portrait.
  - `14-ipad-side-by-side.yaml` (tag `visual`): the T0 set plus the entrance in all four iPad configurations, each against iPhone.
  - **`15-ipad-no-clip.yaml`:** for every tab screen plus `/role`, `scrollUntilVisible` the end marker. Run it at the default text size and again after `xcrun simctl ui <udid> content_size accessibility-extra-extra-extra-large`, on both iPads in both orientations and on iPhone 15.
- **Manual:** Split View 1/2 and 1/3, Slide Over, and a Stage Manager resize across 600 pt, 640 eff and 760 eff on `/role`. Also a hardware keyboard and a pointer.
- **Gates:** strict typecheck, eslint with both new rules, `check-debt.mjs`, i18n parity, copy-lint, and the performance budget (images at rendered width x pixel ratio, max 1600 px).

## 15. Open questions (owner)
1. Turn on iPad support (ADR-0054)? It means mandatory iPad screenshots, possible App Review on iPad, and it is probably irreversible. Default: **off**.
2. Accessibility: at the largest Dynamic Type, text reaches 3.45x the phone size (the iPhone cap is 2.0x; WCAG 1.4.4 reasoning in section 4). Keep the no-fade default or switch to the 2.0x curve?
3. Entrance on 13-inch portrait: split with a tall art panel (default), or the band layout?
4. Which 6B layout comes next, if any? Default: none until you ask.
5. List the app on Macs ("Designed for iPad")? Default: opt out.
6. Who produces the iPad App Store screenshots, and should they come from flow 14?
