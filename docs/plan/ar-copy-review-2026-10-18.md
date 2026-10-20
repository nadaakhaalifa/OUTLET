# Arabic copy review, round of 2026-10-18

**This is an AI audit. A human native Arabic reviewer (ideally Egyptian) must sign off before launch.** Nothing here is a legal opinion; legal-sensitive items also need counsel (verify-register).

Source: `packages/i18n/src/ar.ts` / `en.ts` at read time (ar 3089 lines). Not edited.

## Coverage

Present and audited: `filterSheet`, `categoryWindow`, `checkoutSteps`, `checkoutGate`, `guestMerge`, `homeReason`, `forYou`, `inlineSearch`, `savedTab`, `roleChooser`, `chrome`, `legalCombined`, `storeName`.
NOT present at read time (being written): `quietSignIn`, `firstLaunch`, `guestMe`, `guestStates`, `guestSurfaces`. Top-level `entry` does not exist; only unrelated `entry:` leaf keys exist (stylist 1300, visual search 2482, price alert 2520), out of scope. Re-run this audit when the missing namespaces land.

## Global checks

- (f) Banned strings: `أوتلت`, `HAUL`, `Z-OUTLET` do not appear in `ar.ts`. The product name only arrives through `{{product}}`. PASS.
- (h) Untranslated (AR identical to EN): none found.
- (d) Digits: all in-scope strings use placeholders, except two hard-coded Eastern digits: `filterSheet.discountLowest` ("٣٠ يومًا") and `savedTab.coolOffHelper` ("٢٤ ساعة"). They ignore the app numeral setting. See R2.
- (c) Plurals: every counted key has one/two/few/many/other with correct forms (few 3-10 plural noun, many 11-99 accusative singular, other singular). Sound. Gaps: see R9 (zero, uncounted numbers).
- (i) Length ratio AR/EN > 1.6 (only 4 hit): `filterSheet.sectionBrand` (16 vs 5, a section heading, fine, but see R7), `checkoutGate.cancel` (18 vs 11, button), `forYou.popular` (18 vs 11, label), `roleChooser.sellEyebrow` (17 vs 10, eyebrow). All short in absolute terms; check on 320pt width only for the button.

## Ranked findings (by user impact)

### R1. Bag is called two things: "السلة" and "الحقيبة" (MUST CHANGE)
Tabs, `savedTab.addToBag` ("أضف إلى السلة"), `tabsBagCount` use **السلة**. `checkoutGate.reason/cancel` and every `guestMerge.*` use **الحقيبة**. A shopper reading "حقيبتك محفوظة" right after tapping "السلة" will think these are different things. Pick one. Recommend **السلة** (common in Egyptian apps). Rewrites:
- checkoutGate.reason: "أنشئ حسابك لإتمام طلبك. سلتك محفوظة."
- checkoutGate.cancel: "العودة إلى السلة"
- guestMerge.moving: "ننقل سلتك إلى حسابك"; failedTitle: "تعذّر نقل سلتك حتى الآن"; summaryTitle: "سلتك الآن في حسابك"; reviewBag: "راجع السلة"; bagLocalNote: "لا نحجز المنتجات لك قبل إتمام الطلب. سلتك محفوظة على هذا الهاتف فقط."; emptyLocal: "المنتجات التي تضيفها من أي متجر تظهر هنا. سلتك ومحفوظاتك على هذا الهاتف فقط."; capLines: "تتسع سلتك لـ {{max}} منتجًا كحد أقصى."
- Same word problem with units: guestMerge uses "قطعة/قطع/قطعك" while the rest of the app says "منتج". Use "منتج" throughout (failedBody: "منتجاتك ما زالت على هذا الهاتف…").

### R2. Hard-coded Eastern digits (MUST CHANGE)
- filterSheet.discountLowest: "أقل سعر خلال ٣٠ يومًا" -> "أقل سعر خلال {{days}} يومًا" (pass formatted number).
- savedTab.coolOffHelper: "المنتجات في قائمة الرغبات تنتظر ٢٤ ساعة…" -> "{{hours}} ساعة". Also the term issue in R6.

