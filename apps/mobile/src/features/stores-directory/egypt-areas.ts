/**
 * Egypt location dataset for the outlets filter (client-side, pure). Source: reports/Egypt outlet location filter.md.
 * Governorate ids are the repo coverage codes (packages/domain/src/addresses/coverage-data.ts) and must never be renamed;
 * a drift test compares them with that file.
 *
 * KNOWN CODE CONFLICT: the repo uses `EG-QH` for Qalyubia, ISO 3166-2:EG lists `EG-KB` (report, defect 2 / verify row 2).
 * We keep the repo code on purpose (it is persisted in saved addresses and orders). Do not change it without an ADR.
 *
 * `verified: false` means the report marks the placement or spelling UNVERIFIED (general knowledge only) or says it was not
 * researched. Such rows must never be presented as official. Dev/QA seed data only until checked against CAPMAS or the
 * governorate sites (report, "Verify before launch" rows 3 to 6).
 */
import { normalizeQuery } from "./model";

export type AreaKind = "governorate" | "city" | "district" | "neighbourhood";

export interface EgyptGovernorate {
  readonly id: string;
  readonly kind: "governorate";
  readonly ar: string;
  readonly en: string;
}

export interface EgyptArea {
  /** Kebab slug, reusing the repo city slug where one exists. */
  readonly id: string;
  readonly governorateId: string;
  readonly kind: Exclude<AreaKind, "governorate">;
  readonly ar: string;
  readonly en: string;
  /** Search-only spellings: Franco-Arabic, Latin variants, Arabic variants. Matched after `normalizeQuery` folding. */
  readonly aliases: readonly string[];
  readonly verified: boolean;
}

const g = (id: string, ar: string, en: string): EgyptGovernorate => ({ id, kind: "governorate", ar, en });

/** All 27 governorates (CONFIRMED in the report; names as in the repo fixture). */
export const EGYPT_GOVERNORATES: readonly EgyptGovernorate[] = [
  g("EG-C", "القاهرة", "Cairo"),
  g("EG-GZ", "الجيزة", "Giza"),
  g("EG-ALX", "الإسكندرية", "Alexandria"),
  g("EG-QH", "القليوبية", "Qalyubia"),
  g("EG-SHR", "الشرقية", "Sharqia"),
  g("EG-DK", "الدقهلية", "Dakahlia"),
  g("EG-BH", "البحيرة", "Beheira"),
  g("EG-FYM", "الفيوم", "Faiyum"),
  g("EG-GH", "الغربية", "Gharbia"),
  g("EG-IS", "الإسماعيلية", "Ismailia"),
  g("EG-MNF", "المنوفية", "Monufia"),
  g("EG-MN", "المنيا", "Minya"),
  g("EG-WAD", "الوادي الجديد", "New Valley"),
  g("EG-SUZ", "السويس", "Suez"),
  g("EG-ASN", "أسوان", "Aswan"),
  g("EG-AST", "أسيوط", "Asyut"),
  g("EG-BNS", "بني سويف", "Beni Suef"),
  g("EG-PTS", "بورسعيد", "Port Said"),
  g("EG-DT", "دمياط", "Damietta"),
  g("EG-JS", "جنوب سيناء", "South Sinai"),
  g("EG-KFS", "كفر الشيخ", "Kafr El Sheikh"),
  g("EG-MT", "مطروح", "Matrouh"),
  g("EG-KN", "قنا", "Qena"),
  g("EG-SIN", "شمال سيناء", "North Sinai"),
  g("EG-SHG", "سوهاج", "Sohag"),
  g("EG-BA", "البحر الأحمر", "Red Sea"),
  g("EG-LX", "الأقصر", "Luxor"),
];

const a = (id: string, governorateId: string, kind: EgyptArea["kind"], ar: string, en: string, aliases: readonly string[], verified: boolean): EgyptArea =>
  ({ id, governorateId, kind, ar, en, aliases, verified });

