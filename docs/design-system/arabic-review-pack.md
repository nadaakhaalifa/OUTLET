# Arabic review pack for the native Egyptian-Arabic reviewer

Status: DRAFT for review. No string in this pack is approved. Nothing here has been reviewed by a native Egyptian-Arabic speaker or by counsel.

Source of truth: `packages/i18n/src/en.ts` and `ar.ts` (119 keys, EN/AR key parity verified). Spec: `docs/haul-master-prompt-v3.md` (A2.15 Arabic-first, B5 Arabic mandatory, B1 consent, B6 age, 18/21, section 18 ethical copy, section 25 localisation). Product name placeholder: `{{product}}`.

## 1. How to use this pack
1. Read section 2 (flag legend) and section 3 (cross-cutting findings) first.
2. Work through section 5 screen by screen. Flags are the author's hypotheses, not verdicts; the reviewer overrides any of them.
3. Record decisions in the glossary (section 4), then the "Reviewer proposal" column is yours to fill in the tables if you rewrite a string.
4. Strings flagged **E** also need legal sign-off (section 7), separate from linguistic review.

## 2. Flag legend
| Code | Meaning |
|---|---|
| A | MSA (formal) where Egyptian-friendly copy is expected |
| B | Literal translation / unnatural phrasing |
| C | Term inconsistent across screens, or conflicts with the spec glossary |
| D | Number, plural, gender or bidi/digit handling risk |
| E | Legally sensitive (consent, age, returns, price claims, retention, forfeiture): needs legal-grade review |

## 3. Cross-cutting findings
1. **Store credit wording (C/E).** The spec (B2, 15.2) requires "HAUL credit" style (here: رصيد Z-OUTLET) and never "cash" or "money". Current AR uses "رصيد متجر"/"رصيد المتجر", which can be read as a single seller's store balance, and "رصيد" alone also means phone airtime in Egyptian speech. EN says "store credit" instead of "Z-OUTLET credit". Both languages need a decision.
2. **Plurals are not handled (D).** `{{count}}`, `{{days}}`, `{{seconds}}` are interpolated into fixed noun forms. Arabic needs one/two/few/many/other forms (e.g. ثانية / ثانيتان / ثوانٍ / ثانية). EN uses "order(s)". The i18n layer needs plural keys before AR can be correct. Affected: onboarding.otp.resendIn, privacy.deleteCooling, privacy.deleteBlocked*.
3. **Gender (D).** All imperatives and address forms are masculine (حاول، أدخل، اطلب، أنت جاهز، بك). Needs a policy: masculine default, gender-neutral rewrites, or a user gender setting. "أنت جاهز" is the most visible case.
4. **Register (A).** "يُرجى" appears many times and the copy is predominantly MSA. The spec expects Egyptian-friendly copy. The reviewer must set the register (full Egyptian vs light-MSA) once, so all strings are consistent. "الموبايل" is already colloquial but sits next to "الهاتف".
5. **Digits and bidi (D).** Interpolated numbers, phone numbers, dates and amounts use Western digits. Spec 25 asks for a numeral preference and EGP formatting (١٬٢٠٠ ج.م). Confirm digit policy, date format (Gregorian/Hijri) and bidi isolation of {{phone}}, {{amount}} {{currency}}, {{date}}.
6. **Privacy terminology (E).** "مجهّلة الهوية" (anonymised) vs the spec's pseudonymised retention; "موافقاتك"; "المعالجة خارج مصر". Counsel should fix the legal term, then linguistics follows.
7. **Dev-only strings.** home.devFixtureNotice and common.devFixtureBackend are for development builds only and must not ship; do not spend review time polishing them.
8. **Missing copy.** This pack covers only existing keys. Returns, price badges ("Verified discount", "Lowest price in 30 days", "Launch price"), Plus auto-renew disclosures, COD and invoices have no keys yet and will need their own pass; those are all E-class.

