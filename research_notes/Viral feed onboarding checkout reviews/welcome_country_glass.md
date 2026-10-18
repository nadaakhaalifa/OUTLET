# First-run "choose your country" welcome screen (frosted glass, Egypt-first)

Research limits: the search tool was weak and several primary pages (ISO OBP, Apple HIG materials, Apple accessibility API docs, CLDR) returned no usable body text or 403/404. Items I could not source are in Gaps, not asserted. Competitor behaviour (Amazon, IKEA, Zara, Noon, Booking, Apple) was NOT verified at all.

## 1. Complete country data, Arabic names, collation, flag emoji

### Takeaway
Build the list from a bundled, versioned JSON generated at build time from ISO 3166-1 alpha-2 plus CLDR (EN and AR names), and use Intl.DisplayNames only as a verified-at-runtime convenience, not the source of truth. Flags are two regional-indicator code points; always provide a text fallback (code or no flag), because unsupported sequences are permitted to render as a fallback glyph.

### Cited Findings
- A flag emoji is "a sequence of two Regional Indicator characters"; a lone regional indicator is not well-formed; only sequences listed in emoji-sequences.txt are valid; conformance lets implementations show a fallback depiction for unsupported/invalid flag sequences — [UTS #51](https://www.unicode.org/reports/tr51/)
- Flag sequences should default to emoji presentation — [UTS #51](https://www.unicode.org/reports/tr51/)
- Kosovo flag (XK, two regional indicators X+K) is listed by Emojipedia as added in Emoji 1.0 (2015) and "may show as the letters XK on some platforms" — [Emojipedia](https://emojipedia.org/flag-kosovo). A second source claims 2010/Unicode 6.0; Emojipedia's date judged more likely, unconfirmed.
- MDN: `new Intl.DisplayNames(["en"], {type:"region"}).of("US")` returns "United States"; `of` accepts ISO 3166-1 alpha-2 or UN M.49 codes; API is Baseline widely available (browsers) — [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DisplayNames)
- Hermes' own Intl doc lists Collator, NumberFormat, DateTimeFormat etc. as supported; `DisplayNames` appears in NEITHER the "both platforms" nor "Android only" lists; results vary by Android version because ICU/CLDR data differ — [Hermes IntlAPIs.md](https://github.com/facebook/hermes/blob/main/doc/IntlAPIs.md) (a newer Hermes version may differ; doc fetched may be stale)
- Repo: app is on Expo `~57.0.27` and has `expo-localization` — local file `/Users/nadakhalifa/OUTLET/apps/mobile/package.json`

### Inferences
- Do not rely on `Intl.DisplayNames('ar')` existing on Hermes; ship generated `countries.ar.json`/`en.json` (CLDR-derived), and feature-test Intl.DisplayNames only to cross-check in a CI/device test (UX/engineering inference).
- Regional-indicator flags on iOS render from Apple Color Emoji; Android relies on the vendor emoji font (older versions may show letters) — general knowledge, unsourced here; mitigate by showing the alpha-2 code as small secondary text or bundling flag SVG/PNG sprites for the 1 served country plus a neutral globe for entries with no flag.
- Exceptions to handle explicitly (names from general knowledge, not sourced): Antarctica (AQ has a flag emoji on current Apple, treat as list-item anyway but mark non-shoppable), XK Kosovo (user-assigned, not ISO), England/Scotland/Wales (subdivision tag sequences, not alpha-2; exclude, they sit under GB), Taiwan (TW) and others per section 2. Data policy: ISO 3166-1 officially assigned codes only (+ optionally XK flagged `userAssigned`), filtered by an explicit allow/deny file reviewed by counsel.
- Arabic sorting and search: sort with `Intl.Collator('ar')` where verified on-device, else pre-sort at build time and store `sortKey`; search should fold alef variants (أ إ آ ا), ya/alef-maqsura (ي ى), ta-marbuta/ha (ة ه optional), strip tashkeel/tatweel, map Eastern Arabic digits. This matches the project's own spec §4 Arabic normalisation requirement (Typesense folding) in `/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md`.

### Gaps
- Could not fetch ISO 3166-1 page (HTTP 403), so the "249 officially assigned codes" figure, UN member count (193 + 2 observers) and the ISO political-status disclaimer are unverified here.
- No CLDR source fetched for Arabic territory names, Arabic collation rules, or `Intl.Collator('ar')` behaviour on Hermes/iOS.
- Whether Hermes in the repo's RN version supports Intl.DisplayNames: unknown; test on device.
- Android emoji-flag rendering gaps and Windows lacking flag glyphs: not sourced.

## 2. Political and legal sensitivities

### Takeaway
Use ISO 3166-1 / UN-style short names with no editorial text, store name and flag as data keyed by code, and have counsel review. Apple's own precedent shows disputed-territory labelling is a live reputational issue, but I found no App Review rule for country pickers.

### Cited Findings
- Apple's Maps/Weather showed Crimea as part of Russia for users in Russia after a Russian law, with dashed borders and no assigned country elsewhere; Apple said it reviews international law and relevant US and domestic laws when labelling, and said it would take "a deeper look" at disputed borders (2019) — [Global News](https://globalnews.ca/news/6230787/apple-crimea-ukraine-russia), [iDropNews](https://www.idropnews.com/news/apple-promises-to-take-a-deeper-look-at-disputed-borders-after-crimea-incident/124154/)
- Apple removed the Taiwan flag emoji from keyboards for Hong Kong users in 2019 (single non-English source, weak) — [RR](https://rr.pt/noticia/amp/mundo/2019/11/28/crimeia-ja-e-parte-da-russia-nas-aplicacoes-da-apple/173451/)
- App Review Guidelines text I could read (5.1.1, 5.1.2) contains no territory/maps rule; the fetch of the last ~12k characters did not complete — [Apple](https://developer.apple.com/app-store/review/guidelines/)

### Inferences
- Defensible policy (inference): one data file, ISO 3166-1 alpha-2 + CLDR short names, no "country of" claims, no map imagery, Taiwan shown by CLDR name, Palestine as "State of Palestine" per CLDR/ISO form as counsel approves, Hong Kong/Macau as their ISO entries, Western Sahara/Kosovo/Crimea: no editorial text, no boundary art; Crimea is not a separate entry. Keep a "territory policy" ADR and make the list server-updatable so a legal request is a data change.
- Egypt-specific legal angle (Israel naming, flag display) was not researched; mark VERIFY BEFORE LAUNCH with counsel.

### Gaps
- How Apple/Google/Amazon/Booking/Airbnb/UN list Taiwan, Palestine, Western Sahara, Kosovo, Hong Kong: not verified.
- Any Apple App Review rule on territory depiction in non-map UI: not found.
- Egyptian law on naming/flag depiction: not found.

## 3. Honest UX when only Egypt is served

### Takeaway
No competitor evidence was gathered. From project rules alone: show Egypt first and selectable, list other countries as "Not available yet" without dates, and offer an opt-in waitlist with explicit unticked consent; unsupported picks should not enter a fake shopping flow.

### Cited Findings
- Spec forbids fake stock/timers/discounts and requires consent never pre-ticked — `/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md` §A2.13, §B1
- GCC expansion is Proposed and blocked; "Egypt only; `market` abstraction built behind the single `EG` value" is the safe default — `/Users/nadakhalifa/OUTLET/docs/adr/0040-gcc-expansion-data-and-currency.md`
- Spec: marketing consent per channel, never pre-ticked, withdrawal in one tap; purposes include `marketing_email` etc. — spec §B1
- NN/g country-selector article fetch returned 404; no NN/g evidence obtained.

### Inferences (UX, unsourced)
- Order: Egypt pinned top, then "Not available yet" group A-Z in Arabic collation. Preselect from `expo-localization` region only if it is EG; otherwise leave no selection (never preselect an unserved country).
- Unsupported pick: bottom sheet "We do not serve {country} yet", actions: "Join the waitlist" (email or phone only after explicit consent; waitlist is a P2 record needing `consent_records`-style purpose and a DPO-reviewed retention), "Browse Egypt" only if shipping/ legal text is clear, "Back". No date, no "coming soon" claim, no counts. Store only country code locally if waitlist declined.
- Lowest-risk waitlist: store interest server-side only after consent, keyed by email hash; otherwise just record nothing.

### Gaps
- Amazon, IKEA, Zara, Noon, Booking, Apple store behaviour: not researched.
- Baymard/NN/g evidence on country selectors: not obtained.

## 4. Glassmorphism luxury on React Native/Expo

### Takeaway
The repo already has a GlassSurface using expo-blur with Reduce Transparency fallback; reuse it. Blur on Android needs BlurTargetView; the existing code intentionally limits blur to iOS.

### Cited Findings
- expo-blur `intensity` 1-100 (default 50); every `tint` adds a translucent layer; Android props `blurMethod` (default `'none'` = semi-transparent view), `dimezisBlurView`, `dimezisBlurViewSdk31Plus`, `blurReductionFactor` (default 4), `blurTarget` via `BlurTargetView`; efficient blur needs Android 12 (SDK 31) RenderNode, older uses RenderScript (slower); BlurView must render after dynamic content (e.g., a FlatList) to update; `borderRadius` not applied, use `overflow:'hidden'` — [Expo BlurView](https://docs.expo.dev/versions/latest/sdk/blur-view/)
- WCAG 1.4.3: 4.5:1 normal text, 3:1 large text (18pt or 14pt bold); text over images is judged against the actual background, background images with insufficient contrast are a failure (F83); ratios are not rounded — [WCAG 2.2 Understanding 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- Repo `GlassSurface`: `BLUR_SUPPORTED = Platform.OS === "ios"`; uses `useTheme().reduceTransparency`, `glassMode()` to fall back to a solid surface; hairline border, sheen, highlight; `Scrim` keeps white text AA over photos — `/Users/nadakhalifa/OUTLET/packages/ui-native/src/components/glass.tsx`
- Repo: expo-haptics and reanimated already used; reduce-motion handling files exist (`packages/ui-native/src/logic/motion.ts`, `components/motion.tsx`)

### Inferences
- Avoid a BlurView per list row (blur is costly; unsourced here but consistent with Expo's perf warnings): put ONE glass panel behind the list/search header and keep rows as flat translucent fills with solid text-safe backgrounds.
- Skia backdrop filters not researched; not recommended given existing expo-blur path.
- Verify contrast of text on glass over worst-case wallpaper imagery; add the existing scrim.
- RTL: use `start/end` (glass.tsx already does), mirror chevrons; flags do not mirror.

### Gaps
- Apple HIG Materials / Liquid Glass (iOS 26) pages returned no body text; nothing cited. Reduce Transparency / Increase Contrast API docs also returned no text. React Native AccessibilityInfo page fetch failed. (`isReduceTransparencyEnabled` exists per Apple API name only.)
- Skia performance numbers: not researched.

## 5. The optional "shop for" step

### Takeaway
Treat it as a skippable browsing preference stored on the device, worded as what to show first, not identity.

### Cited Findings
- Spec: every onboarding step after DOB is skippable; optional preference steps exist already (vibes, sizes, brands) and never block signup — spec §1; `/Users/nadakhalifa/OUTLET/apps/mobile/src/app/onboarding/welcome.tsx`
- Apple 5.1.1(v): apps "may not require users to enter personal information to function, except when directly relevant to the core functionality ... or required by law" — [Apple](https://developer.apple.com/app-store/review/guidelines/)

### Inferences
- Options: Women / Men / Everyone / Prefer not to say (skip). Copy EN: "What would you like to see first?" Arabic draft (needs native review): "ماذا تحب أن تتصفح أولاً؟" with "نساء / رجال / الكل / تخطي". Avoid "Are you".
- Storage: local only (existing storage service) until consent exists; it is sensitive-adjacent, so sync only after account creation with purpose `personalization` consent.

### Gaps
- No sourced research on gender-preference wording or Arabic copy norms.

## 6. Reconciling with spec and law

### Takeaway
A pre-account device-only screen is compatible with spec and Apple rules if nothing is sent to a server or SDK before consent.

### Cited Findings
- Spec §1: accounts need 18+ by DOB; "Guest bag is not supported: an account is required" (§6); SDKs (PostHog, Sentry, ads) initialise only after matching consent (§B1); consent records are explicit, never pre-ticked (§B1) — `/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md`
- Apple 5.1.1(v): "If your app doesn't include significant account-based features, let people use it without a login" — [Apple](https://developer.apple.com/app-store/review/guidelines/). 5.1.2(i): no use/sharing of personal data without permission; apps may not require enabling system functions (push, location, tracking) to access content — same source.
- Repo flow: `index.tsx` resolves entry to `/role` then onboarding (`account`, `consents`, ...); onboarding Stack disables back gestures — `/Users/nadakhalifa/OUTLET/apps/mobile/src/app/index.tsx`, `onboarding/_layout.tsx`, `features/role-choice/model.ts` (EntryRoute list)
- Repo has existing language step but resume marker "language" is legacy; `apps/mobile/src/app/brand/country.tsx` is a brand-applicant country screen, not the shopper picker; ADR-0040 states `market` only behind `EG`.

### Inferences
- Plug-in point: new route before `/role` (or as first screen of `/role` flow) and a new `EntryRoute` plus resume marker; store `{market:'EG', shopFor}` in local storage service; extend `resolveEntry` in `features/role-choice/model.ts`.
- Apple 5.1.1(v) tension: the spec's account-required rule is existing project policy; the new screen should not add more gating, and a browse-only tour would need a spec change (owner decision).
- No server write, no analytics event before consent; location only from coarse device region (`expo-localization`), not GPS.
- ATT not needed (no cross-app tracking per spec §B7).

### Gaps
- PDPL treatment of a locally stored country/preference not verified with counsel; mark VERIFY BEFORE LAUNCH.