### R3. "رصيد المتجر" for store credit (MUST CHANGE, legal-adjacent)
`checkoutSteps.storeCredit`. Spec B2 / 15.2: the wallet is closed-loop HAUL credit usable across all stores, never "cash" or "money". "رصيد المتجر" reads as one merchant's balance and invites a wrong refund/cash expectation. Rewrite: "رصيد {{product}}" (wrap per R8) or "رصيد التسوق". Native reviewer to choose; avoid "نقود/فلوس".

### R4. Honesty and legal wording (MUST CHANGE / counsel)
- roleChooser.shopBody: "تُراجع الخصومات وفق سجل الأسعار الحقيقي" overpromises: it implies every discount is checked and that the history is "real". Spec 9: we show % off only with evidence, otherwise a plain price. Rewrite: "تصفّح متاجر كثيرة، املأ سلة واحدة وادفع مرة واحدة. لا نعرض نسبة خصم إلا عندما يدعمها سجل أسعار." (EN `shopBody` should be aligned too.)
- roleChooser.promise: "وخصومات نتحقق منها" acceptable; safer: "خصومات نعرضها فقط عند التحقق منها."
- storeName.verified "متجر موثّق": "موثّق" is also used for "الخصم الموثّق" (price). Two different verifications under one word. Store = identity/KYC; discount = price evidence. Rewrite store: "هوية المتجر موثّقة"; keep "خصم موثّق" for price. Counsel to confirm "verified store" does not imply a quality/authenticity guarantee (counterfeit joint-liability risk, B5).
- filterSheet.budgetNote: "ولا يُحفظ ولا يُشارك" is a privacy claim. Confirm against the implementation (spec 12: budget data never reaches sellers; `budget_insights` consent). If anything is stored on device, say "لا يُشارك مع المتاجر".
- checkoutSteps.saved: "وفّرت {{amount}} (موثّق)" fine only when the amount is verified-reference savings; hide the line otherwise (code, not copy).
- legalCombined.link "اقرأ الشروط وسياسة الخصوصية": fine as a link. It must not sit in a sentence implying consent by tapping; consent texts stay separate and un-pre-ticked (B1).
- inlineSearch.camera "البحث بالصورة": visual search is not composed in production (CLAUDE.md). Do not show unless the flag is on.