## 4. Proposed glossary (for reviewer decision, none approved)
| Concept | EN (current/spec) | Current AR | Proposed AR options | Notes |
|---|---|---|---|---|
| Cart | Cart | السلة | decided by owner: "السلة" (not الحقيبة, which reads as a handbag) | Decided |
| Z-OUTLET credit | Store credit (spec: HAUL credit) | رصيد متجر | رصيد Z-OUTLET | Never نقدي/فلوس; clarify not airtime |
| Wallet | Wallet | (not present) | المحفظة | Closed-loop; must not imply cash |
| Mobile number | Mobile number | رقم الموبايل / رقم هاتفك | رقم الموبايل | Use consistently |
| One-time code | One-time code | رمز | كود / رمز | Decide with OTP wording |
| Plus | HAUL Plus | بلس | Z-OUTLET Plus (بلس) | Brand naming |
| Stylist | Stylist | المنسّق | مستشار الأزياء / ستايليست | AI disclosure per spec LLM09 |
| Order | Order | طلب | طلب / أوردر | |
| Return | Return | إرجاع | استرجاع | Match consumer-law wording |
| Exchange | Exchange | (not present) | استبدال | |
| Dispute | Dispute | نزاع | شكوى / اعتراض | Legal meaning to confirm |
| Verified discount | Verified discount | (not present) | خصم موثّق / تم التحقق منه | Price-claim term, legal |
| Installments | Instalment payments | الدفع بالتقسيط | التقسيط | Fine |
| Consent | Consent | موافقة | موافقة | Legal |
| Privacy Center | Privacy Center | مركز الخصوصية | مركز الخصوصية | |
| Personal data | Personal data | البيانات الشخصية | البيانات الشخصية | PDPL term |
| Budget | Budget | ميزانية | ميزانية | |
| Size / measurements | Size / Measurements | مقاس / قياسات | مقاس / قياسات | Keep distinct |
| Notification | Notification | إشعار | إشعار | |
| Account | Account | حساب | حساب | |

## 5. Strings by screen
Columns: Key, EN, AR, Flags and reasons, Reviewer proposal (blank), Status (blank).

### Tabs and home

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `tabs.home` | Home | الرئيسية | none raised | | Not reviewed |
| `tabs.explore` | Explore | استكشف | none raised | | Not reviewed |
| `tabs.stylist` | Stylist | المنسّق | B: 'المنسّق' is a coined literal of 'Stylist'; a native reviewer should pick the term (e.g. مستشار الأزياء / ستايليست) and keep it identical on every surface that names the AI stylist. | | Not reviewed |
| `tabs.bag` | Cart | السلة | Owner decision: user-facing term is Cart (key stays `tabs.bag`). | | Decided |
| `tabs.me` | Me | حسابي | A/B: 'حسابي' means 'my account', not 'Me'. Acceptable, but confirm it matches the Orders/Wallet/Budget hub scope. | | Not reviewed |
| `home.title` | Real deals, verified | عروض حقيقية، موثّقة | E: price-claim wording (CPL 181/2018, spec §9). 'عروض حقيقية، موثّقة' asserts verified offers. Legal-grade review: 'عروض' vs 'خصومات', and 'موثّقة' vs 'تم التحقق منها' must match the Price Integrity badge terms. | | Not reviewed |
| `home.devFixtureNotice` | Development build: placeholder content, not real products or prices. | نسخة تطوير: محتوى تجريبي وليس منتجات أو أسعارًا حقيقية. | A/C: dev-only text. Mixes 'تجريبي' and 'تطوير'. Must never ship to production. | | Not reviewed |

