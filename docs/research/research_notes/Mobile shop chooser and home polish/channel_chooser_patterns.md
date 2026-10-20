# Channel chooser patterns: Online vs In-store with nested Local / Global / Both

Scope note: search returned thin results (about 8 tool calls). No first-party teardown of Zara, H&M, IKEA, Nike, Uniqlo, Sephora, Noon, Amazon, Zalando, ASOS, Farfetch, Shein, Namshi, Apple Store or Starbucks channel selection was found. Brand claims are therefore NOT FOUND, not invented. Spec numbers below are labelled verified (cited) or inferred.

## How do the named apps present channel choice (cards vs segmented vs toggle vs sheet)?

### Takeaway
Only Uber Eats' delivery/pickup tab pattern has a (weak) source. For the other named apps no reliable source was found. The best-supported pattern is a visible, mutually exclusive control with an obvious selected state, and the page content changing with the choice.

### Cited Findings
- Uber Eats iOS (c. 2021): filter tabs under the address bar; tapping Pickup turns the grey tab black to show selection and the page content changes (map plus list). Single student critique, dated, opinion — [Pratt IxD critique](https://ixd.prattsi.org/2021/02/design-critique-ubereats-ios-app/)
- Uber moved services into a grid of icons on home in a redesign — [Brand New](https://www.brandknewmag.com/?p=16279)
- Baymard has Uber Eats delivery-method checkout benchmarks (2022, 2024) but findings are paywalled — [Baymard](https://baymard.com/checkout-usability/benchmark/step-type/delivery-options/18557-uber-eats)
- Apple HIG guidance as summarised by third parties: segmented controls for mutually exclusive choices affecting the same content, about 2 to 5 segments, short labels, active segment always visibly highlighted; use a picker for long lists — [Uxcel HIG summary](https://app.uxcel.com/courses/apple-hig/essential-ui-controls-166/segmented-controls-3793) (secondary source)

### Inferences
- Two big image cards is a "destination" choice (different journeys); a segmented control is for a "filter on the same content". Online vs In-store leads to different journeys, so cards fit; Local/Global/Both filters the online catalog, so a segmented/chip row inside the card fits. (inference)

### Gaps
- No sourced teardown for Zara, H&M, IKEA, Nike, Uniqlo, Sephora, Noon, Amazon, Zalando, ASOS, Farfetch, Shein, Namshi, Apple Store, Starbucks, DoorDash, Talabat. Mobbin/Page Flows are login/JS gated and were not reachable via search. Recommend manual screenshots.

## Sub-choices embedded in a selected card (anatomy, sizes, animation, states)

### Takeaway
Design systems treat selectable cards as radio-equivalent controls; expandable content must expose expanded state. Nesting buttons inside a radio-card is a known a11y complexity, so keep the sub-choice a separate radiogroup inside the selected card.

### Cited Findings
- Selectable cards are functionally equivalent to radio/checkbox; group for single selection; use a traditional control when space is tight or options many — [Salt DS](https://www.saltdesignsystem.com/salt/patterns/selectable-card)
- Radio-card markup: role=radiogroup on the group, role=radio per card, aria-checked state, roving tabindex, arrow keys move and select — [FOD selection card](https://fod.dev.egov.md/components/selection-card)
- Volvo places the radio indicator on the card's trailing side and separates radio cards (single) from checkbox cards — [Volvo Cars DS](https://designsystem.volvocars.com/web/components/selectable-cards/usage/)
- Expandable cards expose aria-expanded with an accessible name on the toggle; single-selection group only when one card may be selected — [PatternFly](https://patternfly.org/components/card/accessibility)
- Segmented button height 40 (Flutter M3 implementation) with padded 48dp touch target; Android guidance 48x48dp minimum — [Flutter PR mirror](https://git.hiast.edu.sy/abdullh.alsoleman/front-end/commit/7ff5f81a2ea7190a48131c52e8a14dc65cf9f500) (secondary; official M3 spec page not retrieved)

### Inferences (proposed spec, pt, unverified by any named app)
- Card: radius 20, padding 16, gap between cards 12, screen margin 20 (Apple 16 standard; 20 gives the "better margins" asked for).
- Online card collapsed: image 16:9 or 3:2 top, title + one-line subtitle. Selected: border 2 + check indicator trailing (RTL-aware); sub-choice row appears below the title: 3 equal-width segmented buttons (Local / Global / Both), height 44, gap 8, radius 12, label 15 semibold, min width 96.
- Animation: height/layout transition 220 to 280 ms ease-out (or spring damping ~20, stiffness ~220 in Reanimated), opacity fade of the row 150 ms; with Reduce Motion use instant swap or 100 ms fade.
- Default to "Both" preselected so one tap on the card is enough; sub-buttons visible without a second screen.
- Keep In-store card the same height as collapsed Online to avoid layout jump; expansion pushes it down.

### Gaps
- No sourced real-app measurements for card heights, animation timings or segmented sizes.

## Imagery: photography vs illustration, ratio, scrim, depicting "online"

### Takeaway
Nothing sourced was found; recommendations are inference only.

### Cited Findings
- None found.

### Inferences
- Use photography for In-store (storefront/rack, real outlet) and a photo of a parcel/flat-lay or courier bag for Online instead of a phone mock; same photographic style, crop and color grade for both so they read as peers.
- 16:9 or 3:2 image, bottom scrim gradient (black 0 to 55 percent) only if text overlays; safer: text below the image on a solid surface for contrast >= 4.5:1 (WCAG 1.4.3).
- Do not bake Arabic text into images.

### Gaps
- No sourced guidance on online vs in-store imagery in Noon, Namshi, ASOS etc.

## Margins, tap targets, accessibility, Reduce Motion, RTL

### Takeaway
44 x 44 pt hit targets, 16 to 20 pt margins, 8-pt grid; WCAG 2.2 AA minimum 24 CSS px target; mirror layout for RTL but not photos, numerals, logos.

### Cited Findings
- WCAG 2.2 SC 2.5.8 (AA): targets at least 24x24 CSS px, with spacing exception; 2.5.5 (AAA) asks 44x44 — [DAISY KB](https://kb.daisy.org/publishing/docs/conformance/wcag/target-size-minimum.html), [specification.website](https://specification.website/spec/accessibility/touch-target-size/)
- iOS min hit target 44x44 pt, standard iPhone margins about 16 pt, 8-pt grid — Apple HIG Layout page returned only a title; figures came from the fetch model's memory, NOT verified — [Apple HIG Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- Apple HIG RTL: interface reverses to match script direction; system frameworks support RTL by default; fine-tune currencies, numerals — [Apple HIG Right to left](https://developer-rno.apple.com/design/human-interface-guidelines/foundations/right-to-left)
- Apple legacy guide: with base internationalization and Auto Layout most UI mirrors automatically; phone numbers stay LTR — [Apple BPInternational](https://developer.apple.com/library/ios/documentation/MacOSX/Conceptual/BPInternational/SupportingRight-To-LeftLanguages/SupportingRight-To-LeftLanguages.html)
- Secondary: photos, logos, numerals, media play controls should not mirror — [appscreenshotstudio](https://appscreenshotstudio.com/glossary/rtl) (unconfirmed attribution to HIG)

### Inferences
- React Native: use start/end styles (marginStart, paddingEnd), not left/right; check mark and chevrons mirrored; segmented order follows reading order so Local sits on the right in Arabic.
- a11y: card group accessibilityRole radiogroup (RN: "radiogroup"), each radio with accessibilityState {checked}, sub-segments with {selected}; the revealed row announced via accessibilityLiveRegion or focus move to first sub-button; honour AccessibilityInfo.isReduceMotionEnabled; support Dynamic Type up to xxxLarge by letting segments wrap to a vertical stack.

### Gaps
- Official Material 3 segmented button and card spec numbers not retrieved. Apple Layout page text not retrieved (JS-rendered). W3C Understanding 2.5.8 not fetched directly. Arabic-specific teardown of Noon/Namshi not found.