### R5. Awkward or machine-like Arabic (NEEDS REWRITE)
| Key | Current | Problem | Suggested |
|---|---|---|---|
| guestMerge.keptLarger | "…كان لديك {{local}} هنا و{{account}} في حسابك، فأصبح في حقيبتك {{qty}}." | no unit, "هنا" unclear, stiff | "{{title}}: احتفظنا بالكمية الأكبر. كان على هذا الهاتف {{local}} وفي حسابك {{account}}، وفي سلتك الآن {{qty}}." |
| guestMerge.clamped | "…أبقينا {{qty}}، وهو الحد الأقصى للقطعة الواحدة." | | "{{title}}: أبقينا {{qty}} فقط، وهو الحد الأقصى للمنتج الواحد." |
| guestMerge.continueWithout | "تابع إلى الدفع بدونها" | "it" vs plural ambiguity | "تابع إلى الدفع بدون هذه المنتجات" |
| guestMerge.capUnits | "يمكنك إضافة {{max}} قطع كحد أقصى من القطعة نفسها." | wrong grammar for many max values; no plural | "الحد الأقصى {{max}} من المنتج نفسه." |
| guestMerge.capLines | "تتسع حقيبتك لـ {{max}} قطعة…" | | "الحد الأقصى في السلة {{max}} منتجًا." |
| guestMerge.savedOverCapLine | "…لأن الحقيبة تتسع لـ {{max}} قطعة كحد أقصى" | | "نقلنا {{title}} إلى المحفوظات لأن السلة وصلت إلى حدها الأقصى ({{max}} منتجًا)." |
| guestMerge.unavailable | "تعذّرت إضافة {{title}}: لم يعد متاحًا." | gender of title unknown ("متاحًا") | "لم نتمكن من إضافة {{title}} لأنه غير متاح الآن." (see R10) |
| homeReason.storesNear | "…وفي مقدمتها الإطلاقات المباشرة" | calque of "live drops" | "متاجر قريبة من {{area}}، والعروض المباشرة أولًا" |
| homeReason.storesGeneric | "متاجر بإطلاقات مباشرة وعروض موثّقة" | same | "متاجر بعروض مباشرة وخصومات موثّقة" |
| filterSheet.subtreeDropped | "لا تشمل النتائج الأقسام الفرعية بسبب حد المرشّحات." | unclear cause | "وصلنا إلى حد الفلاتر، فلا تشمل النتائج الأقسام الفرعية." |
| filterSheet.priceNoHistogram | "أدخل نطاقًا أو اختر خيارًا سريعًا." | OK, but no context | "حدّد نطاق السعر بنفسك أو اختر أحد الخيارات السريعة." |
| filterSheet.openApplied | "التصفية، {{count}} مطبقة" | count not plural-aware | use appliedLabel* keys: "التصفية، مرشّح واحد مطبق" etc. |
| filterSheet.sortNote | "الترتيب يطبّق على…" | wrong voice | "يُطبَّق الترتيب على كل المنتجات المطابقة." |
| savedTab.budgetOverLine | "…تجاوز بمقدار {{over}}" | subject missing | "…تجاوزت الميزانية بمقدار {{over}}" |
| forYou.offlineBanner | "نعرض ما تم حفظه" | "تم" passive calque | "أنت غير متصل. نعرض ما حُفظ على هذا الجهاز." |
| checkoutSteps.codNeedsPin | "…وعلامة مميزة. أضفهما للمتابعة." | "علامة مميزة" = distinctive mark, not landmark | "الدفع عند الاستلام يتطلب تحديد الموقع على الخريطة وأقرب معلم. أضفهما للمتابعة." |
| checkoutSteps.quoteFailed | "تعذّر تحديث الأسعار. اختياراتك محفوظة." | fine | ready |

### R6. Terminology drift with the spec (NEEDS NATIVE REVIEW)
- savedTab.coolOffHelper: EN says "Want list"; AR says "قائمة الرغبات" (generic wishlist), which loses the Want/Need/Treat intent. Rewrite: "المنتجات في قائمة «أرغب» تنتظر {{hours}} ساعة قبل الشراء. يمكنك تغيير ذلك في أي وقت." Use whatever AR label the intent picker already uses.
- Brand vs store: filterSheet.sectionBrand "العلامة التجارية", chipStore "العلامة: {{name}}", brandUnavailable "متجر لم يعد متاحًا". brandNote says brands are stores. Pick one noun in UI: "المتجر" (matches storeName and the rest of the app). sectionBrand -> "المتجر" also fixes the 3.2x length ratio. chipStore -> "المتجر: {{name}}"; brandSearch -> "ابحث عن متجر"; brandNone -> "لا توجد متاجر مطابقة."; brandLimit -> "يمكنك اختيار حتى {{max}} متاجر." (note: `max` plural is not handled, see R9). Note `sectionWorld` is already "المتاجر".
- المرشّحات vs الفلاتر: "المرشّحات" is correct MSA but sounds technical. Egyptian-friendly: "الفلاتر" (very common in apps). Keep "التصفية" for the title. Native reviewer decides; apply consistently.

### R7. Tone: MSA vs Egyptian-friendly (NEEDS NATIVE REVIEW, low-medium)
Overall register is clear MSA, short, not stiff. Items slightly formal or stiff:
- "أزل واحدًا لإضافة آخر" (facetLimit) -> "احذف فلترًا لتضيف غيره."
- "إنشاء رابط جديد" fine. "يتطلب" -> "يحتاج" (codNeedsPin) friendlier.
- "تعذّر ..." is used for all errors; fine and consistent. Do not switch to dialect ("جرّب تاني"); too colloquial for money/returns copy.
- forYou.title "لك" is short but ambiguous as a tab/section title; consider "مختارات لك".