### Common and errors

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `common.languageToggle` | العربية | English | none raised | | Not reviewed |
| `common.continue` | Continue | متابعة | none raised | | Not reviewed |
| `common.back` | Back | رجوع | none raised | | Not reviewed |
| `common.skip` | Skip for now | تخطّي الآن | B: 'تخطّي الآن' drops the 'for now' nuance; confirm wording. | | Not reviewed |
| `common.cancel` | Cancel | إلغاء | none raised | | Not reviewed |
| `common.save` | Save | حفظ | none raised | | Not reviewed |
| `common.retry` | Try again | حاول مرة أخرى | D: masculine imperative 'حاول'. Gender policy needed (see D1). | | Not reviewed |
| `common.loading` | Loading | جارٍ التحميل | A: 'جارٍ التحميل' is MSA; acceptable for UI but confirm tone. | | Not reviewed |
| `common.on` | On | مفعّل | B: 'مفعّل/غير مفعّل' fits a toggle but 'غير مفعّل' is stiff; confirm. | | Not reviewed |
| `common.off` | Off | غير مفعّل | none raised | | Not reviewed |
| `common.currency` | EGP | ج.م | C: 'ج.م' short form. Confirm 'جنيه' vs 'ج.م' policy and numeral style with amounts (spec §25: ١٬٢٠٠ ج.م). | | Not reviewed |
| `common.devFixtureBackend` | Development build: no real backend is connected. Nothing here is real data. | نسخة تطوير: لا يوجد خادم حقيقي متصل. لا شيء هنا بيانات حقيقية. | A/B: 'خادم' is MSA/literal; dev-only text, must never ship. Egyptian tech speech usually says 'سيرفر'. | | Not reviewed |
| `errors.generic` | Something went wrong. Please try again. | حدث خطأ ما. يُرجى المحاولة مرة أخرى. | A: 'يُرجى' and 'حدث خطأ ما' are MSA/formal; Egyptian-friendly alternative expected (e.g. حصلت مشكلة، حاول تاني). Reviewer to choose register. | | Not reviewed |
| `errors.offline` | You appear to be offline. Check your connection and try again. | يبدو أنك غير متصل بالإنترنت. تحقق من الاتصال وحاول مرة أخرى. | A/D: MSA 'يبدو أنك غير متصل' ; masculine address. | | Not reviewed |
| `errors.rateLimited` | Too many attempts. Please wait a moment and try again. | محاولات كثيرة. يُرجى الانتظار قليلًا ثم المحاولة مرة أخرى. | A/B: 'محاولات كثيرة' is terse/literal; 'يُرجى' MSA. | | Not reviewed |

### Onboarding: phone

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `onboarding.phone.title` | Your phone number | رقم هاتفك | C: 'رقم هاتفك' here but 'رقم الموبايل' on the label and 'هذا الهاتف' elsewhere. Pick one: موبايل (Egyptian) vs هاتف (MSA). | | Not reviewed |
| `onboarding.phone.body` | We will send you a one-time code to sign in or create your account. | سنرسل لك رمزًا لمرة واحدة لتسجيل الدخول أو إنشاء حسابك. | A: 'رمزًا لمرة واحدة' is a literal of 'one-time code'; Egyptian users say 'كود'. Confirm رمز vs كود across OTP screens. | | Not reviewed |
| `onboarding.phone.label` | Mobile number | رقم الموبايل | none raised | | Not reviewed |
| `onboarding.phone.placeholder` | 01X XXXX XXXX | 01X XXXX XXXX | D: LTR digit pattern inside RTL field; verify rendering and that Eastern-Arabic digit input is normalised. | | Not reviewed |
| `onboarding.phone.helper` | Egyptian mobile numbers only for now. | أرقام الموبايل المصرية فقط في الوقت الحالي. | A: 'في الوقت الحالي' MSA-formal. | | Not reviewed |
| `onboarding.phone.errorEmpty` | Enter your mobile number. | أدخل رقم الموبايل. | none raised | | Not reviewed |
| `onboarding.phone.errorInvalid` | That number does not look right. Check it and try again. | الرقم غير صحيح. راجعه وحاول مرة أخرى. | D: masculine imperative 'راجعه'. | | Not reviewed |
| `onboarding.phone.errorCountry` | We only support Egyptian numbers for now. | ندعم الأرقام المصرية فقط في الوقت الحالي. | none raised | | Not reviewed |
| `onboarding.phone.send` | Send code | إرسال الرمز | none raised | | Not reviewed |

### Onboarding: OTP

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `onboarding.otp.title` | Enter the code | أدخل الرمز | none raised | | Not reviewed |
| `onboarding.otp.body` | We sent a 6-digit code to {{phone}}. | أرسلنا رمزًا من 6 أرقام إلى {{phone}}. | D: '6 أرقام' digit numeral and number-noun agreement (6 + plural). {{phone}} is LTR inside RTL; bidi isolation needed. | | Not reviewed |
| `onboarding.otp.label` | 6-digit code | الرمز المكوّن من 6 أرقام | B: 'الرمز المكوّن من 6 أرقام' is long and literal. | | Not reviewed |
| `onboarding.otp.errorIncomplete` | Enter all 6 digits. | أدخل الأرقام الستة كاملة. | D: 'الأرقام الستة' spells the number while the sibling strings use digits; inconsistent. Confirm. | | Not reviewed |
| `onboarding.otp.errorInvalid` | That code is not right. Check it and try again. | الرمز غير صحيح. راجعه وحاول مرة أخرى. | none raised | | Not reviewed |
| `onboarding.otp.errorExpired` | That code has expired. Request a new one. | انتهت صلاحية الرمز. اطلب رمزًا جديدًا. | D: masculine imperative. | | Not reviewed |
| `onboarding.otp.verify` | Verify | تأكيد | none raised | | Not reviewed |
| `onboarding.otp.resend` | Send a new code | إرسال رمز جديد | none raised | | Not reviewed |
| `onboarding.otp.resendIn` | You can ask for a new code in {{seconds}} s | يمكنك طلب رمز جديد بعد {{seconds}} ثانية | D: plural: 'ثانية' is correct only for 1 and 11+; 3-10 need 'ثوانٍ', 2 needs 'ثانيتين'. Needs a plural-aware key. | | Not reviewed |
| `onboarding.otp.resendExhausted` | You have reached the limit for new codes. Please try again later. | وصلت إلى الحد الأقصى لطلبات الرمز. يُرجى المحاولة لاحقًا. | A: 'الحد الأقصى' / 'يُرجى' MSA. | | Not reviewed |
| `onboarding.otp.changeNumber` | Use a different number | استخدام رقم آخر | none raised | | Not reviewed |

