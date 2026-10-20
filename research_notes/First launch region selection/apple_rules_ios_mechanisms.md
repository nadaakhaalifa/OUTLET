# Apple rules and iOS mechanisms for a first-launch region/country picker

Research limits: WebFetch was blocked for developer.apple.com and docs.expo.dev in this session. Only two WebSearch calls returned usable snippets (developer forum threads and the Apple StoreKit doc URL). Anything marked [UNVERIFIED] comes from background knowledge and must be re-checked against the primary page before it is relied on.

## (a) Account requirement, guest browsing, and whether a first-launch picker passes review

### Takeaway
Apple's 5.1.1 guidance says apps may not force registration before features that are not account-based, and e-commerce browsing before sign-in is the guideline's own example. A region picker is not an account gate. A one-time picker is low risk if it is quick and the user can browse afterwards. Keep it skippable or defaulted rather than a hard wall.

### Cited Findings
- Developer forum posts quote Apple as saying apps cannot make users sign in before reaching features that do not depend on an account. Apple's examples are an e-commerce app that allows browsing before registering and a restaurant app that allows reading the menu before ordering. Personal information may be required only where tied to core function or required by law. — [Apple forum: 5.1.1 rejection](https://developer.apple.com/forums/thread/758625); [Apple forum: 5.1.1 data collection](https://developer.apple.com/forums/thread/656591)
- A developer reported approval after adding a "Continue without signing in" option. A separate report suggests a UI shell alone is not enough if core actions still need an account. Reviewers are described as inconsistent. These are anecdotes, not Apple policy. — [Apple forum: 5.1.1(v) rejection](https://developer.apple.com/forums/thread/835254); [Apple forum: login rejection](https://developer.apple.com/forums/thread/759910)
- The search results did not return Apple's official guideline text. Exact wording and numbering must be checked at [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

### Inferences
- The spec (guest bag unsupported, account required to buy, 18+ gate) is compatible if browsing the catalog works without an account. Under the master prompt, the account is needed for the bag, so require sign-in at add-to-bag or checkout, not at launch. [Inference; the guest-bag rule in master prompt section 6 may need a "browse as guest, sign in to add to bag" carve-out.]
- Account deletion in-app (5.1.1(v)) is already in the spec (section 2) and Sign in with Apple is already required alongside Google (master prompt B7). [Both from the project spec, not newly verified here.]
- HIG onboarding guidance (short, skippable, ask for permissions in context) [UNVERIFIED, fetch blocked]: a single picker with a pre-selected default and one Continue button fits it.

### Gaps
- Exact current text of 5.1.1(i)-(v), 4.0 design and HIG onboarding were not retrievable. No Apple text was found that bans a forced choice before browsing, but absence of evidence only.

## (b) Location permission vs. asking the user to pick a country

### Takeaway
Prefer a country picker over a location prompt. A country is not precise location, and asking for GPS on first launch to infer a country is disproportionate and hurts review and user trust.

### Cited Findings
- No sourced finding in this session.

### Inferences
- [UNVERIFIED, from memory of 5.1.1/5.1.5] Apple requires location use to be relevant to features and purpose strings to be accurate. A country choice needs no permission, so no purpose string and no `NSLocation*` key.
- The master prompt already lists `location_precise` as a separate consent purpose (B1), so country selection should not depend on it.

### Gaps
- Exact 5.1.5 wording not verified.

## (c) Onboarding screens that block content

### Takeaway
No rule found against a blocking first-run screen, but reviewers can reject apps that appear to need unnecessary gates. Minimise it to one step and let the user change it later.

### Cited Findings
- Only the 5.1.1 forum evidence above (blocking behind registration for non-account features is rejected). — [Apple forum](https://developer.apple.com/forums/thread/758625)

### Inferences
- Pre-select a detected default and make the screen one tap; this also covers the Egypt-first launch where most users keep the default.

### Gaps
- HIG onboarding page not retrieved.

## (d) Restricting to certain countries; "not available in your country yet"

### Takeaway
The cleanest mechanism is App Store Connect availability by storefront: list the app only in Egypt (and later other launch countries). If it must be listed worldwide, an in-app "not available yet" state must still show real content or a working waitlist, otherwise a reviewer in another storefront may reject it as a non-functional or placeholder app.

### Cited Findings
- No sourced finding in this session.

### Inferences
- [UNVERIFIED] Reviewers test from a US or other storefront and use a demo account. If the app is blocked for their region, they cannot review it. Mitigation: a reviewer path (demo account or a region override documented in review notes), which the master prompt already requires (B7: demo reviewer account).
- [UNVERIFIED] Guidelines 2.1 (completeness) and 4.2 (minimum functionality) are the likely risks for a screen that is only a "coming soon" wall. A waitlist or limited browsing reduces this.
- Master prompt B7 already says the US storefront gets link-out only behind a flag and Egypt gets no anti-steering relief, so storefront logic already exists conceptually.

### Gaps
- App Store Connect availability documentation was not fetched. Behaviour for users who travel or change storefront was not verified.

## (e) Language and locale; per-app language in iOS Settings

### Takeaway
iOS 13+ lets users set a per-app language in Settings when the app declares more than one localization. The app should treat that as the source of truth for UI language and keep country (market) as a separate setting from language.

### Cited Findings
- No sourced finding in this session (Apple and Expo docs were blocked).

### Inferences
- [UNVERIFIED] The per-app language entry appears when the bundle has multiple localizations (`CFBundleLocalizations`). In Expo this is configured through `expo-localization` config plugin `supportedLocales` or the `locales` / `CFBundleLocalizations` entries. Verify against the Expo `expo-localization` page.
- [UNVERIFIED] `Locale.preferredLanguages` reflects the per-app override, so `getLocales()` from `expo-localization` should too. Master prompt T2 says RTL goes through `I18nManager` with a reload flow, so a language change inside the app needs a restart prompt.
- Keep language and country as two settings: Arabic-speaking users may pick another country, and English speakers in Egypt are common.

### Gaps
- Exact Expo SDK 57 config plugin keys and behaviour were not verified.

## (f) Detecting a default region without permissions

### Takeaway
Three signals exist and none is a certainty. Use them only to pre-select a default, never to lock a user in.

### Cited Findings
- `Storefront.countryCode` is a three-letter ISO 3166-1 alpha-3 code for the App Store storefront (for example "EGY"), so it must be mapped to alpha-2. — [Apple: Storefront.countryCode](https://developer.apple.com/documentation/storekit/storefront/countrycode.md); [billing_country plugin note](https://pub.dev/packages/billing_country)
- Forum reports say `Storefront.current` returned the wrong storefront on TestFlight and had issues in some test environments. These are unconfirmed user reports. — [Apple forum 843085](https://developer.apple.com/forums/thread/843085); [Apple forum 778384](https://developer.apple.com/forums/thread/778384)

### Inferences
- Locale region (`getLocales()[0].regionCode`): reflects the device Region setting, which users often leave at the manufacturer or travel default and which can be null. [UNVERIFIED]
- Device language: says nothing reliable about country (an Arabic UI may be used in any Arab country).
- Storefront: reflects the Apple ID country, usually where the card or billing is, harder to change than Region, and a good signal for purchase market. It needs StoreKit (an extra native module in Expo) and has the test-environment caveats above. [Inference]
- Suggested order for the default: Storefront (if available) then Locale region then Egypt as the launch market, always editable.
- Privacy and tracking: reading these values for a local default, with no transmission to third parties and no cross-app linking, does not need App Tracking Transparency. Required-reason API categories in `PrivacyInfo.xcprivacy` apply to specific APIs (for example UserDefaults, file timestamps); using `UserDefaults`/MMKV for the persisted choice may need a declared reason. [UNVERIFIED; check the required-reason API list]. Master prompt B7 already sets default ATT to none.

### Persistence and Settings
- Persist the choice on device (MMKV for non-sensitive prefs per master prompt T2) and, once signed in, on the server account, with the device value used before sign-in. Expose "Country/Region" and "Language" in Me > Settings. [Inference from the spec]
- iOS Settings per-app language covers language only, not country; country must live in-app. [UNVERIFIED]

### Gaps
- No primary-source check of Locale region reliability, null cases, or Storefront availability in Expo (no first-party Expo module found in this session).
- Nothing was found about restricting service to Egypt while listed worldwide beyond the inferences in (d).