### R8. Mixed Latin/Arabic and bidi (NEEDS ENGINEERING + REVIEW)
- Strings with `{{product}}` (roleChooser.heading, sellTitle, app.name usage): the Latin name inside an RTL sentence can reorder punctuation: "كيف تريد استخدام Z-OUTLET؟" may show "؟" on the wrong side. Wrap interpolation in `<bdi>` (or U+2068/U+2069 isolates) in the Text component, not in the catalog.
- chipDiscount "خصم {{pct}} أو أكثر (موثّق)": the pct token ("30%") must be formatted via Intl with the AR locale so "%" sits correctly; test the parenthesis after a number+percent (known flip).
- Prices ({{amount}}) in checkoutSteps.saved/methodFee/payable, savedTab.budgetLine, wasNow: use a currency formatter that outputs "ج.م" in AR; wrap amount in an isolate so "ج.م" does not jump across the colon/period.
- savedTab.wasNow "كان {{was}} عند الحفظ، والآن {{now}}": two amounts in one RTL sentence; isolate each.
- Brand and store names inside removeItem/addToBagName/guestMerge lines ({{title}}, {{list}}, {{store}}) are often Latin: isolate with `<bdi>`.
- Plus/other Latin terms: none in the audited namespaces.

### R9. Plural edge cases (NEEDS ENGINEERING)
- Counted keys have all six forms (zero falls to "other": "0 منتج"). For 0, prefer a dedicated empty state; acceptable otherwise.
- Numbers inside prose without plural keys: facetLimit "{{max}}", brandLimit "حتى {{max}} علامة", guestMerge.capLines/capUnits/savedOverCap(Line) "{{max}}", inlineSearch.queryTooLong "{{max}} حرفًا". These work only if `max` is >= 11 ("حرفًا", "منتجًا"). If max is 3-10 they must be plural ("حروف"/"متاجر"). Fix by phrasing with a colon ("الحد الأقصى: {{max}}") or adding plural keys. Pass numbers through the numeral setting.
- selectedFew "{{n}} محددة": fine for inanimate items.

### R10. Gender and imperatives (NEEDS NATIVE REVIEW)
- Buttons use the masculine imperative (حاول، تابع، راجع، اختر، أضف، ابدأ، قدّم). It is the standard generic form. Decide house style (masculine default vs neutral nouns like "متابعة", "إعادة المحاولة"). Checkout already uses nouns ("متابعة", "رجوع", "تعديل"), so "تابع إلى الدفع" and "حاول مرة أخرى" are mixed with nouns. Recommended rule: primary buttons use nouns/verbal nouns, instructions use masculine imperative. Example: retry -> "إعادة المحاولة"; guestMerge.continue -> "المتابعة إلى الدفع".
- forYou.becauseSaved "لأنك حفظت {{title}}": addresses user in masculine/neutral past; fine (ك + ت). "ت" ends ambiguous in writing, so OK.
- Sentences with unknown-gender `{{title}}` and predicate adjectives ("متاحًا", "موقوف") disagree for feminine products (e.g. a dress). Avoid predicates on `{{title}}`: use the "لأنه/لأنها" workaround with a noun clause: "{{title}}: غير متاح الآن" (invariable) or "المنتج لم يعد متاحًا". Affects guestMerge.unavailable/savedUnavailableLine/storeSuspended and savedTab.removeItem/removed. Safest: "{{title}} — غير متاح".
- savedTab.hidePrices, listSettings: fine.

### R11. Short keys: ready, with remarks
- categoryWindow.seeAll "عرض كل {{name}}" -> "عرض كل ما في {{name}}" or "عرض الكل في {{name}}" ({{name}} is a definite phrase; "كل" + definite name reads off).
- inlineSearch.clearRecents "مسح" -> "مسح الكل" (clarity).
- savedTab.filterShow "عرض" is vague out of context; add visible label "عرض:".
- chrome.theme fine; chrome.languageA11y fine.

