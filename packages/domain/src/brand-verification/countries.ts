/**
 * ISO 3166-1 alpha-2 country list with English and Arabic short names (brand onboarding, ADR-0031).
 * HAND-AUTHORED data: Arabic names follow common usage in Egyptian media. VERIFY BEFORE LAUNCH with a
 * native-speaking reviewer before any name is shown to a brand in the UI.
 */
export interface Country {
  readonly code: string;
  readonly en: string;
  readonly ar: string;
}

const RAW: readonly (readonly [string, string, string])[] = [
  ["AF", "Afghanistan", "أفغانستان"], ["AX", "Aland Islands", "جزر أولاند"], ["AL", "Albania", "ألبانيا"],
  ["DZ", "Algeria", "الجزائر"], ["AS", "American Samoa", "ساموا الأمريكية"], ["AD", "Andorra", "أندورا"],
  ["AO", "Angola", "أنجولا"], ["AI", "Anguilla", "أنغويلا"], ["AQ", "Antarctica", "أنتاركتيكا"],
  ["AG", "Antigua and Barbuda", "أنتيغوا وبربودا"], ["AR", "Argentina", "الأرجنتين"], ["AM", "Armenia", "أرمينيا"],
  ["AW", "Aruba", "أروبا"], ["AU", "Australia", "أستراليا"], ["AT", "Austria", "النمسا"],
  ["AZ", "Azerbaijan", "أذربيجان"], ["BS", "Bahamas", "جزر البهاما"], ["BH", "Bahrain", "البحرين"],
  ["BD", "Bangladesh", "بنغلاديش"], ["BB", "Barbados", "بربادوس"], ["BY", "Belarus", "بيلاروسيا"],
  ["BE", "Belgium", "بلجيكا"], ["BZ", "Belize", "بليز"], ["BJ", "Benin", "بنين"],
  ["BM", "Bermuda", "برمودا"], ["BT", "Bhutan", "بوتان"], ["BO", "Bolivia", "بوليفيا"],
  ["BQ", "Bonaire, Sint Eustatius and Saba", "بونير وسانت أوستاتيوس وسابا"], ["BA", "Bosnia and Herzegovina", "البوسنة والهرسك"],
  ["BW", "Botswana", "بوتسوانا"], ["BV", "Bouvet Island", "جزيرة بوفيه"], ["BR", "Brazil", "البرازيل"],
  ["IO", "British Indian Ocean Territory", "إقليم المحيط الهندي البريطاني"], ["BN", "Brunei", "بروناي"],
  ["BG", "Bulgaria", "بلغاريا"], ["BF", "Burkina Faso", "بوركينا فاسو"], ["BI", "Burundi", "بوروندي"],
  ["CV", "Cabo Verde", "الرأس الأخضر"], ["KH", "Cambodia", "كمبوديا"], ["CM", "Cameroon", "الكاميرون"],
  ["CA", "Canada", "كندا"], ["KY", "Cayman Islands", "جزر كايمان"], ["CF", "Central African Republic", "جمهورية أفريقيا الوسطى"],
  ["TD", "Chad", "تشاد"], ["CL", "Chile", "تشيلي"], ["CN", "China", "الصين"],
  ["CX", "Christmas Island", "جزيرة كريسماس"], ["CC", "Cocos (Keeling) Islands", "جزر كوكوس"], ["CO", "Colombia", "كولومبيا"],
  ["KM", "Comoros", "جزر القمر"], ["CG", "Congo", "الكونغو"], ["CD", "Congo (Democratic Republic)", "جمهورية الكونغو الديمقراطية"],
  ["CK", "Cook Islands", "جزر كوك"], ["CR", "Costa Rica", "كوستاريكا"], ["CI", "Cote d'Ivoire", "كوت ديفوار"],
  ["HR", "Croatia", "كرواتيا"], ["CU", "Cuba", "كوبا"], ["CW", "Curacao", "كوراساو"],
  ["CY", "Cyprus", "قبرص"], ["CZ", "Czechia", "التشيك"], ["DK", "Denmark", "الدنمارك"],
  ["DJ", "Djibouti", "جيبوتي"], ["DM", "Dominica", "دومينيكا"], ["DO", "Dominican Republic", "الدومينيكان"],
  ["EC", "Ecuador", "الإكوادور"], ["EG", "Egypt", "مصر"], ["SV", "El Salvador", "السلفادور"],
  ["GQ", "Equatorial Guinea", "غينيا الاستوائية"], ["ER", "Eritrea", "إريتريا"], ["EE", "Estonia", "إستونيا"],
  ["SZ", "Eswatini", "إسواتيني"], ["ET", "Ethiopia", "إثيوبيا"], ["FK", "Falkland Islands", "جزر فوكلاند"],
  ["FO", "Faroe Islands", "جزر فارو"], ["FJ", "Fiji", "فيجي"], ["FI", "Finland", "فنلندا"],
  ["FR", "France", "فرنسا"], ["GF", "French Guiana", "غويانا الفرنسية"], ["PF", "French Polynesia", "بولينيزيا الفرنسية"],
  ["TF", "French Southern Territories", "الأقاليم الجنوبية الفرنسية"], ["GA", "Gabon", "الغابون"], ["GM", "Gambia", "غامبيا"],
  ["GE", "Georgia", "جورجيا"], ["DE", "Germany", "ألمانيا"], ["GH", "Ghana", "غانا"],
  ["GI", "Gibraltar", "جبل طارق"], ["GR", "Greece", "اليونان"], ["GL", "Greenland", "غرينلاند"],
  ["GD", "Grenada", "غرينادا"], ["GP", "Guadeloupe", "غوادلوب"], ["GU", "Guam", "غوام"],
  ["GT", "Guatemala", "غواتيمالا"], ["GG", "Guernsey", "غيرنزي"], ["GN", "Guinea", "غينيا"],
  ["GW", "Guinea-Bissau", "غينيا بيساو"], ["GY", "Guyana", "غيانا"], ["HT", "Haiti", "هايتي"],
  ["HM", "Heard Island and McDonald Islands", "جزيرة هيرد وجزر ماكدونالد"], ["VA", "Holy See", "الفاتيكان"], ["HN", "Honduras", "هندوراس"],
  ["HK", "Hong Kong", "هونغ كونغ"], ["HU", "Hungary", "المجر"], ["IS", "Iceland", "آيسلندا"],
  ["IN", "India", "الهند"], ["ID", "Indonesia", "إندونيسيا"], ["IR", "Iran", "إيران"],
  ["IQ", "Iraq", "العراق"], ["IE", "Ireland", "أيرلندا"], ["IM", "Isle of Man", "جزيرة مان"],
  ["IL", "Israel", "إسرائيل"], ["IT", "Italy", "إيطاليا"], ["JM", "Jamaica", "جامايكا"],
  ["JP", "Japan", "اليابان"], ["JE", "Jersey", "جيرزي"], ["JO", "Jordan", "الأردن"],
  ["KZ", "Kazakhstan", "كازاخستان"], ["KE", "Kenya", "كينيا"], ["KI", "Kiribati", "كيريباتي"],
  ["KP", "North Korea", "كوريا الشمالية"], ["KR", "South Korea", "كوريا الجنوبية"], ["KW", "Kuwait", "الكويت"],
  ["KG", "Kyrgyzstan", "قيرغيزستان"], ["LA", "Laos", "لاوس"], ["LV", "Latvia", "لاتفيا"],
  ["LB", "Lebanon", "لبنان"], ["LS", "Lesotho", "ليسوتو"], ["LR", "Liberia", "ليبيريا"],
  ["LY", "Libya", "ليبيا"], ["LI", "Liechtenstein", "ليختنشتاين"], ["LT", "Lithuania", "ليتوانيا"],
  ["LU", "Luxembourg", "لوكسمبورغ"], ["MO", "Macao", "ماكاو"], ["MG", "Madagascar", "مدغشقر"],
  ["MW", "Malawi", "ملاوي"], ["MY", "Malaysia", "ماليزيا"], ["MV", "Maldives", "جزر المالديف"],
  ["ML", "Mali", "مالي"], ["MT", "Malta", "مالطا"], ["MH", "Marshall Islands", "جزر مارشال"],
  ["MQ", "Martinique", "مارتينيك"], ["MR", "Mauritania", "موريتانيا"], ["MU", "Mauritius", "موريشيوس"],
  ["YT", "Mayotte", "مايوت"], ["MX", "Mexico", "المكسيك"], ["FM", "Micronesia", "ميكرونيزيا"],
  ["MD", "Moldova", "مولدوفا"], ["MC", "Monaco", "موناكو"], ["MN", "Mongolia", "منغوليا"],
  ["ME", "Montenegro", "الجبل الأسود"], ["MS", "Montserrat", "مونتسيرات"], ["MA", "Morocco", "المغرب"],
  ["MZ", "Mozambique", "موزمبيق"], ["MM", "Myanmar", "ميانمار"], ["NA", "Namibia", "ناميبيا"],
  ["NR", "Nauru", "ناورو"], ["NP", "Nepal", "نيبال"], ["NL", "Netherlands", "هولندا"],
  ["NC", "New Caledonia", "كاليدونيا الجديدة"], ["NZ", "New Zealand", "نيوزيلندا"], ["NI", "Nicaragua", "نيكاراغوا"],
  ["NE", "Niger", "النيجر"], ["NG", "Nigeria", "نيجيريا"], ["NU", "Niue", "نيوي"],
  ["NF", "Norfolk Island", "جزيرة نورفولك"], ["MK", "North Macedonia", "مقدونيا الشمالية"], ["MP", "Northern Mariana Islands", "جزر ماريانا الشمالية"],
  ["NO", "Norway", "النرويج"], ["OM", "Oman", "عمان"], ["PK", "Pakistan", "باكستان"],
  ["PW", "Palau", "بالاو"], ["PS", "Palestine", "فلسطين"], ["PA", "Panama", "بنما"],
  ["PG", "Papua New Guinea", "بابوا غينيا الجديدة"], ["PY", "Paraguay", "باراغواي"], ["PE", "Peru", "بيرو"],
  ["PH", "Philippines", "الفلبين"], ["PN", "Pitcairn", "جزر بيتكيرن"], ["PL", "Poland", "بولندا"],
  ["PT", "Portugal", "البرتغال"], ["PR", "Puerto Rico", "بورتوريكو"], ["QA", "Qatar", "قطر"],
  ["RE", "Reunion", "ريونيون"], ["RO", "Romania", "رومانيا"], ["RU", "Russia", "روسيا"],
  ["RW", "Rwanda", "رواندا"], ["BL", "Saint Barthelemy", "سان بارتليمي"], ["SH", "Saint Helena", "سانت هيلينا"],
  ["KN", "Saint Kitts and Nevis", "سانت كيتس ونيفيس"], ["LC", "Saint Lucia", "سانت لوسيا"], ["MF", "Saint Martin", "سان مارتن"],
  ["PM", "Saint Pierre and Miquelon", "سان بيير وميكلون"], ["VC", "Saint Vincent and the Grenadines", "سانت فنسنت والغرينادين"], ["WS", "Samoa", "ساموا"],
  ["SM", "San Marino", "سان مارينو"], ["ST", "Sao Tome and Principe", "ساو تومي وبرينسيبي"], ["SA", "Saudi Arabia", "السعودية"],
  ["SN", "Senegal", "السنغال"], ["RS", "Serbia", "صربيا"], ["SC", "Seychelles", "سيشل"],
  ["SL", "Sierra Leone", "سيراليون"], ["SG", "Singapore", "سنغافورة"], ["SX", "Sint Maarten", "سينت مارتن"],
  ["SK", "Slovakia", "سلوفاكيا"], ["SI", "Slovenia", "سلوفينيا"], ["SB", "Solomon Islands", "جزر سليمان"],
  ["SO", "Somalia", "الصومال"], ["ZA", "South Africa", "جنوب أفريقيا"], ["GS", "South Georgia and the South Sandwich Islands", "جورجيا الجنوبية وجزر ساندويتش الجنوبية"],
  ["SS", "South Sudan", "جنوب السودان"], ["ES", "Spain", "إسبانيا"], ["LK", "Sri Lanka", "سريلانكا"],
  ["SD", "Sudan", "السودان"], ["SR", "Suriname", "سورينام"], ["SJ", "Svalbard and Jan Mayen", "سفالبارد وجان ماين"],
  ["SE", "Sweden", "السويد"], ["CH", "Switzerland", "سويسرا"], ["SY", "Syria", "سوريا"],
  ["TW", "Taiwan", "تايوان"], ["TJ", "Tajikistan", "طاجيكستان"], ["TZ", "Tanzania", "تنزانيا"],
  ["TH", "Thailand", "تايلاند"], ["TL", "Timor-Leste", "تيمور الشرقية"], ["TG", "Togo", "توغو"],
  ["TK", "Tokelau", "توكيلاو"], ["TO", "Tonga", "تونغا"], ["TT", "Trinidad and Tobago", "ترينيداد وتوباغو"],
  ["TN", "Tunisia", "تونس"], ["TR", "Turkiye", "تركيا"], ["TM", "Turkmenistan", "تركمانستان"],
  ["TC", "Turks and Caicos Islands", "جزر تركس وكايكوس"], ["TV", "Tuvalu", "توفالو"], ["UG", "Uganda", "أوغندا"],
  ["UA", "Ukraine", "أوكرانيا"], ["AE", "United Arab Emirates", "الإمارات"], ["GB", "United Kingdom", "المملكة المتحدة"],
  ["US", "United States", "الولايات المتحدة"], ["UM", "United States Minor Outlying Islands", "جزر الولايات المتحدة النائية"], ["UY", "Uruguay", "أوروغواي"],
  ["UZ", "Uzbekistan", "أوزبكستان"], ["VU", "Vanuatu", "فانواتو"], ["VE", "Venezuela", "فنزويلا"],
  ["VN", "Vietnam", "فيتنام"], ["VG", "Virgin Islands (British)", "جزر فيرجن البريطانية"], ["VI", "Virgin Islands (US)", "جزر فيرجن الأمريكية"],
  ["WF", "Wallis and Futuna", "واليس وفوتونا"], ["EH", "Western Sahara", "الصحراء الغربية"], ["YE", "Yemen", "اليمن"],
  ["ZM", "Zambia", "زامبيا"], ["ZW", "Zimbabwe", "زيمبابوي"], ["XK", "Kosovo", "كوسوفو"],
];

export const COUNTRIES: readonly Country[] = RAW.map(([code, en, ar]) => ({ code, en, ar }));

const BY_CODE: ReadonlyMap<string, Country> = new Map(COUNTRIES.map((c) => [c.code, c]));

export const isKnownCountry = (code: string): boolean => BY_CODE.has(code);
export const findCountry = (code: string): Country | null => BY_CODE.get(code) ?? null;