### Onboarding: date of birth

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `onboarding.dob.checking` | Checking your age | جارٍ التحقق من عمرك | D: gender-neutral; A: MSA 'جارٍ التحقق'. | | Not reviewed |
| `onboarding.dob.title` | Your date of birth | تاريخ ميلادك | none raised | | Not reviewed |
| `onboarding.dob.body` | {{product}} is for people aged 18 and over. We use your date of birth only to check your age. | {{product}} مخصّص لمن بلغ 18 عامًا فأكثر. نستخدم تاريخ ميلادك للتحقق من العمر فقط. | E: age gate. 'مخصّص لمن بلغ 18 عامًا فأكثر' and the PDPL purpose statement need legal-grade review. D: '18 عامًا' accusative tamyiz is correct, check for 3-10 forms elsewhere. | | Not reviewed |
| `onboarding.dob.day` | Day | اليوم | none raised | | Not reviewed |
| `onboarding.dob.month` | Month | الشهر | none raised | | Not reviewed |
| `onboarding.dob.year` | Year | السنة | none raised | | Not reviewed |
| `onboarding.dob.errorIncomplete` | Enter day, month and year. | أدخل اليوم والشهر والسنة. | none raised | | Not reviewed |
| `onboarding.dob.errorInvalid` | That date is not valid. | هذا التاريخ غير صالح. | none raised | | Not reviewed |
| `onboarding.dob.attest` | I confirm that I am 18 years old or older. | أؤكد أن عمري 18 عامًا أو أكثر. | E: age attestation text, legally binding (B6). Legal-grade review. D: 'أؤكد' is gender-neutral, good. | | Not reviewed |
| `onboarding.dob.errorAttest` | Please confirm that you are 18 or older to continue. | يُرجى تأكيد أن عمرك 18 عامًا أو أكثر للمتابعة. | E: age gate wording; D: masculine address. | | Not reviewed |
| `onboarding.dob.limitedCapacity` | Some features, such as Plus and instalment payments, need you to be 21 or older. | بعض المزايا، مثل اشتراك بلس والدفع بالتقسيط، تتطلب أن يكون عمرك 21 عامًا أو أكثر. | E: states the 21+ rule for Plus/instalments (B6, VERIFY register row 8). C: spec calls the product 'HAUL Plus' (Z-OUTLET Plus); 'اشتراك بلس' must match brand naming. D: 'عمرك 21 عامًا' fine. | | Not reviewed |
| `onboarding.dob.privacyNote` | If you are under 18 we do not keep your date of birth. | إذا كان عمرك أقل من 18 عامًا فلن نحتفظ بتاريخ ميلادك. | E: statement about not keeping DOB for under-18 is a PDPL commitment; must match actual behaviour and be legally reviewed. | | Not reviewed |
| `onboarding.dob.submit` | Continue | متابعة | none raised | | Not reviewed |