## Key table (all audited keys)

Status legend: READY / NEEDS NATIVE REVIEW (NR) / MUST CHANGE (MC). Listed individually where not READY; unlisted keys in a group are READY.

| Namespace | MC | NR | READY (rest) |
|---|---|---|---|
| filterSheet | discountLowest (R2) | sectionBrand, chipStore, brandSearch, brandNone, brandLimit, brandNote, brandUnavailable (R6); openApplied, sortNote, subtreeDropped, facetLimit, priceNoHistogram (R5/R7); budgetNote, chipDiscount, sectionDiscount (R4/R8); المرشّحات wording (R6) | title, open, close, sectionSort/Price/Budget/Categories/More/World, selected*, budgetSwitch, budgetSetup, moreCondition/Department/Delivery, reset, showItems, showCount*, countUnavailable, chipsRegion, appliedLabel*, removeChip, chipFitsBudget, chipSort, saved* |
| categoryWindow | none | seeAll (R11) | loading, failed, retry, empty, close, countLabel* |
| checkoutSteps | storeCredit (R3); codNeedsPin (R5) | saved (R4); methodFee/payable (R8); continue/back nouns vs imperative (R10) | delivery, payment, review, stepsLabel, details, hideDetails, total, merchandise, deliveryFrom, backBlocked, viewOrders, placeOffline, quoteFailed, methodDropped, emptyBag, methodUnavailable, edit, voucher |
| checkoutGate | reason, cancel (R1) | none | none |
| guestMerge | all bag/قطعة strings (R1), keptLarger, clamped, capUnits, capLines, savedOverCap* (R5) | continueWithout, retry (R10), unavailable/storeSuspended (R10) | savedUnavailable, failedTitle (after R1 wording) |
| homeReason | storesNear, storesGeneric (R5) | allPiecesNewest, seeAllName | allPiecesGeneric, seeAll |
| forYou | none | title (R7), offlineBanner (R5) | searchPlaceholder, personalizationOff, openSettings, becauseSaved, goesWithBag, priceDropped, picked, popular, recentlyViewed, exploreCategories, stores, moduleFailed, retry |
| inlineSearch | camera (show only if visual search enabled, R4) | clearRecents (R11), queryTooLong (R9) | placeholder, cancel, recent, removeRecent, suggestions, kind*, offline, noResults |
| savedTab | coolOffHelper (R2, R6) | budgetOverLine, removed, removeItem, unavailable (R10), filterShow, wasNow (R8) | title, items*/lists* Count, subtitle, filter, share, addList, budgetLine, budgetCaption, undo, removeFailed, addToBag*, addedToBag, chooseSize, availableIn*, noLongerAvailable, inBag, viewBag, listSettings, coolOffTitle, shared, createLink, stopSharing, hidePrices, offlineReadOnly, empty*, discover, sort*/filter* |
| roleChooser | shopBody (R4) | promise (R4), heading (R8), sellBody, sellCta, sellEyebrow | shopTitle, shopCta, sellTitle, signInPrompt, signIn |
| chrome | none | none | all |
| legalCombined | none | link (R4 context) | link |
| storeName | verified (R4) | none | none |
| quietSignIn, firstLaunch, guestMe, guestStates, guestSurfaces, entry | not present | | re-audit |

## Suggested order of work

1. R1 (السلة unification), R2 (digits), R3 (store credit), R4 (honesty) are the must-changes; the English side needs matching edits for R4 and R3.
2. R5 rewrites and R6 terminology decision (brand vs store, Want-list name).
3. R8/R9 are engineering tasks (isolates, numeral-aware numbers, plural keys for `max`); add an i18n test that forbids Eastern digits inside catalog strings.
4. Native reviewer sign-off on R7/R10 style rules, then re-run this audit on the five missing namespaces.

AI audit only; human native Arabic review and counsel review of R4 are required before release.
