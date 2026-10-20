# Arabic copy review, 2026-10-16

Scope: new keys in `packages/i18n/src/ar.ts` and `en.ts` (git diff vs HEAD): `shopFilter.*`, `storesDir.*` (step/mode/outlets), `storesDir.filter.*`, plus spot checks of other new groups. `apps/mobile/locales/*.json` not reviewed in detail. Read-only review; no i18n files edited.

**Legal wording (regionNote, regionValue, discount copy) needs approval by a native Arabic speaker and Egyptian counsel before launch (verify row 11, CPL 181/2018).**

## Method notes
- Plurals are NOT CLDR/i18next. Code picks keys by hand: `appliedCountKey` in `apps/mobile/src/features/shop-all/model.ts`: 1 -> One, 2 -> Two, 3..10 -> Few, else Many. No zero form exists. Results: 0 -> Many ("0 filters" / "0 فلترًا"), 1, 2, 3, 10 correct, 11 correct, 100 correct ("100 فلترًا"), 102 ok in practice. Fine as long as 0 is never shown (guard with `showNone` for outlets; check `appliedLabel` when count is 0).
- Placeholders keep RTL order fine. Numerals are formatted by the app helper (`{{n}}`, `{{pct}}` passed pre-formatted); only exceptions are hard-coded digits in copy (below).
- Terminology as the app uses it today: button/title = "تصفية" (about 25 uses); items = "فلتر/فلاتر" (shopFilter chips, quickFilters, appliedLabel); storesDir.emptyBody/clearFilters use "عوامل التصفية". Bag: tab and many strings now say "السلة", but several keep "الحقيبة".

## Table