### Onboarding: language, consents, welcome

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `onboarding.progress` | Step {{current}} of {{total}} | الخطوة {{current}} من {{total}} | D: Western digits in {{current}}/{{total}}; confirm numeral preference (Eastern vs Western) and RTL ordering of 'الخطوة 2 من 5'. | | Not reviewed |
| `onboarding.language.title` | Choose your language | اختر لغتك | none raised | | Not reviewed |
| `onboarding.language.body` | You can change this later in your account. | يمكنك تغيير ذلك لاحقًا من حسابك. | none raised | | Not reviewed |
| `onboarding.language.note` | The app may restart to switch the reading direction. | قد يُعاد تشغيل التطبيق لتبديل اتجاه القراءة. | B: 'اتجاه القراءة' literal for 'reading direction'. | | Not reviewed |
| `onboarding.consents.title` | Your privacy choices | خياراتك للخصوصية | E: consent heading (PDPL). Legal-grade review. | | Not reviewed |
| `onboarding.consents.body` | Nothing below is switched on unless you switch it on. You can change any choice at any time in Privacy Center. | لن يتم تفعيل أي خيار أدناه ما لم تفعّله بنفسك. يمكنك تغيير أي اختيار في أي وقت من مركز الخصوصية. | E: consent framing 'لن يتم تفعيل أي خيار...' passive MSA; legal review. A: 'لن يتم' is a calque; Egyptian-friendly alternative. | | Not reviewed |
| `onboarding.consents.save` | Save my choices | حفظ اختياراتي | E: consent action label. | | Not reviewed |
| `onboarding.consents.skipNote` | If you skip, all of these stay off. | إذا تخطّيت هذه الخطوة تبقى كل هذه الخيارات غير مفعّلة. | E: consequence of skipping; must be accurate. | | Not reviewed |
| `onboarding.welcome.title` | You are all set | أنت جاهز | D: 'أنت جاهز' masculine only; needs a neutral phrasing (e.g. كل شيء جاهز). | | Not reviewed |
| `onboarding.welcome.body` | Welcome to {{product}}. | أهلًا بك في {{product}}. | D: 'أهلًا بك' masculine-form address. | | Not reviewed |
| `onboarding.welcome.start` | Start browsing | ابدأ التصفّح | none raised | | Not reviewed |

### Age block

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `age.blocked.until` | You can try again after {{date}}. | يمكنك المحاولة مرة أخرى بعد {{date}}. | D: {{date}} format (Gregorian vs Hijri, Eastern digits) undecided. | | Not reviewed |
| `age.blocked.title` | We cannot create an account right now | لا يمكننا إنشاء حساب الآن | E: age-block copy; legal review. D: 'لك' fine. | | Not reviewed |
| `age.blocked.body` | {{product}} is only for people aged 18 and over, so we cannot set up an account for you. We have not kept the date of birth you entered. | {{product}} مخصّص لمن بلغ 18 عامًا فأكثر، لذلك لا يمكننا إنشاء حساب لك. لم نحتفظ بتاريخ الميلاد الذي أدخلته. | E: states non-retention of DOB; 18+ rule; legal-grade review. | | Not reviewed |
| `age.blocked.later` | Thank you for understanding. You are welcome to come back once you are 18. | شكرًا لتفهّمك. يسعدنا أن تعود إلينا عندما تبلغ 18 عامًا. | E: tone toward minors; D: 'تبلغ' masculine/feminine-neutral? 'عندما تبلغ' masculine form. | | Not reviewed |
| `age.blocked.deviceBlockedBody` | We cannot continue on this device at the moment. Please try again later. | لا يمكننا المتابعة على هذا الجهاز في الوقت الحالي. يُرجى المحاولة لاحقًا. | E: reveals device-level block; legal/privacy review of disclosure level. | | Not reviewed |
| `age.blocked.close` | Back to the start | العودة إلى البداية | none raised | | Not reviewed |

