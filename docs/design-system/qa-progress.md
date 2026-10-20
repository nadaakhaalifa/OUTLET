# Rebrand v2 QA progress (simulator, iPhone 16 Pro)
- role: light EN+AR seen. Fixed: top wash + larger wordmark for contrast. (role-choice later under redesign by another agent.)
- onboarding/*, home, explore: pending redesign (skipped per coordinator).
- search (light AR): placeholder clipped; font 15 + tighter padding.
- PDP (light AR): OK; status bar fine on light art.
- checkout (light EN): payable total moved from serif quote to Inter title2 600 (also bag, orders totals).
- orders (light AR): OK.
- returns (light EN): OK.
- wishlists (light EN): raw key "wishlists.filterAll" fixed (count string -> {{n}}).
- addresses (light EN): OK.
- drops: capture lagged (bundle rebuild); not seen. wallet OK. plus (light EN) OK. gift-cards: OK. budget OK. rewards: tier line demoted display->title2. size-profile OK. privacy-center: divider padding fixed.
- dark pass: pdp, checkout, wishlists, stylist, bag, brand type, brand-mode dashboard/products/orders/store, visual-search: OK, no defects.
- settings (light+dark EN): OK; theme override tested (System/Light/Dark).
- help, outfit-calendar (light EN): OK.
- brand/status?demo=approved: infinite spinner without a draft id (deep link); not reachable standalone, needs flow.
- not reached: legal, wardrobe, auto-buy, family-invite, brand country/account/factor/details/documents/website/review, product form, AR dark pass for most.
- Raw keys seen on Home (owned by other agent): shopAll.title/storeFilter/sort/entryTitle/entryBody/bannerUpcoming.

## Wave 2 (iPhone 16 Pro simulator; light EN seen first, dark AR second; light AR and dark EN not re-run)
- home (light EN, dark AR): OK. 100pt drop banner, rows one per row, deep-teal Shop everything entry, no raw keys. Content scrolls under the status bar without a scrim (left as is).
- stores (light EN, dark AR): fixed selected-avatar outline (was a rounded square around a circle and shifted the row); now a circular 2px ring. Sort sheet not reached (chip row would not scroll under synthetic drag).
- shop-all (light EN, dark AR): FIXED AR dark grid columns touched (FlashList lays columns out physically; paddingStart/End flipped). Now physical paddingLeft/Right. Store filter sheet OK.
- explore (light EN, dark AR): OK.
- role (light EN, dark AR): shopper scrim lightened (bottom 0.6, brand 0.85; the two top washes merged into one at 0.9). The atelier art itself still has dark arches at the bottom.
- onboarding account/OTP/consents/welcome (light EN): OK. DOB masked + calendar sheet, checkbox, phone, Send code, Open a store instead, sign-in toggle, language pill all present. Terms/Privacy link buttons no longer indented against the gutter. OTP dev fixture is 000000.
- me, legal, wardrobe, auto-buy, drops (light EN): OK. Legal draft text contains a literal "<row>" token in the source markdown (content, not UI).
- plus (light EN, dark AR): disclosure bar shortened (renews line stays, cancel line behind a "Cancellation and benefits" toggle; trial line stays when applicable). New keys plus.disclosure.more/less.
- brand/status without a draft id: now an empty state with "Start your application" (new keys brandApply.status.noApplication*).
- orders (dark AR): ISO dates scrambled by bidi (the LRI/LRE isolate was ignored by RN Text). Arabic now uses dd/mm/yyyy with Arabic digits, reads correctly.
- brand country/account/factor/review/product-edit (dark AR): OK. brand details/documents show the loading spinner when opened by deep link without a draft (requirements need the draft country; not reachable in the normal flow).
- stylist, visual-search entry, wishlists (dark AR): OK. family-invite is a param route (Unmatched Route when opened bare, expected).
- icon.png / splash-icon.png: new teal/ivory Z. app.config.ts has no splash config and expo-splash-screen is not a dependency, so not added (report).

## Wave 3 (leftovers)
- stores (dark AR): sort sheet opens by tapping the Sort chip (reached by dragging the chip row; scrolling works). Long-press multi-select -> "Shop N stores" -> shop-all with removable store chips: OK. Fixed: selected avatar ring and check were teal on dark (low contrast); now ink-ivory in dark.
- scrim: Screen (ui-native layout.tsx) now draws a 10pt-over-inset ivory/ink gradient under the status bar for every title-less Screen (Home and other tabs with large headers).
- dev preview routes (__styleguide, __art, __purchase): each returns <Redirect href="/"/> when !__DEV__ (code-verified; nothing renders in release).
- home, stores, shop-all, explore, bag, me, role, onboarding account/consents (light AR): OK. Fixed: status-bar clock was white on ivory after role (role StatusBar stayed mounted under the stack; now only while focused); bag quantity stepper showed Western "1" in AR (now localized via valueLabel); store avatar initials low contrast on dark-teal covers (luminance-based initial colour); Home scrim verified (circles fade under the clock).
- role, home, stores, bag, me, onboarding account, settings (dark EN): OK. Fixed raw plural "store(s)" on Home hidden-favourites line (en copy reworded). Deep links to /shop-all and /explore sometimes land on Home when the app is mid-load (harness timing, not a defect).
- Dynamic Type AX-XXXL (home, bag, account creation; dark EN): FIXED home drop banner (fixed 100pt height clipped eyebrow/title/clock; now minHeight, wraps), category shortcut captions overlapped (now max width 76 + scale cap 1.3), Shop everything entry truncated (now wraps 2/4 lines), bag store header squeezed (stacked). Account creation wraps fine. Remaining: the bag sticky footer takes ~35% of the screen at AX-XXXL (scrolls, not clipped).
- plus (top), visual-search entry, outfit-calendar (empty + add form), wardrobe (empty + add piece), drops (live + waiting room), stylist (+ chat entry/history toggle) (dark EN): OK. Note: after a live language switch the layout direction stays at the previous direction until reload (I18nManager), so EN screens looked RTL-aligned in this session; not a layout defect. Waiting-room copy repeats "keep this screen open" twice (minor, left).
- NOT reached in wave 3: Plus family owner/invite-accept, visual-search results, stylist thread/refusal, brand details/documents with a draft, PDP/OTP/welcome in light AR and dark EN, product form (skipped per coordinator).