| key | current Arabic | current English | verdict | suggested Arabic | reason |
|---|---|---|---|---|---|
| shopFilter.quickFilters | فلاتر سريعة | Quick filters | OK | | |
| shopFilter.filterChip | تصفية | Filter | OK | | |
| shopFilter.filterChipCount | تصفية، {{count}} مطبّق | Filter, {{count}} applied | improve | تصفية، {{count}} مطبّقة | Count reads as a number of filters; "مطبّق" is wrong for 2 to 10 (plural needs feminine/plural agreement, and "تصفية" is feminine). Better to use the applied plural keys. Same issue in storesDir.filter.buttonLabelCount. |
| shopFilter.newArrivals | وصل حديثًا | New arrivals | OK | | Other places spell "وصل حديثاً" (tanween on alef vs on ا): normalise spelling app-wide. |
| shopFilter.freeDelivery | توصيل مجاني | Free delivery | OK | | Must only show items truly free (spec: store threshold or Plus); label is fine. |
| shopFilter.lowest30d | أقل سعر خلال ٣٠ يومًا | Lowest in 30 days | improve | أقل سعر في آخر {{days}} يومًا | Hard-coded Eastern digits "٣٠" bypass the numeral helper (user may prefer Western). Also English "Lowest in 30 days" lacks "price" and hard-codes 30. If kept fixed, use a param. Meaning matches the spec badge. |
| shopFilter.discountHeading | الخصم الموثّق | Verified discount | OK | | Matches spec wording. |
| shopFilter.discountAny | الكل | Any | improve | أي نسبة | "الكل" is not "any". |
| shopFilter.discountStep | {{pct}} فأكثر | {{pct}} or more | OK | | Pass pct with "٪"/"%" from helper. |
| shopFilter.discountNote | نحتسب فقط الخصومات التي تحققنا منها. | Only discounts we have verified are counted. | OK | | Honest and clear. |
| shopFilter.discountApplied | خصم موثّق {{pct}} فأكثر | Verified discount {{pct}} or more | OK | | |
| shopFilter.sectionPrice | السعر | Price | OK | | |
| shopFilter.sectionDepartment | قسم التسوق | Department | OK | | Fine; "القسم" alone also works. |
| shopFilter.conditionHeading | الحالة | Condition | OK | | |
| condition labels (shopFilter-level, ar.ts ~line 759) | جديد بالبطاقة / جديد بدون بطاقة / عيّنة / عيب بسيط | New with tags / New without tags / Sample / Minor defect | improve | جديد بالتيكت / جديد بدون تيكت (optional), عيّنة (عيّنة من الماركة), عيب بسيط | "بالبطاقة" can be read as ID/credit card. Egyptians say "تيكت" or "بالتاج". Also "عيّنة"/"عيّنة" spelling differs from "عينة" in line 2197 (without shadda): unify. "عيب بسيط" must be paired with disclosed defect photos (spec); fine. |
| condition labels (PDP, line 695) | الحالة: جديد بالبطاقة ... | Condition: new with tags | OK | | Same wording note as above. |
| shopFilter.deliveryHeading | التوصيل والعروض | Delivery and deals | OK | | |
| shopFilter.showResults | عرض النتائج | Show results | OK | | |
| shopFilter.removeFilter | إزالة {{name}} | Remove {{name}} | OK | | |
| shopFilter.appliedLabel | الفلاتر المطبّقة | Applied filters | OK | | |
| shopFilter.appliedOne | تم تطبيق فلتر واحد | 1 filter applied | OK | | |
| shopFilter.appliedTwo | تم تطبيق فلترين | 2 filters applied | OK | | Correct dual. |
| shopFilter.appliedFew | تم تطبيق {{n}} فلاتر | {{n}} filters applied | OK | | Correct for 3 to 10. |
| shopFilter.appliedMany | تم تطبيق {{n}} فلترًا | {{n}} filters applied | improve | تم تطبيق {{n}} فلتر | Grammatically correct but stiff MSA; Egyptian shoppers read "فلترًا" as bookish. Either accepted; the accusative form is correct for 11+. Also 0 would show "0 فلترًا" (wrong): never render at 0. |
| shopFilter.clearAll | مسح الكل | Clear all | OK | | |
| shopFilter.clearQuery | مسح البحث | Clear search | OK | | |
| shopFilter.count | {{n}} قطعة | {{n}} items | improve | key set with One/Two/Few/Many, or "عدد القطع: {{n}}" | "3 قطعة" and "10 قطعة" are a number-agreement error (should be قطع). Common in colloquial use, but this is user-facing legal-ish text; "عدد القطع" avoids it. |
| shopFilter.emptyFiltersTitle/Body | لا توجد قطع تطابق هذه الفلاتر / جرّب إزالة فلتر لعرض المزيد. | No items match these filters / Try removing a filter to see more. | OK | | |
| shopFilter.emptyBudgetBody | جرّب ميزانية أعلى، أو خفّف فلتر القسم أو المتاجر. | Try a higher budget, or loosen the category or stores. | improve | جرّب ميزانية أكبر، أو خفّف فلتر القسم أو المتاجر. | "أعلى" is fine; EN "loosen the category or stores" is unclear: "or remove the category or store filters". |
| shopFilter.errorInvalid | اكتب رقمًا، مثل ٥٠٠ أو ٤٩٩٫٥٠. | Enter a number, like 500 or 499.50. | improve | اكتب رقمًا، مثل {{example1}} أو {{example2}} | Hard-coded Eastern digits and decimal separator in AR; EN uses Western. Ignores the numeral helper. |
| shopFilter.budgetHint | يمكنك كتابة الأرقام بالعربية أو الإنجليزية | Numbers in English or Arabic digits | improve | يمكنك كتابة الأرقام بالعربية أو الإنجليزية (٣ أو 3) | "Numbers in English" is imprecise; say "Western digits". AR: "الإنجليزية" is colloquially fine. |
| shopFilter.privacy | الميزانية تُستخدم لتصفية هذه القائمة فقط، ولا تُحفظ ولا تُشارك. | Your budget only filters this list. It is not saved or shared. | OK (verify) | | Good, but must be true in code (budget is P3/opt-in per spec section 12). Engineering to confirm no persistence. |
| shopFilter.stepUp / stepDown | زيادة {{field}} / تقليل {{field}} | Increase/Decrease {{field}} | OK | | |
| shopFilter.presetUnder/Between/Over | أقل من {{max}} / من {{min}} إلى {{max}} / {{min}} فأكثر | Under / to / and up | OK | | Pass amounts with "ج.م" from helper. |
| shopFilter.searchPlaceholder | ابحث عن قطعة، مثل تيشيرت | Search items, like T-shirt | OK | | |
| shopFilter.categoriesChip | الأقسام · {{count}} | Categories · {{count}} | OK | | |
| shopFilter.categoryLimit | يمكنك اختيار حتى {{max}} قسمًا. | You can pick up to {{max}} categories. | improve | يمكنك اختيار {{max}} أقسام كحد أقصى. | Number agreement depends on max (3..10 takes plural "أقسام"); "قسمًا" is right only for 11+. |
| storesDir.stepModeTitle | كيف تحب تتسوّق؟ | How do you want to shop? | OK | | Colloquial Egyptian ("تحب"); mixed register vs the rest of the app which is MSA. Acceptable, but pick one register (see issues). |
| storesDir.modeOnline | المتاجر الإلكترونية | Online stores | OK | | |
| storesDir.modeInStore | المنافذ | Outlets | OK | | Clear in Egypt ("منافذ بيع"). |
| storesDir.modeOnlineSub | تسوّق عروض المخزون من بيتك | Shop outlet deals from home | improve | تسوّق عروض الأوتلت من بيتك | "عروض المخزون" is a literal translation of "stock deals". |
| storesDir.modeInStoreSub | زُر أحد منافذنا القريبة منك | Visit an outlet shop near you | improve | اعرف أقرب منفذ ليك | Claims "near you" and "our outlets" while inStoreTitle says no locations exist yet: contradicts. Show only when data exists. |
| storesDir.outletsTitle | منافذ البيع | Outlet shops | OK | | |
| storesDir.onlineListTitle | المتاجر الإلكترونية | Online stores | OK | | |
| storesDir.findOutlets | ابحث عن المنافذ | Find outlets | OK | | |
| storesDir.heroNearestBody | اكتشف مواقع منافذنا وزرنا اليوم. | Discover our outlet locations and visit us today. | wrong | (hide until data exists) | Promotional claim with no locations to show (`inStoreTitle`: "not available yet"). Misleading under CPL 181/2018 if shown. "Visit us today" also implies opening hours. |
| storesDir.heroNearestTitle | اعثر على أقرب متجر إليك | Find your nearest store | improve | | Same issue: no distance/location feature backs it. |
| storesDir.stepScopeTitle | أي متاجر؟ | Which stores? | OK | | |
| storesDir.scopeLabel | المعروض: {{scope}} | Showing: {{scope}} | OK | | |
| storesDir.modeScopeLabel | {{mode}}، {{scope}} | {{mode}}, {{scope}} | OK | | |
| storesDir.scopeBoth | الاثنان | Both | OK | | |
| storesDir.viewStoresTitle | عرض المتاجر | View Stores | improve (EN) | | EN has stray title case ("View Stores"). Use "View stores". |
| storesDir.inStoreTitle | منافذ البيع غير متاحة بعد | Outlet shops are not available yet | improve | لا توجد منافذ بيع لعرضها حاليًا | "Not available yet" implies a launch promise ("coming soon"-like). Use neutral "none to show right now". |
| storesDir.inStoreBody | لا تتوفر لدينا مواقع منافذ البيع أو مواعيد العمل بعد. | We do not have outlet shop locations or opening hours to show yet. | improve | لا تتوفر لدينا مواقع المنافذ ولا مواعيد العمل حاليًا. | Remove "بعد"/"yet" promise. |
| storesDir.inStoreAction | العودة إلى المتاجر الإلكترونية | Back to online stores | OK | | |
| storesDir.openNow / closedNow / closesAt | مفتوح / مغلق / يغلق {{time}} | Open / Closed / Closes {{time}} | OK | | |
| storesDir.count | {{n}} متجر | {{n}} stores | improve | add One/Two/Few/Many | "3 متجر" is an agreement error. |
| storesDir.shopSelected | تسوّق من {{n}} متاجر | Shop {{n}} stores | improve | | Wrong at 11+ ("11 متاجر"). Needs Many form (متجرًا) or a neutral "تسوّق من المتاجر المختارة ({{n}})". |
| storesDir.searchPlaceholderOutlets | ابحث عن منفذ أو مدينة... | Search outlets or city... | improve | ابحث عن منفذ أو مدينة | Ellipsis is unnecessary punctuation. Same for searchPlaceholderCity and shopAll.searchPlaceholder. |
| storesDir.filter.button | تصفية | Filter | OK | | |
| storesDir.filter.buttonLabel | تصفية المنافذ حسب الموقع | Filter outlets by location | OK | | |
| storesDir.filter.buttonLabelCount | تصفية، {{count}} مطبّق | Filter, {{count}} applied | improve | تصفية، {{count}} مطبّقة | See filterChipCount. |
| storesDir.filter.title | تصفية المنافذ | Filter outlets | OK | | |
| storesDir.filter.governorate | المحافظة | Governorate | OK | | |
| storesDir.filter.allGovernorates | كل المحافظات | All governorates | OK | | |
| storesDir.filter.area | المنطقة | Area | OK | | |
| storesDir.filter.areaSearch | ابحث عن منطقة | Search areas | OK | | |
| storesDir.filter.areaNone | لا توجد مناطق تطابق بحثك. | No areas match your search. | OK | | |
| storesDir.filter.unverifiedNote | بعض أسماء المناطق ما زالت قيد المراجعة. | Some area names are still being checked. | improve | بعض أسماء المناطق لم تُراجع بعد، وقد تختلف عن المتداول. | Accurate and natural. Slight: "ما زالت قيد المراجعة" is fine; consider telling the user the consequence (spelling may differ). No fault on honesty. |
| storesDir.filter.appliedLabel | فلاتر الموقع المطبّقة | Applied location filters | OK | | |
| storesDir.filter.appliedOne/Two/Few/Many | same as shopFilter | same | OK / improve | | Same as shopFilter notes (Many form stiff; never render at 0). |
| storesDir.filter.remove | إزالة {{name}} | Remove {{name}} | OK | | |
| storesDir.filter.clearAll | مسح الكل | Clear all | OK | | |
| storesDir.filter.showOne | عرض منفذ واحد | Show 1 outlet | OK | | |
| storesDir.filter.showTwo | عرض منفذين | Show 2 outlets | OK | | Correct dual. |
| storesDir.filter.showFew | عرض {{n}} منافذ | Show {{n}} outlets | OK | | Correct for 3 to 10. |
| storesDir.filter.showMany | عرض {{n}} منفذًا | Show {{n}} outlets | OK | | Correct for 11+. |
| storesDir.filter.showNone | لا توجد منافذ مطابقة | No outlets match | OK | | |
| storesDir.filter.noMatchTitle | لا توجد منافذ في هذا الموقع | No outlets match this location | OK | | EN and AR differ slightly (AR says "in this location"); fine. |
| storesDir.filter.noMatchBody | جرّب منطقة أوسع أو امسح فلتر الموقع. | Try a wider area or clear the location filter. | OK | | |
| storesDir.filter.widen | التوسيع إلى {{name}} | Widen to {{name}} | improve | وسّع إلى {{name}} | Imperative to match the other buttons; EN is imperative. |
| storesDir.filter.regionValue | المنطقة: مصر | Region: Egypt | improve | الدولة: مصر | "المنطقة" in Egyptian context means "area/district" and clashes with storesDir.filter.area = "المنطقة". Use "الدولة" or "البلد". EN "Region" is also ambiguous next to "Area". |
| storesDir.filter.regionNote | {{product}} متاح حاليا في مصر فقط. الأسعار بالجنيه المصري. الدول الأخرى غير متاحة بعد. | {{product}} currently serves Egypt only. Prices are in EGP. Other countries are not available yet. | wrong (needs fix) | {{product}} متاح حاليًا في مصر فقط. الأسعار بالجنيه المصري. | (1) "حاليا" is missing the tanween (حاليًا), unlike the rest of the file. (2) "الدول الأخرى غير متاحة بعد" is a "coming soon" implication for countries; your own rule forbids that. Drop it, or "{{product}} متاح في مصر فقط." (3) "متاح" is about an app/service: "يخدم {{product}} مصر فقط" is closer to the English. (4) "{{product}}" is Latin text in an RTL sentence at the start: the helper must wrap it with bidi isolation (U+2068 ... U+2069), or the dot after it can jump. Legal sign-off required; also drop the "Draft" comment before launch. EN: drop "yet" for the same reason. |
| tabsBagCount | {{n}} منتجات | | wrong | fix with plural keys | Wrong for 1 ("1 منتجات") and 11+ ("11 منتجات"). |
| home.bagLabelCount | الحقيبة، {{count}} عناصر | | wrong | | Same: wrong at 1, 2, 11+. |
| cart.sellersCount / itemsCaption / orders.sellersCount | {{count}} بائعين / {{count}} قطع | | wrong | | Same agreement problem at 1, 2, 11+. |
| home.showStores | عرض {{count}} متجر | | improve | | Agreement at 3 to 10. |
| shopAll.filters / filtersCount | تصفية / تصفية · {{count}} | Filter | OK | | |
| shopAll.heroCampaign (home) | عروض حقيقية، موثّقة | | OK | | Honest wording; matches spec. |
| home.heroLive / bannerLive | مباشر الآن | | OK (verify) | | Only when truly live (server time), per honesty rules. |
| home.filteredTitle | وصل حديثًا، مصفّى | | improve | وصل حديثًا (بعد التصفية) | "مصفّى" reads like liquid filtering; unclear. |
| role.shopper.body | أزياء مخفّضة موثّقة من متاجر كثيرة في سلة واحدة. | | improve | أزياء بخصومات موثّقة من متاجر كثيرة في سلة واحدة. | "مخفّضة موثّقة" suggests prices are verified, not discounts. |
| discover.styleMeTitle / styleMeBody | نسّقلي إطلالتي / قولنا المناسبة ... | | improve | register | Egyptian colloquial here and MSA elsewhere ("discoverStyleMe": "نسّق لي إطلالة"). Pick one. |