### Consent purposes

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `consent.purposes.marketing_push.title` | Offers by notification | العروض عبر الإشعارات | E: consent purpose; C: 'الإشعارات' vs 'التنبيهات' terminology. | | Not reviewed |
| `consent.purposes.marketing_push.description` | Send you offers and reminders as push notifications on this phone. | إرسال العروض والتذكيرات إليك كإشعارات على هذا الهاتف. | E: consent text. B: 'إرسال ... إليك' omits subject (we); fine in list but confirm. | | Not reviewed |
| `consent.purposes.marketing_whatsapp.title` | Offers on WhatsApp | العروض عبر واتساب | E: consent purpose. | | Not reviewed |
| `consent.purposes.marketing_whatsapp.description` | Send you offers and updates about things you may like on WhatsApp. | إرسال العروض والتحديثات عن أشياء قد تعجبك عبر واتساب. | E: consent text; A: 'قد تعجبك' fine. | | Not reviewed |
| `consent.purposes.marketing_email.title` | Offers by email | العروض عبر البريد الإلكتروني | E: consent purpose. | | Not reviewed |
| `consent.purposes.marketing_email.description` | Send you offers and news by email. | إرسال العروض والأخبار إليك عبر البريد الإلكتروني. | E: consent text. | | Not reviewed |
| `consent.purposes.analytics.title` | Usage analytics | تحليلات الاستخدام | E: consent purpose; B: 'تحليلات' literal. | | Not reviewed |
| `consent.purposes.analytics.description` | Help us understand how the app is used so we can fix problems and improve it. Switched off, we collect none of it. | تساعدنا على فهم كيفية استخدام التطبيق لإصلاح المشكلات وتحسينه. عند إيقافها لا نجمع أيًّا من ذلك. | E: consent text; B: 'عند إيقافها لا نجمع أيًّا من ذلك' must be factually true; D: 'تساعدنا' subject agreement with 'تحليلات' (feminine plural-as-singular ok) to confirm. | | Not reviewed |
| `consent.purposes.personalization.title` | Personal recommendations | توصيات شخصية | E: consent purpose; B: 'توصيات شخصية' vs 'مخصّصة لك'. | | Not reviewed |
| `consent.purposes.personalization.description` | Use what you view and save to show things that suit you. | استخدام ما تشاهده وتحفظه لعرض ما يناسبك. | E: consent text. | | Not reviewed |
| `consent.purposes.budget_insights.title` | Spending insights | ملخصات الإنفاق | E: financial-behaviour data (P3); consent purpose. | | Not reviewed |
| `consent.purposes.budget_insights.description` | Show you summaries of your spending and help you stay within a budget you set. | عرض ملخصات لإنفاقك ومساعدتك على الالتزام بميزانية تحددها. | E: consent text; C: 'ميزانية' term; must say not shared with sellers if legal requires. | | Not reviewed |
| `consent.purposes.measurements.title` | Size and body measurements | المقاسات وقياسات الجسم | C: 'المقاسات' (sizes) vs 'قياسات' (measurements) both used; spec distinguishes size vs measurement. E: consent purpose. | | Not reviewed |
| `consent.purposes.measurements.description` | Store the measurements you enter so we can suggest a better fit. | حفظ القياسات التي تدخلها لنقترح عليك مقاسًا أنسب. | E: consent text; C: 'مقاسًا' (size) vs 'القياسات'. | | Not reviewed |
| `consent.purposes.location_precise.title` | Precise location | الموقع الدقيق | E: consent purpose. | | Not reviewed |
| `consent.purposes.location_precise.description` | Use your exact location for things like nearby pickup points. | استخدام موقعك الدقيق لأشياء مثل نقاط الاستلام القريبة. | E: consent text; B: 'لأشياء مثل' vague literal. | | Not reviewed |
| `consent.purposes.cross_border_ml.title` | Processing outside Egypt | المعالجة خارج مصر | E: cross-border transfer consent (B1, VERIFY row 2). Legal-grade review. | | Not reviewed |
| `consent.purposes.cross_border_ml.description` | Allow your data to be processed by recommendation services located outside Egypt. | السماح بمعالجة بياناتك عبر خدمات توصية موجودة خارج مصر. | E: cross-border processing disclosure; must name recipient/country when known. B: 'خدمات توصية' literal. | | Not reviewed |

