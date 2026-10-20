# Shopping apps: country/region choice behaviour (Amazon, Noon, Zalando, SHEIN, Namshi, ASOS)

Research status: web search only; direct fetches of retailer/App Store pages were blocked, and no first-launch screens were observed. Most first-launch questions are unverified. No primary help-centre page was read in full; claims below come from search-result snippets.

## Region on first launch only vs every launch, per app

### Takeaway
No source describes a per-launch region prompt for any of the six apps. Evidence on first-launch screens (look, skippability, blocking) was not found for any app. Treat first-launch behaviour as unverified and as a gap.

### Cited Findings
- ASOS: country and currency are set later via Account > Settings (iOS); no first-launch prompt documented — [ASOS help](https://www.asos.com/customer-care/technical/can-you-help-me-with-the-asos-app), [ASOS US help](https://www.asos.com/us/customer-care/product-stock/why-cant-i-ship-a-brand-to-my-country-from-the-app)
- Namshi's App Store listing names its markets (Saudi, UAE, Kuwait, Oman, Bahrain, Qatar; a newer listing adds Iraq) and two languages (English, Arabic) — [App Store](https://apps.apple.com/us/app/-/id840127349) (via search snippet)
- Noon launched UAE and Saudi in 2017 and Egypt later, as separate country operations — [Gulf Business](https://mot-backup.gulfbusiness.com/?p=140718)

### Inferences
- Because settings are the documented change path (ASOS, Amazon), region is most likely a persisted preference rather than asked each launch. This is inference, not observed.

### Gaps
- First-launch screen appearance, skippability, and whether browsing is blocked: not found for any app. Needs hands-on test of each iOS app (fresh install, with and without location permission, Egyptian locale/IP).
- Whether any app detects by device locale, storefront or IP: not found.

## Where the change-region control lives and what it does

### Takeaway
Amazon: flag in the user tab (per Amazon UK blog summary), also reported under Settings > Country & Language; sets country, language and currency, and does not move the account. ASOS: Account > Settings icon, choose country and currency. Others unverified.

### Cited Findings
- Amazon lets shoppers pick country, language and currency manually (22 locations); in-app via the flag in the user tab; account stays linked to its original country — [Amazon UK](https://aboutamazon.co.uk/news/retail/how-to-change-amazon-country) (search summary, page not fetched)
- Third-party guides say Prime and digital content may be region-locked after switching, and payment method/address must match the new country — [ghacks](https://ghacks.net/?p=178183) (low-quality, secondary)
- Amazon "Deliver to" location is separate from the store; a third-party tip says it can hide items until the address is changed (not official) — [ghacks](https://ghacks.net/?p=178183)
- ASOS: iOS path is My Account > Settings icon (top right) > country to browse from and currency; Android uses the left-menu Settings panel; available currencies depend on the chosen country — [ASOS help](https://www.asos.com/customer-care/technical/can-you-help-me-with-the-asos-app)
- Zalando: App Store reviewers say changing language switched them to another country's store automatically and asked for language to be separate from country; developer replies only point to Help & FAQ — [App Store reviews](https://apps.apple.com/app/id585629514)
- Zalando runs a localized site per country with local currency and customer service — [ordertracker (secondary)](https://www.ordertracker.com/couriers/zalando)
- Bag reset on region change: no source found for any app.

### Inferences
- Region, language and currency are usually coupled (Zalando reviews, ASOS currency list per country), which is a known user complaint; Z-OUTLET could decouple language from country.

### Gaps
- Noon, SHEIN, Namshi change-region path and tap count: no primary or reliable source found.
- Tap counts for any app: not verified.
- Effect on bag, saved addresses, and payment methods: not found.

## Blocking browsing, forced sign-in or location permission

### Takeaway
No evidence found that any of the six block browsing or force sign-in to pick a region. This is an absence of evidence, not confirmation.

### Cited Findings
- ASOS and Amazon region changes are done from Settings/user tab, with no sign-in requirement stated in the sources read — [ASOS help](https://www.asos.com/customer-care/technical/can-you-help-me-with-the-asos-app)

### Gaps
- Location-permission use for region detection: not found for any app.

## Unsupported countries and delivery limits

### Takeaway
Observed pattern is "browse any storefront, restrictions revealed late": ASOS and Zalando show per-item shipping restrictions on the product page or at checkout, rather than a global block. Waitlist or redirect patterns for unserved countries were not found.

### Cited Findings
- ASOS: some brands cannot ship to some countries; this is determined once the delivery address is chosen at checkout; affected items say so on the product page below add to cart — [ASOS](https://www.asos.com/au/customer-care/product-stock/why-do-certain-items-not-ship-to-my-country)
- Zalando: a reviewer found items undeliverable to their country, shown only at checkout — [App Store reviews](https://apps.apple.com/app/id585629514)
- Retailer-independent claim that SHEIN does not serve every country comes from forwarding-service sites with a commercial interest — [forwardme](https://www.forwardme.com/blog/shop-from-shein-ship-internationally)
- Namshi's listed market set (Gulf plus Iraq) implies other countries are simply not offered; no waitlist found — [App Store](https://apps.apple.com/us/app/-/id840127349)

### Inferences
- Late disclosure of shipping limits is a documented user complaint (Zalando); for Z-OUTLET, showing availability at the region choice or on the product page is likely better.

### Gaps
- Baymard / NN/g guidance on country selectors: a search returned none; only vendor geo-redirect tools (Shopify plugins, ipgeolocation.io) which are commercially motivated.
- Waitlist, "ship to" list, or storefront-redirect patterns for unserved countries: none verified.
- Detection method (IP vs locale vs storefront) for each app: none verified.