## Terminology inconsistencies
1. Filter: "تصفية" (button, title, aria) vs "فلتر/فلاتر" (chips, quickFilters, appliedX, removeBudget) vs "عوامل التصفية" (storesDir.emptyBody, clearFilters). Recommend: "تصفية" for the action/button/sheet title, "فلتر/فلاتر" for individual items, drop "عوامل التصفية".
2. Bag: "السلة" (tab, cart, many strings) vs "الحقيبة" (home.bagLabel, product.addToBagLabel, "حقيبة التسوق" cart.heading). Pick one (the spec says Bag; either is fine, but not both).
3. "وصل حديثاً" vs "وصل حديثًا" (tanween placement), "عيّنة" vs "عينة", "حاليا" vs "حاليًا".
4. Register: Egyptian colloquial ("كيف تحب تتسوّق؟", "نسّقلي", "قولنا") mixed with MSA. Pick one rule per surface.
5. Region word: "المنطقة" used for both the country and the area filter.
6. Hard-coded numerals in copy ("٣٠", "٥٠٠", "٤٩٩٫٥٠") instead of helper.
7. "متجر/منفذ/متجر إلكتروني" are used for store, outlet and online store; keep the three clearly distinct.

## Counts
Reviewed table rows: about 95 keys (several rows group sibling keys).
OK: about 62. Improve: about 25. Wrong: 6 (regionNote, heroNearestBody, tabsBagCount, bagLabelCount, sellersCount/itemsCaption, plus cluster).

