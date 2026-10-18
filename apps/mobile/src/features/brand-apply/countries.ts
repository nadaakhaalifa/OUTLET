/** Country data for the brand application (ISO 3166-1 alpha-2, Arabic + English names). Pure and tested. */
export interface Country {
  readonly code: string;
  readonly ar: string;
  readonly en: string;
}

const RAW: readonly (readonly [string, string, string])[] = [
  ["EG", "مصر", "Egypt"], ["AE", "الإمارات", "United Arab Emirates"], ["SA", "السعودية", "Saudi Arabia"], ["KW", "الكويت", "Kuwait"],
  ["QA", "قطر", "Qatar"], ["BH", "البحرين", "Bahrain"], ["OM", "عُمان", "Oman"], ["JO", "الأردن", "Jordan"], ["LB", "لبنان", "Lebanon"],
  ["MA", "المغرب", "Morocco"], ["TN", "تونس", "Tunisia"], ["DZ", "الجزائر", "Algeria"], ["LY", "ليبيا", "Libya"], ["IQ", "العراق", "Iraq"],
  ["PS", "فلسطين", "Palestine"], ["SD", "السودان", "Sudan"], ["TR", "تركيا", "Turkey"], ["GB", "المملكة المتحدة", "United Kingdom"],
  ["FR", "فرنسا", "France"], ["DE", "ألمانيا", "Germany"], ["IT", "إيطاليا", "Italy"], ["ES", "إسبانيا", "Spain"], ["PT", "البرتغال", "Portugal"],
  ["NL", "هولندا", "Netherlands"], ["BE", "بلجيكا", "Belgium"], ["CH", "سويسرا", "Switzerland"], ["AT", "النمسا", "Austria"],
  ["SE", "السويد", "Sweden"], ["NO", "النرويج", "Norway"], ["DK", "الدنمارك", "Denmark"], ["FI", "فنلندا", "Finland"], ["IE", "أيرلندا", "Ireland"],
  ["PL", "بولندا", "Poland"], ["CZ", "التشيك", "Czechia"], ["GR", "اليونان", "Greece"], ["RO", "رومانيا", "Romania"], ["HU", "المجر", "Hungary"],
  ["UA", "أوكرانيا", "Ukraine"], ["RU", "روسيا", "Russia"], ["US", "الولايات المتحدة", "United States"], ["CA", "كندا", "Canada"],
  ["MX", "المكسيك", "Mexico"], ["BR", "البرازيل", "Brazil"], ["AR", "الأرجنتين", "Argentina"], ["CL", "تشيلي", "Chile"], ["CO", "كولومبيا", "Colombia"],
  ["PE", "بيرو", "Peru"], ["CN", "الصين", "China"], ["HK", "هونغ كونغ", "Hong Kong"], ["TW", "تايوان", "Taiwan"], ["JP", "اليابان", "Japan"],
  ["KR", "كوريا الجنوبية", "South Korea"], ["IN", "الهند", "India"], ["PK", "باكستان", "Pakistan"], ["BD", "بنغلاديش", "Bangladesh"],
  ["LK", "سريلانكا", "Sri Lanka"], ["TH", "تايلاند", "Thailand"], ["VN", "فيتنام", "Vietnam"], ["MY", "ماليزيا", "Malaysia"],
  ["SG", "سنغافورة", "Singapore"], ["ID", "إندونيسيا", "Indonesia"], ["PH", "الفلبين", "Philippines"], ["AU", "أستراليا", "Australia"],
  ["NZ", "نيوزيلندا", "New Zealand"], ["ZA", "جنوب أفريقيا", "South Africa"], ["NG", "نيجيريا", "Nigeria"], ["KE", "كينيا", "Kenya"],
  ["ET", "إثيوبيا", "Ethiopia"], ["GH", "غانا", "Ghana"], ["SN", "السنغال", "Senegal"], ["CY", "قبرص", "Cyprus"], ["MT", "مالطا", "Malta"],
  ["LU", "لوكسمبورغ", "Luxembourg"], ["IS", "آيسلندا", "Iceland"], ["BG", "بلغاريا", "Bulgaria"], ["HR", "كرواتيا", "Croatia"], ["RS", "صربيا", "Serbia"],
  ["IL", "إسرائيل", "Israel"], ["IR", "إيران", "Iran"], ["KZ", "كازاخستان", "Kazakhstan"], ["UZ", "أوزبكستان", "Uzbekistan"],
  ["MU", "موريشيوس", "Mauritius"], ["TZ", "تنزانيا", "Tanzania"], ["UG", "أوغندا", "Uganda"], ["CI", "ساحل العاج", "Côte d'Ivoire"],
];

export const COUNTRIES: readonly Country[] = RAW.map(([code, ar, en]) => ({ code, ar, en }));

/** Regional-indicator flag emoji from an ISO alpha-2 code. */
export function flagEmoji(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** Folds Arabic variants and case so "مصر", "مِصر" and "EGYPT" all match. */
export function foldSearch(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function countryName(c: Country, lang: "ar" | "en"): string {
  return lang === "ar" ? c.ar : c.en;
}

export function findCountry(code: string): Country | undefined {
  return COUNTRIES.find((c) => c.code === code);
}

/**
 * Country list for the picker. Local brands: Egypt only unless `localCountries` (countries that have a
 * requirements row) says more; Egypt is always pinned first. Global brands: every country, Egypt pinned first.
 */
export function countryList(opts: { kind: "local" | "global"; query: string; localCountries?: readonly string[] }): readonly Country[] {
  const q = foldSearch(opts.query);
  const base =
    opts.kind === "local"
      ? COUNTRIES.filter((c) => c.code === "EG" || (opts.localCountries ?? []).includes(c.code))
      : COUNTRIES;
  const filtered = q === "" ? base : base.filter((c) => foldSearch(c.ar).includes(q) || foldSearch(c.en).includes(q) || c.code.toLowerCase() === q);
  const eg = filtered.filter((c) => c.code === "EG");
  const rest = filtered.filter((c) => c.code !== "EG").sort((a, b) => a.en.localeCompare(b.en));
  return [...eg, ...rest];
}

export function defaultCountry(kind: "local" | "global"): string | null {
  return kind === "local" ? "EG" : null;
}
