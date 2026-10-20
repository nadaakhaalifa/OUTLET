# Spacing, margins and visual rhythm in luxury-fashion mobile UIs

Scope note: only 6 searches were run; few primary sources were reachable. Brand-app measurements (Zara, COS, Massimo Dutti, Net-a-Porter, Mytheresa, SSENSE, Farfetch, H&M) were NOT found. Anything below labelled INFERENCE is design reasoning, not a measurement.

## What gutter and section spacing values do these apps use, measured or documented?

### Takeaway
No measured or documented gutter/section values for any named luxury app were found. Design-system sources converge on a 4pt base / 8pt rhythm with 16pt edge margins on compact phones (24 on larger windows); Apple does not mandate a single number.

### Cited Findings
- Apple UIKit: root-view default layout margins reflect system minimums and safe-area insets; other subviews default to 8pt per side. Apple points to layout guides rather than a fixed number. — [Apple layoutMargins](https://developer.apple.com/documentation/uikit/uiview/layoutmargins.md), [Apple HIG Layout](https://developer-rno.apple.com/design/human-interface-guidelines/foundations/layout)
- A third-party summary (not Apple) states 16-20pt content margins from screen edges; unverified. — [tomevault HIG summary](https://tomevault.io/tome/wondelai/skills/ios-hig-design)
- Legacy Material spec: 8dp baseline grid, 4dp for type/icons, 16dp left/right screen margins on mobile. — [Material 1 metrics](https://m1.material.io/layout/metrics-keylines.html)
- SAP Fiori (Material-derived): margins 16dp compact, 24dp medium/expanded; intra-component padding in 4/8dp increments. — [SAP Fiori Android layout](https://www.sap.com/design-system/fiori-design-android/v26-4/foundations/adaptive-layout/layout-basics)
- Shopify Polaris: space tokens use a 4px base; space-100 = 4px, space-400 = 16px; tokens only for padding/margin/gap. — [Polaris layout tokens](https://polaris.shopify.com/design/layout/layout-tokens)
- Refactoring UI-derived guidance (secondary): 4px-based scale 4, 8, 12, 16, 24, 32, 48, 64; space between groups must visibly exceed space within groups. — [Blake Crosley](https://blakecrosley.com/blog/five-spacing-decisions)
- Net-a-Porter iOS app was rebuilt on an in-house design system "Hive" (modular reusable components); no spacing values given. — [YNAP press release](https://www.ynap.com/wp-content/uploads/2019/05/YOOX-NET-A-PORTER-GROUP-LAUNCHES-NEW-NET-A-PORTER-APP_ENG.pdf)

### Inferences
- INFERENCE: On a 390pt screen, a 16pt gutter gives 358pt content (two-column grid with 8-12pt gap works); 20-24pt gutters read more editorial but cost image width. For a luxury feel, 16pt gutter with full-bleed imagery, or 24pt with inset text, are defensible; pick one and never mix.
- INFERENCE: Section spacing from the scale: 32 between sections, 48 between major chapters, 8/12 within a group (ratio of at least 2:1 between-group to within-group).

### Gaps
- No measured gutters/section gaps for Zara, COS, Massimo Dutti, Net-a-Porter, Mytheresa, SSENSE, Farfetch or H&M apps found (no teardown with measurements surfaced; Mobbin/Figma inspection would be needed).
- Current Material 3 window-margin values not retrieved from m3.material.io.
- Apple HIG numeric margin not confirmed.

## Corner radii for cards/buttons/images (sharp vs soft) and consistency

### Takeaway
No source documents radii for the named luxury apps. Material scale (extra-small 4 to small 8 and up) is the only documented ladder found; sharp/low-radius is an inference for luxury.

### Cited Findings
- Compose/Wear Material3 shape scale: extra small 4dp, small 8dp, medium 18dp, large 26dp (Wear OS values, a different scale from phone defaults). — [Android Wear Shapes](https://developer.android.com/reference/kotlin/androidx/wear/protolayout/material3/Shapes)
- Compose Material3 defines extraSmall/small/medium/large/extraLarge tokens. — [composables.com Shapes](https://composables.com/docs/androidx.compose.material3/material3/classes/Shapes)
- SSENSE web described as a stark white grid with editorial photography (web, not app). — [Desirability Lab](https://desirabilitylab.com/backfill/backfill-2025-68-ssense-online-retail-design)

### Inferences
- INFERENCE: Use 0pt for product/editorial imagery and 0-4pt for buttons and chips to read as luxury; if any rounding, one token (e.g. 4) everywhere. Mixing 0 images with 12-16 cards is the main inconsistency risk.

### Gaps
- Radii of the named apps unverified. Phone-default Material 3 radii (12/16) not confirmed in results.

## When does a Card help vs a flat hairline layout?

### Takeaway
Secondary guidance says borders are a last resort and proximity/space and background shifts do grouping; hairlines suit lists and tables.

### Cited Findings
- Alternatives to borders: background contrast, shadows, increased spacing; layered two-shadow for realism. — [Refactoring UI summary](https://cdn.jsdelivr.net/npm/claude-code-skills@0.5.0/data/skills/ux-ui-design-system/references/refactoring-ui.md)
- Reserve borders for hard-edge regions (tables, editable areas); background shift as intermediate step; "delete every non-table border" test. — [Blake Crosley](https://blakecrosley.com/blog/five-spacing-decisions)

### Inferences
- INFERENCE: Cards help when content is heterogeneous, tappable as a unit, or must separate from a differing background (e.g., payment summary). Flat plus 0.5pt hairline (or pure whitespace) reads more premium for homogeneous product grids and list rows; product imagery itself should carry the boundary.

### Gaps
- No NN/g or Baymard study comparing card vs flat perceived premium found.

## Anti-patterns that read as "stacked widgets", and fixes

### Takeaway
All findings here are inference from the cited principles above; no teardown source found.

### Cited Findings
- Grouping should come from spacing ratios, not boxes (see above). — [Blake Crosley](https://blakecrosley.com/blog/five-spacing-decisions)

### Inferences
- INFERENCE anti-patterns and fixes:
  - Mixed radii (0 image inside 16 card inside 8 button): choose one radius token; nest by subtracting padding only if rounding at all.
  - Mixed surface colours (white, grey cards, tinted sections): one page plane; at most one alternate tone for a whole band.
  - Double borders (card border plus inner divider/image border): keep one; prefer hairline between rows, none around.
  - Shadow on every card: flat by default; shadow only on floating layers (sheets, sticky bars).
  - Ragged left edges: lock all text/titles/images to the same gutter line; full-bleed images only edge to edge.
  - Uniform section heights: vary rhythm (tall hero, short rail, medium grid) while keeping the same gap token between sections.
  - Heavy section headers with 'See all' buttons in pills: use plain text label plus small text link.

### Gaps
- No measured teardown evidence for the named brands.