### Privacy Center

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `privacy.title` | Privacy Center | مركز الخصوصية | C: 'مركز الخصوصية' term; keep consistent. | | Not reviewed |
| `privacy.intro` | See and change what we may do with your data. Every switch is off until you turn it on. | اطّلع على ما يمكننا فعله ببياناتك وغيّره. كل مفتاح غير مفعّل حتى تفعّله أنت. | E: PDPL transparency; B: 'مفتاح' for switch is a literal; Egyptian UI typically 'الخيار' or 'زر التبديل'. | | Not reviewed |
| `privacy.consentsHeading` | Your consents | موافقاتك | E: 'موافقاتك' term for consents; legal review. | | Not reviewed |
| `privacy.consentsHint` | Turning a switch off takes effect immediately. | إيقاف أي مفتاح يسري فورًا. | E: withdrawal effect; B: 'مفتاح' literal. | | Not reviewed |
| `privacy.syncPending` | Some changes have not reached our servers yet. We will keep retrying. | بعض التغييرات لم تصل إلى خوادمنا بعد. سنواصل المحاولة. | B: 'خوادمنا' literal; D: feminine plural 'بعض التغييرات لم تصل'. | | Not reviewed |
| `privacy.exportHeading` | Get a copy of your data | احصل على نسخة من بياناتك | E: DSAR right. | | Not reviewed |
| `privacy.exportBody` | Ask for a copy of the personal data we hold about you. We aim to have it ready within 72 hours. | اطلب نسخة من البيانات الشخصية التي نحتفظ بها عنك. نستهدف تجهيزها خلال 72 ساعة. | E: '72 ساعة' is a target, spec says DSAR default SLA 30 days and export ready <=72h (VERIFY row 1). 'نستهدف' is a literal of 'aim'. Legal review. | | Not reviewed |
| `privacy.exportButton` | Request my data | اطلب بياناتي | E: DSAR action; D: 'اطلب' masculine. | | Not reviewed |
| `privacy.exportRequested` | Request received. We will let you know when your data is ready. | تم استلام طلبك. سنخبرك عندما تكون بياناتك جاهزة. | E: DSAR acknowledgement. | | Not reviewed |
| `privacy.deleteHeading` | Delete my account | حذف حسابي | E: erasure right. | | Not reviewed |
| `privacy.deleteIntro` | Deleting your account removes your personal data. Please read this first. | حذف حسابك يزيل بياناتك الشخصية. يُرجى قراءة ما يلي أولًا. | E: 'يزيل بياناتك الشخصية' is stronger than actual (some records retained). Legal review. | | Not reviewed |
| `privacy.deleteCooling` | There is a {{days}}-day waiting period. Your account stays recoverable during that time and you can cancel the deletion whenever you like in that period. | هناك مهلة انتظار مدتها {{days}} يومًا. يظل حسابك قابلًا للاسترجاع خلالها، ويمكنك إلغاء الحذف في أي وقت خلال هذه المدة. | D: {{days}} 'يومًا' only correct for 11+ (3-10 need 'أيام'). E: 14-day cooling period commitment. | | Not reviewed |
| `privacy.deleteLegal` | Some records, such as orders and payments, are kept in a de-identified form where the law requires it. | تُحفظ بعض السجلات، مثل الطلبات والمدفوعات، بصورة مجهّلة الهوية حيثما يتطلب القانون ذلك. | E: retention disclosure. 'مجهّلة الهوية' means anonymised, while spec says pseudonymised (EN 'de-identified' also vague). Legal-grade review of the term. A: 'حيثما' MSA. | | Not reviewed |
| `privacy.deleteForfeiture` | You have {{amount}} {{currency}} in store credit. If you delete your account this credit is lost and cannot be restored. | لديك رصيد متجر بقيمة {{amount}} {{currency}}. عند حذف حسابك يضيع هذا الرصيد ولا يمكن استرجاعه. | C/E: 'رصيد متجر' (store credit) must follow the glossary: spec requires 'HAUL credit' style (رصيد Z-OUTLET), never cash/money. 'رصيد' also means phone airtime in Egyptian use. Forfeiture is legally sensitive (VERIFY). D: {{amount}} {{currency}} number/currency bidi ordering. | | Not reviewed |
| `privacy.deleteAcknowledge` | I understand that my store credit will be lost. | أفهم أن رصيد المتجر الخاص بي سيضيع. | C/E: same 'رصيد المتجر' term issue; acknowledgement of forfeiture is legally sensitive. D: 'أفهم' neutral. | | Not reviewed |
| `privacy.deleteBlockedHeading` | We cannot delete your account yet | لا يمكننا حذف حسابك الآن | A: MSA. | | Not reviewed |
| `privacy.deleteBlockedOrders` | {{count}} open order(s) must be completed first. | يجب إتمام {{count}} طلب مفتوح أولًا. | D: plural: '{{count}} طلب مفتوح' wrong for 2, 3-10 (طلبات), 11+; EN uses 'order(s)'. Needs plural-aware key. | | Not reviewed |
| `privacy.deleteBlockedReturns` | {{count}} open return(s) must be completed first. | يجب إتمام {{count}} طلب إرجاع مفتوح أولًا. | C/D: 'طلب إرجاع' vs Egyptian/consumer-law 'استرجاع/استبدال'; plural issue as above. | | Not reviewed |
| `privacy.deleteBlockedDisputes` | {{count}} open dispute(s) must be resolved first. | يجب حلّ {{count}} نزاع مفتوح أولًا. | D: plural issue; B/A: 'نزاع' MSA/legal; Egyptian 'شكوى/اعتراض' may fit better; confirm legal meaning (dispute vs complaint). | | Not reviewed |
| `privacy.deleteButton` | Delete my account | حذف حسابي | E: destructive action label. | | Not reviewed |
| `privacy.deleteRequested` | Deletion requested. Your account will be erased after the waiting period unless you cancel. | تم طلب الحذف. سيُمحى حسابك بعد مهلة الانتظار ما لم تلغِ الطلب. | E: 'سيُمحى حسابك' timing commitment; D: masculine 'تلغِ'. | | Not reviewed |
| `privacy.deleteCancel` | Cancel the deletion | إلغاء الحذف | B: fine; confirm. | | Not reviewed |
| `privacy.deleteCancelled` | Deletion cancelled. | تم إلغاء الحذف. | none raised | | Not reviewed |
| `privacy.sessionsHeading` | Active sessions | الجلسات النشطة | B: 'الجلسات' literal for 'sessions'; Egyptian users may prefer 'الأجهزة المسجّل دخولها'. | | Not reviewed |
| `privacy.sessionsPlaceholder` | A list of the devices signed in to your account will appear here. | ستظهر هنا قائمة بالأجهزة المسجّل دخولها إلى حسابك. | B: long literal; placeholder text, ensure removed when real data. | | Not reviewed |
| `privacy.sessionsEmpty` | No other sessions to show. | لا توجد جلسات أخرى لعرضها. | A: MSA 'لا توجد'. | | Not reviewed |