/** Seed areas. Kept roughly alphabetical per governorate by English name; screens re-sort with `sortByName`. */
export const EGYPT_AREAS: readonly EgyptArea[] = [
  // Cairo. CONFIRMED placements (report, Wikipedia rows).
  a("ain-shams", "EG-C", "district", "عين شمس", "Ain Shams", ["Ain Shams", "Ein Shams"], true),
  a("downtown", "EG-C", "neighbourhood", "وسط البلد", "Downtown", ["Wust El Balad", "Wost El Balad", "Down Town"], true),
  a("fifth-settlement", "EG-C", "neighbourhood", "التجمع الخامس", "Fifth Settlement / Tagamoa", ["5th Settlement", "Tagamoa", "Tagamo3", "Tagammu", "Al Tagmou Al Khames", "التجمع"], true),
  a("helwan", "EG-C", "district", "حلوان", "Helwan", ["Helwan", "Helouan"], true),
  a("heliopolis", "EG-C", "district", "مصر الجديدة", "Heliopolis / Masr El Gedida", ["Heliopolis", "Masr El Gedida", "Misr El Gedida", "Masr Elgedida"], true),
  a("maadi", "EG-C", "district", "المعادي", "Maadi", ["Maadi", "Ma3adi", "Al Maadi"], true),
  a("mokattam", "EG-C", "district", "المقطم", "Mokattam", ["Mokattam", "Muqattam", "Mokatam"], true),
  a("nasr-city", "EG-C", "district", "مدينة نصر", "Nasr City", ["Nasr City", "Madinet Nasr", "Medinet Nasr"], true),
  a("new-cairo", "EG-C", "city", "القاهرة الجديدة", "New Cairo", ["New Cairo", "Cairo El Gedida", "Al Qahira Al Gedida"], true),
  a("new-capital", "EG-C", "city", "العاصمة الإدارية الجديدة", "The New Capital", ["New Capital", "Administrative Capital", "NAC", "العاصمة الادارية"], true),
  a("shorouk", "EG-C", "city", "الشروق", "El Shorouk", ["Shorouk", "El Shorouk", "Al Shorouk", "Shorok"], true),
  a("shubra", "EG-C", "district", "شبرا", "Shubra", ["Shubra", "Shobra"], true),
  a("zamalek", "EG-C", "neighbourhood", "الزمالك", "Zamalek", ["Zamalek", "El Zamalek"], true),
  // Cairo. UNVERIFIED (report: Arabic wording unverified, or compound whose governorate is in no fetched source).
  a("15th-may-city", "EG-C", "city", "مدينة 15 مايو", "15th of May City", ["15 May", "Fifteenth of May", "15th May"], false),
  a("badr-city", "EG-C", "city", "مدينة بدر", "Badr City", ["Badr", "Badr City"], false),
  a("madinaty", "EG-C", "neighbourhood", "مدينتي", "Madinaty", ["Madinaty", "Medinaty", "Madinati"], false),
  a("rehab-city", "EG-C", "neighbourhood", "الرحاب", "Rehab City", ["Rehab", "El Rehab", "Al Rehab"], false),
  // Giza. CONFIRMED: 6th of October, Sheikh Zayed, Dokki, Imbaba.
  a("6th-october", "EG-GZ", "city", "السادس من أكتوبر", "6th of October City", ["6th of October", "6 October", "6th October", "Sitta October", "Sitta Oktober", "October", "6 اكتوبر", "٦ أكتوبر", "سيتة اكتوبر"], true),
  a("dokki", "EG-GZ", "district", "الدقي", "Dokki", ["Dokki", "Doqi"], true),
  a("imbaba", "EG-GZ", "district", "إمبابة", "Imbaba", ["Imbaba", "Embaba"], true),
  a("sheikh-zayed", "EG-GZ", "city", "الشيخ زايد", "Sheikh Zayed City", ["Sheikh Zayed", "Sheikh Zaid", "El Sheikh Zayed", "Zayed", "Shaikh Zayed"], true),
  // Giza. UNVERIFIED mappings (report: neighbourhoods under Dokki/Agouza qisms, or governorate not confirmed).
  a("agouza", "EG-GZ", "district", "العجوزة", "Agouza", ["Agouza", "Agoza", "El Agouza"], false),
  a("hadayek-el-ahram", "EG-GZ", "neighbourhood", "حدائق الأهرام", "Hadayek El Ahram", ["Hadayek El Ahram", "Hadaek El Ahram", "Pyramids Gardens"], false),
  a("faisal", "EG-GZ", "district", "فيصل", "Faisal", ["Faisal", "Feisal"], false),
  a("haram", "EG-GZ", "district", "الهرم", "Haram", ["Haram", "Al Haram", "Giza Pyramids"], false),
  a("mohandessin", "EG-GZ", "neighbourhood", "المهندسين", "Mohandessin", ["Mohandessin", "Mohandiseen", "Mohandeseen", "Mohandsin"], false),
  // Alexandria. In the repo only; no web source was checked (report: Alexandria districts not researched).
  a("agami", "EG-ALX", "district", "العجمي", "Agami", ["Agami", "Agamy"], false),
  a("borg-el-arab", "EG-ALX", "city", "برج العرب", "Borg El Arab", ["Borg El Arab", "Burg Al Arab"], false),
  a("montaza", "EG-ALX", "district", "المنتزه", "Montaza", ["Montaza", "Montazah"], false),
  a("smouha", "EG-ALX", "neighbourhood", "سموحة", "Smouha", ["Smouha", "Smoha"], false),
  // Qalyubia (repo code EG-QH, ISO EG-KB, see header). UNVERIFIED: not Cairo governorate, in the repo only.
  a("obour", "EG-QH", "city", "العبور", "El Obour", ["Obour", "El Obour", "Al Obour", "Oboor"], false),
  a("shubra-el-kheima", "EG-QH", "city", "شبرا الخيمة", "Shubra El Kheima", ["Shubra El Kheima", "Shobra El Kheima", "Shubra Kheima"], false),
  // Red Sea, South Sinai, Matrouh: repo "major cities" seed, not independently verified (report).
  a("hurghada", "EG-BA", "city", "الغردقة", "Hurghada", ["Hurghada", "Ghardaqa", "El Ghardaka"], false),
  a("sharm-el-sheikh", "EG-JS", "city", "شرم الشيخ", "Sharm El Sheikh", ["Sharm El Sheikh", "Sharm", "Sharm Elsheikh"], false),
  a("el-alamein", "EG-MT", "city", "العلمين", "El Alamein", ["Alamein", "North Coast", "Sahel", "الساحل الشمالي", "الساحل"], false),
  a("marsa-matrouh", "EG-MT", "city", "مرسى مطروح", "Marsa Matrouh", ["Matrouh", "Marsa Matruh", "North Coast", "الساحل الشمالي"], false),
];

