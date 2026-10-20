# Dataviz principles, chart choice and accessibility (incl. Arabic/RTL) for seller and admin dashboards

Evidence labels: DOCUMENTED = cited from a page fetched this session. INFERRED = my reasoning. Fetch failures are listed under Gaps.

## Principles (Few, Tufte, NN/g, Polaris, Carbon, FT) and anti-patterns

### Takeaway
Dashboards are for at-a-glance monitoring of a few critical numbers. Encode with position and length, avoid angle/area/3D/colour-for-magnitude, and keep decoration minimal. Few's specific pitfall and bullet-graph rules could not be read (PDFs unparseable); only NN/g, Tufte and FT are verified.

### Cited Findings
- Dashboards support a single task: critical information at a glance, not open-ended exploration. Operational (time-sensitive) vs analytical (less urgent) types. — [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)
- Position and length are judged fast and accurately (bar, line, scatter); sorted bars ease comparison. — [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)
- Do not use colour for magnitude (colour is not perceived as ordered); about 4.5% of people have colour blindness. — [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)
- Avoid pie, donut, treemap, radar and radial gauges (area/angle are hard to compare); pie only for very large disparities; treemaps for exploration; use linear bullet charts instead of gauges. — [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)
- Avoid 3D effects. Group with shape, borders and proximity; colour only as a secondary cue. Fit key content on one screen. — [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)
- Sparkline (Tufte): "small intense, simple, word-sized graphic with typographic resolution"; embeddable in text/tables; aspect ratio long and short, ~45 degree average slope; show recent values against longer history with an optional normal-range band; minimal ink; beware per-line min/max scaling that misleads comparisons; use in stacked multiples. — [Tufte](https://www.edwardtufte.com/notebook/sparkline-theory-and-practice-edward-tufte/)
- FT Visual Vocabulary groups chart types by task: Deviation (diverging bar), Correlation (scatter, XY heatmap), Ranking (ordered bar, slope, lollipop), Distribution (histogram, boxplot, violin), Change over time (line, column, area, fan chart, calendar heatmap), Part-to-whole (stacked column, treemap, waterfall, pie), Magnitude (bar, column, isotype), Spatial (choropleth, proportional symbol), Flow (Sankey, waterfall). Also sections for Uncertainty and Colour. — [FT Visual Vocabulary](https://github.com/Financial-Times/chart-doctor/tree/main/visual-vocabulary)
- Carbon: label charts directly so legends stay short; do not overfill the graph frame; tooltips appear on hover/focus and should repeat values for both axes; slices under 1 degree are not rendered or keyboard-reachable, so a data table is suggested; gradients discouraged. — [Carbon chart anatomy](https://carbondesignsystem.com/data-visualization/chart-anatomy/), [Carbon palettes](https://carbondesignsystem.com/data-visualization/color-palettes/)
- NN/g data tables: first column a human-readable identifier; order columns by importance; visible active-filter indicator; freeze header rows/columns; sort separate from filter; edit in a non-modal side panel rather than a modal; batch actions with row selection and Select All; inline actions only for 1-2. — [NN/g data tables](https://www.nngroup.com/articles/data-tables/)

### Inferences
- INFERRED chart map for seller/admin: trend = line; ranking = sorted bar; target progress = bullet; conversion funnel = horizontal ordered bars with step-to-step %; cohort retention = heatmap with numeric cell labels; P&L/commission bridge = waterfall; return reasons = sorted bar not pie; governorate = sorted bar plus optional map (see Egypt-wide choropleth caution: a table is easier to read on mobile).
- INFERRED anti-pattern list for the rulebook: 3D, pie/donut with many slices, dual axes, truncated bar axes, rainbow palettes, radial gauges, colour-only status. NN/g verifies 3D, pie/donut/gauge and colour-for-magnitude; dual axes, truncated axes and rainbow are not verified here.

### Gaps
- Stephen Few's "13 common pitfalls", bullet graph spec and Information Dashboard Design rules: perceptualedge PDFs returned binary the fetch tool could not parse (files saved locally at /Users/nadakhalifa/.claude/projects/-Users-nadakhalifa-OUTLET/843a52fb-8597-4296-97f6-06e584f1eddb/tool-results/, not read).
- Shopify Polaris data-viz guidance: fetch failed (socket closed; polaris.shopify.com redirects to shopify.dev). Not found.
- Material, Atlassian, GOV.UK analytics and Datawrapper/Observable chart-choice guidance: not fetched (call budget).
- Dual axes, truncated axes, rainbow palettes: no source fetched.

## KPI tile anatomy, comparison periods, small samples, states

### Takeaway
No fetched source specifies a KPI tile anatomy, delta rules, small-sample or stale-state handling. Only the sparkline and bullet-graph principles support parts of it.

### Cited Findings
- Sparklines can sit inside tables/text and show recent values against history, optionally with a normal-range band. — [Tufte](https://www.edwardtufte.com/notebook/sparkline-theory-and-practice-edward-tufte/)
- Linear bullet charts are recommended over radial gauges for target comparison. — [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)

### Inferences
- INFERRED tile anatomy: label with definition tooltip; value; delta vs previous equal-length period (absolute and %, with arrow plus text, not colour only); sparkline with consistent scale; target/threshold via a bullet bar; "as of" timestamp; badge "Live" vs "Updated hourly/daily (batch)".
- INFERRED small samples: show n, suppress or flag "low volume" percentages below a threshold, show interval or range where computed. The product spec already requires k>=50 aggregation for sellers (master prompt 19.1).
- INFERRED states: empty (explain why and next action), stale (grey out plus timestamp), error (retry, last good value), loading skeleton.

### Gaps
- No documented source for KPI tile conventions, confidence interval display, or state patterns (Polaris, Atlassian, Carbon dashboard pages not read).

## Accessibility (WCAG 2.2, ARIA, palettes, Highcharts, Chartability)

### Takeaway
Never rely on colour alone, give graphics 3:1 contrast, provide a long text/table alternative, and make charts keyboard-reachable. Chartability's own site was unreachable, so its heuristics are not verified.

### Cited Findings
- 1.4.1 (Level A): colour must not be the only visual means of conveying information; for chart series add pattern or text (G111, G14); text alternatives must include info conveyed by colour; lightness difference of 3:1 counts as an extra cue but does not replace an indicator if colours must be told apart. — [WCAG 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- 1.4.11 (AA): graphical objects needed to understand content need 3:1 against adjacent colours; line chart lines need 3:1 against background, not each other if they rarely overlap; pie slice edges need 3:1 unless labels/values convey the same; chart text follows 1.4.3. — [WCAG 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- 2.5.8 (AA): pointer targets at least 24x24 CSS px, or spacing such that a 24px circle on each undersized target does not intersect another target; exceptions for inline links, user-agent controls, equivalents, essential. — [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- Complex images need a short description plus a long description (text/table) via adjacent link, `<figure role="group">`+`<figcaption>`, or `aria-describedby` (only for unstructured text); include scales, values, relationships, trends. — [W3C WAI complex images](https://www.w3.org/WAI/tutorials/images/complex/)
- Okabe-Ito/Jikei guidance: do not convey information by colour alone (add shape, position, line type, hatching); alternate warm and cool; avoid low-saturation/low-brightness combos; use darker blue/orange for thin lines; test with simulators but also colour-blind reviewers. Full hex table not on the page. — [Okabe and Ito, jfly.uni-koeln.de](https://jfly.uni-koeln.de/color/)
- Carbon: categorical palette is 14 colours applied in a fixed sequence curated for neighbour contrast; single-hue overrides when count is known; the page gives no colour-blind rules or non-colour cues. — [Carbon palettes](https://carbondesignsystem.com/data-visualization/color-palettes/)
- Highcharts accessibility module: keyboard navigation, ARIA roles and descriptions (otherwise chart reads as image with title only), data table via export-data, sonification, visible linked description recommended over hidden description. — [Highcharts](https://www.highcharts.com/docs/accessibility/accessibility-module)

### Inferences
- INFERRED rule: every chart gets a visible "View as table" toggle and a text summary of the headline insight; status uses icon/text plus colour; tap targets >=24px (prefer 44px on mobile, consistent with the product's 44-pt rule in the master prompt section 25); direct labels over legends.
- INFERRED: use Okabe-Ito (8 colours) or Carbon's palette for categorical series, capped at about 5-6 series per chart.

### Gaps
- Chartability heuristics (chartability.fyi): DNS failure on both hosts. Not found.
- Paul Tol and ColorBrewer palettes, ARIA chart role patterns (graphics-document etc.): not fetched.
- Okabe-Ito hex values: not found on the fetched page.

## Arabic/RTL

### Takeaway
Time-based sequences flip to run right to left, but charts and graphs are generally not mirrored per Material/Wikimedia; libraries often do not auto-handle axes. Use bidi isolation for mixed labels and `ar-EG` Intl for numerals.

### Cited Findings
- Per a search summary of Material and Mozilla guidance: time progresses right to left in RTL; Material lists charts and graphs as not mirrored; Wikimedia says not to mirror charts when it changes data reading, and timelines/sequences do flip. — [Material bidirectionality (mdui mirror)](https://www.mdui.org/en/design/1/usability/bidirectionality.html), [Wikimedia Codex](https://doc.wikimedia.org/codex/v1.18.0/style-guide/bidirectionality.html), [Mozilla RTL guidelines](https://searchfox.org/firefox-main/source/docs/code-quality/coding-style/rtl_guidelines.md). Note: the Material page itself fetched empty; this rests on the search summary.
- AG Charts RTL mode does not change axis positions/directions (set manually); legend layout and series order mirror. — [AG Charts RTL](https://ag-grid.com/charts/vue/rtl/) (search summary)
- Bidi markup: wrap every opposite-direction phrase tightly with `dir` and `lang`; use `dir="auto"` or `<bdi>` when direction is unknown at runtime; use Unicode isolates (RLI/LRI/FSI + PDI) where markup is impossible, avoid embedding controls. — [W3C inline bidi markup](https://www.w3.org/International/articles/inline-bidi-markup/)
- `new Intl.NumberFormat("ar-EG").format(123456.789)` outputs `١٢٣٤٥٦٫٧٨٩`; the `-u-nu-` extension key selects a numbering system. — [MDN Intl.NumberFormat](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat)
- Carbon chart anatomy page does not mention RTL. — [Carbon chart anatomy](https://carbondesignsystem.com/data-visualization/chart-anatomy/)

### Inferences
- INFERRED convention to decide with the Arabic UX reviewer: time axis oldest-at-right (flip) vs keep LTR; Material suggests flipping time sequences but not charts generally, so this is a contested point. Keep numerals consistent with the product's numeral preference (master prompt section 25: Western or Eastern digits, `ar-EG` default Arabic-Indic), and pass `-u-nu-latn` for Western.
- INFERRED: expect ~20-30% text expansion in labels either direction; truncate with tooltips; put currency (`ج.م`) per locale formatter, not string concatenation; wrap store names (often Latin) in `<bdi>`.

### Gaps
- Fluent/Carbon RTL chart guidance, W3C i18n pages specifically on charts, numeral conventions on axes in Arabic publications: not found.
- Text-expansion percentage: no source.

## Mobile-friendly seller dashboards

### Takeaway
Not covered by any fetched source beyond general principles.

### Cited Findings
- Dashboards should fit one screen and focus on key relationships. — [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)
- Non-modal side panels over modals for record detail in tables; freeze headers. — [NN/g data tables](https://www.nngroup.com/articles/data-tables/)
- 24px minimum target (WCAG AA). — [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

### Inferences
- INFERRED: stacked KPI cards with sparklines, tables collapsing to cards, bottom sheets for filters, a single primary metric per screen.

### Gaps
- No fetched mobile dashboard source (NN/g mobile, Polaris mobile).