## Top issues
1. regionNote implies other countries are coming ("غير متاحة بعد") and breaks the no-"coming soon" rule; also "حاليا" typo and bidi isolation of {{product}}.
2. storesDir.heroNearestBody / modeInStoreSub / inStoreTitle advertise outlet visits while the app says outlet data does not exist: contradictory and potentially misleading.
3. Number agreement: fixed "{{n}} منتجات/عناصر/بائعين/متجر/قطعة" strings are wrong at 1, 2, 3 to 10 or 11+. Only applied*/show* have proper forms, using a custom 1/2/3-10/11+ rule (no zero form).
4. Filter and bag terminology inconsistencies (above).
5. "المنطقة: مصر" collides with the Area filter; use "الدولة: مصر".
6. Hard-coded Eastern digits in lowest30d and errorInvalid.
7. English: "View Stores" title case, "Lowest in 30 days" missing "price", "{{n}} filters applied" Few/Many identical (fine), "Visit us today" promotional.

## Blocks shipping
- storesDir.filter.regionNote (legal wording unreviewed, "not available yet" implication). Needs native-speaker and counsel approval.
- Outlet visit promotional copy (heroNearestBody and friends) must be hidden or reworded until real outlet data exists.
- Agreement-error plural strings (tabsBagCount, bagLabelCount) are low-risk legally but are visible defects on the bag; fix before release.
Everything else is polish.