### Language names

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `language.arabic` | العربية | العربية | none raised | | Not reviewed |
| `language.english` | English | English | none raised | | Not reviewed |

### App

| Key | EN | AR | Flags and reasons | Reviewer proposal | Status |
|---|---|---|---|---|---|
| `app.name` | {{product}} | {{product}} | none raised | | Not reviewed |

## 6. Reviewer checklist
- [ ] Register decision recorded (Egyptian vs light-MSA) and applied across all screens.
- [ ] Every glossary term decided; no string contradicts the glossary.
- [ ] Store credit never says cash/money/نقد/فلوس; "رصيد" cannot be misread as airtime.
- [ ] Plural forms drafted for every count/days/seconds string (1, 2, 3-10, 11+).
- [ ] Gender policy decided; "أنت جاهز" and imperatives revised accordingly.
- [ ] Digit style and date format decided; bidi checked for phone, amount, date.
- [ ] Mobile vs هاتف and رمز vs كود made consistent.
- [ ] Consent texts read as specific, free, easy to withdraw (PDPL); nothing implies pre-ticked.
- [ ] Age and attestation texts do not confuse 18 (account) with 21 (Plus/instalments).
- [ ] No string states a verified price or discount unless a price badge backs it.
- [ ] Text fits on small screens in RTL (long consent and deletion strings).
- [ ] Spelling, tashkeel and hamza checked; punctuation uses Arabic comma/question mark consistently.
- [ ] Screen reader pronunciation spot-check on mixed AR/Latin/digits strings.

## 7. Sign-off table
No row is signed. Dates and names to be filled by the named role only.

| Area | Keys | Linguistic reviewer (native Egyptian) | Legal reviewer (counsel) | Product owner | Status |
|---|---|---|---|---|---|
| Navigation, home, common, errors | tabs, home, common, errors | | n/a (home.title: legal) | | Not reviewed |
| Onboarding phone/OTP | onboarding.phone, onboarding.otp | | | | Not reviewed |
| Date of birth and age block | onboarding.dob, age | | Required | | Not reviewed |
| Consents (onboarding and purposes) | onboarding.consents, consent | | Required | | Not reviewed |
| Privacy Center, export, deletion | privacy | | Required | | Not reviewed |
| Language and welcome | onboarding.language, onboarding.welcome, language | | n/a | | Not reviewed |
| Glossary | section 4 | | Required for E terms | | Not reviewed |

## 8. Summary counts
119 keys; 87 carry at least one flag; 47 carry an E flag (legal-grade review). Counts are the author's draft, not a quality score.