const GOV_BY_ID = new Map(EGYPT_GOVERNORATES.map((x) => [x.id, x]));
const AREA_BY_ID = new Map(EGYPT_AREAS.map((x) => [x.id, x]));

export function governorateById(id: string): EgyptGovernorate | undefined {
  return GOV_BY_ID.get(id);
}
export function areaById(id: string): EgyptArea | undefined {
  return AREA_BY_ID.get(id);
}
export function areasOfGovernorate(governorateId: string): readonly EgyptArea[] {
  return EGYPT_AREAS.filter((x) => x.governorateId === governorateId);
}

export function nameOf(x: { readonly ar: string; readonly en: string }, locale: "ar" | "en"): string {
  return locale === "ar" ? x.ar : x.en;
}

/** Alias-aware, alef/ya/ta-marbuta-folding match on both names, aliases and the parent governorate name. Empty query matches everything. */
export function matchesArea(area: EgyptArea, query: string): boolean {
  const q = normalizeQuery(query);
  if (q.length === 0) return true;
  const gov = GOV_BY_ID.get(area.governorateId);
  const hay = [area.ar, area.en, ...area.aliases, gov?.ar ?? "", gov?.en ?? ""];
  return hay.some((h) => normalizeQuery(h).includes(q));
}

export function searchAreas(areas: readonly EgyptArea[], query: string): readonly EgyptArea[] {
  return areas.filter((x) => matchesArea(x, query));
}

type Named = { readonly ar: string; readonly en: string };

/** Sorts by localized name. Arabic uses Intl.Collator('ar'); when the runtime lacks it, falls back to a folded code-point order. */
export function sortByName<T extends Named>(items: readonly T[], locale: "ar" | "en"): readonly T[] {
  let cmp: (x: string, y: string) => number;
  try {
    const c = new Intl.Collator(locale);
    cmp = c.resolvedOptions().locale.toLowerCase().startsWith(locale) ? (x, y) => c.compare(x, y) : (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  } catch {
    cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  }
  const fold = (x: T) => normalizeQuery(nameOf(x, locale));
  return [...items].sort((x, y) => cmp(fold(x), fold(y)));
}
