/**
 * Fixture list of Egypt's 27 governorates and major cities (Arabic and English), plus the seed
 * courier coverage. Plain data with no imports so the migration seed can be generated from it
 * (node strips the types). Codes follow ISO 3166-2:EG. The runtime source of truth is the
 * coverage tables (admin-editable later); this file only seeds them.
 */
export type CityFixture = readonly [code: string, nameAr: string, nameEn: string];
export type GovernorateFixture = readonly [code: string, nameAr: string, nameEn: string, cities: readonly CityFixture[]];

export const GOVERNORATE_FIXTURES: readonly GovernorateFixture[] = [
  ["EG-C", "القاهرة", "Cairo", [["nasr-city", "مدينة نصر", "Nasr City"], ["heliopolis", "مصر الجديدة", "Heliopolis"], ["maadi", "المعادي", "Maadi"], ["new-cairo", "القاهرة الجديدة", "New Cairo"], ["shorouk", "الشروق", "El Shorouk"], ["downtown", "وسط البلد", "Downtown"]]],
  ["EG-GZ", "الجيزة", "Giza", [["dokki", "الدقي", "Dokki"], ["mohandessin", "المهندسين", "Mohandessin"], ["haram", "الهرم", "Haram"], ["sheikh-zayed", "الشيخ زايد", "Sheikh Zayed"], ["6th-october", "السادس من أكتوبر", "6th of October"]]],
  ["EG-ALX", "الإسكندرية", "Alexandria", [["smouha", "سموحة", "Smouha"], ["montaza", "المنتزه", "Montaza"], ["agami", "العجمي", "Agami"], ["borg-el-arab", "برج العرب", "Borg El Arab"]]],
  ["EG-QH", "القليوبية", "Qalyubia", [["banha", "بنها", "Banha"], ["shubra-el-kheima", "شبرا الخيمة", "Shubra El Kheima"], ["qalyub", "قليوب", "Qalyub"], ["obour", "العبور", "El Obour"]]],
  ["EG-SHR", "الشرقية", "Sharqia", [["zagazig", "الزقازيق", "Zagazig"], ["10th-ramadan", "العاشر من رمضان", "10th of Ramadan"], ["belbeis", "بلبيس", "Belbeis"]]],
  ["EG-DK", "الدقهلية", "Dakahlia", [["mansoura", "المنصورة", "Mansoura"], ["mit-ghamr", "ميت غمر", "Mit Ghamr"], ["talkha", "طلخا", "Talkha"]]],
  ["EG-BH", "البحيرة", "Beheira", [["damanhur", "دمنهور", "Damanhur"], ["kafr-el-dawwar", "كفر الدوار", "Kafr El Dawwar"], ["rashid", "رشيد", "Rashid"]]],
  ["EG-FYM", "الفيوم", "Faiyum", [["fayoum-city", "مدينة الفيوم", "Faiyum City"], ["sinnuris", "سنورس", "Sinnuris"]]],
  ["EG-GH", "الغربية", "Gharbia", [["tanta", "طنطا", "Tanta"], ["mahalla", "المحلة الكبرى", "El Mahalla El Kubra"], ["kafr-el-zayat", "كفر الزيات", "Kafr El Zayat"]]],
  ["EG-IS", "الإسماعيلية", "Ismailia", [["ismailia-city", "مدينة الإسماعيلية", "Ismailia City"], ["fayed", "فايد", "Fayed"]]],
  ["EG-MNF", "المنوفية", "Monufia", [["shebin-el-kom", "شبين الكوم", "Shebin El Kom"], ["sadat-city", "مدينة السادات", "Sadat City"], ["menouf", "منوف", "Menouf"]]],
  ["EG-MN", "المنيا", "Minya", [["minya-city", "مدينة المنيا", "Minya City"], ["mallawi", "ملوي", "Mallawi"], ["samalut", "سمالوط", "Samalut"]]],
  ["EG-WAD", "الوادي الجديد", "New Valley", [["kharga", "الخارجة", "Kharga"], ["dakhla", "الداخلة", "Dakhla"]]],
  ["EG-SUZ", "السويس", "Suez", [["suez-city", "مدينة السويس", "Suez City"], ["ain-sokhna", "العين السخنة", "Ain Sokhna"]]],
  ["EG-ASN", "أسوان", "Aswan", [["aswan-city", "مدينة أسوان", "Aswan City"], ["edfu", "إدفو", "Edfu"], ["kom-ombo", "كوم أمبو", "Kom Ombo"]]],
  ["EG-AST", "أسيوط", "Asyut", [["asyut-city", "مدينة أسيوط", "Asyut City"], ["abnub", "أبنوب", "Abnub"], ["manfalut", "منفلوط", "Manfalut"]]],
  ["EG-BNS", "بني سويف", "Beni Suef", [["beni-suef-city", "مدينة بني سويف", "Beni Suef City"], ["wasta", "الواسطى", "El Wasta"]]],
  ["EG-PTS", "بورسعيد", "Port Said", [["port-said-city", "مدينة بورسعيد", "Port Said City"], ["port-fouad", "بورفؤاد", "Port Fouad"]]],
  ["EG-DT", "دمياط", "Damietta", [["damietta-city", "مدينة دمياط", "Damietta City"], ["new-damietta", "دمياط الجديدة", "New Damietta"], ["ras-el-bar", "رأس البر", "Ras El Bar"]]],
  ["EG-JS", "جنوب سيناء", "South Sinai", [["sharm-el-sheikh", "شرم الشيخ", "Sharm El Sheikh"], ["dahab", "دهب", "Dahab"], ["tor", "الطور", "El Tor"]]],
  ["EG-KFS", "كفر الشيخ", "Kafr El Sheikh", [["kafr-el-sheikh-city", "مدينة كفر الشيخ", "Kafr El Sheikh City"], ["desouk", "دسوق", "Desouk"], ["baltim", "بلطيم", "Baltim"]]],
  ["EG-MT", "مطروح", "Matrouh", [["marsa-matrouh", "مرسى مطروح", "Marsa Matrouh"], ["el-alamein", "العلمين", "El Alamein"], ["siwa", "سيوة", "Siwa"]]],
  ["EG-KN", "قنا", "Qena", [["qena-city", "مدينة قنا", "Qena City"], ["nag-hammadi", "نجع حمادي", "Nag Hammadi"]]],
  ["EG-SIN", "شمال سيناء", "North Sinai", [["arish", "العريش", "El Arish"], ["sheikh-zuweid", "الشيخ زويد", "Sheikh Zuweid"]]],
  ["EG-SHG", "سوهاج", "Sohag", [["sohag-city", "مدينة سوهاج", "Sohag City"], ["akhmim", "أخميم", "Akhmim"], ["girga", "جرجا", "Girga"]]],
  ["EG-BA", "البحر الأحمر", "Red Sea", [["hurghada", "الغردقة", "Hurghada"], ["el-gouna", "الجونة", "El Gouna"], ["marsa-alam", "مرسى علم", "Marsa Alam"], ["safaga", "سفاجا", "Safaga"]]],
  ["EG-LX", "الأقصر", "Luxor", [["luxor-city", "مدينة الأقصر", "Luxor City"], ["esna", "إسنا", "Esna"]]],
];

export type CourierFixture = readonly [courier: string, codSupported: boolean];

/** Seed couriers. Aramex is a narrower network and does not offer COD collection here. */
export const COURIER_FIXTURES: readonly CourierFixture[] = [["bosta", true], ["aramex", false]];

/** Governorates a courier does NOT serve at governorate level (seed assumption, VERIFY VR-11). */
export const COURIER_GOVERNORATE_EXCLUSIONS: Readonly<Record<string, readonly string[]>> = {
  bosta: ["EG-WAD", "EG-SIN"],
  aramex: ["EG-WAD", "EG-SIN", "EG-FYM", "EG-BNS", "EG-KFS", "EG-DT", "EG-MT", "EG-KN", "EG-SHG", "EG-MN", "EG-BH", "EG-SUZ"],
};

/** City-level exceptions: [courier, governorate, city, covered]. */
export const COURIER_CITY_OVERRIDES: readonly (readonly [string, string, string, boolean])[] = [
  ["bosta", "EG-BA", "marsa-alam", false],
  ["bosta", "EG-MT", "siwa", false],
  ["aramex", "EG-JS", "tor", false],
];
