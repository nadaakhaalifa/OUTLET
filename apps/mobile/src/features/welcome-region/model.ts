import { z } from "zod";
import data from "./countries.generated.json";

/**
 * First-run region and "shop for" preference. Device-local only: nothing here is sent to a server, an SDK or
 * analytics, and no identifier is attached. It is not registration and does not gate browsing.
 *
 * Territory naming policy (NEEDS COUNSEL REVIEW, VERIFY row suggested in the task report): names are the
 * neutral CLDR default region names for ISO 3166-1 alpha-2 codes, shown as data with no editorial text, no
 * map imagery and no "country of" claims. Disputed or contested entries (for example PS, TW, HK, MO, EH, XK,
 * IL, AQ) use the CLDR name unchanged. XK is not an ISO code; it is the user-assigned code CLDR and common
 * platforms use, kept so no territory is omitted, and flagged `userAssigned`.
 */
export interface Country {
  readonly code: string;
  readonly en: string;
  /** DRAFT Arabic from CLDR, needs native review. */
  readonly ar: string;
  readonly userAssigned: boolean;
}

export const COUNTRIES: readonly Country[] = (data.countries as readonly { code: string; en: string; ar: string; userAssigned?: boolean }[]).map((c) => ({
  code: c.code, en: c.en, ar: c.ar, userAssigned: c.userAssigned === true,
}));

/** Markets served today. ADR-0040: Egypt only; `market` abstraction behind the single EG value. */
export const SERVED_MARKETS: readonly string[] = ["EG"];
export const HOME_MARKET = "EG";
export const isServed = (code: string): boolean => SERVED_MARKETS.includes(code);

export function countryName(c: Country, locale: string): string {
  return locale.startsWith("en") ? c.en : c.ar;
}

export type FlagView = { readonly kind: "emoji"; readonly glyph: string } | { readonly kind: "badge"; readonly text: string };

/** Two regional-indicator code points (UTS #51). Null when the code is not two A-Z letters. */
export function flagEmoji(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code)) return null;
  const base = 0x1f1e6 - 65;
  return String.fromCodePoint(base + code.charCodeAt(0), base + code.charCodeAt(1));
}

/** Flag decoration only; the text label is always shown beside it. User-assigned codes (XK) render unreliably, so use the code badge. */
export function flagFor(c: Pick<Country, "code" | "userAssigned">): FlagView {
  const glyph = flagEmoji(c.code);
  return glyph === null || c.userAssigned ? { kind: "badge", text: c.code } : { kind: "emoji", glyph };
}

/** Folds Arabic (alef variants, alef maqsura to ya, ta marbuta to ha, diacritics, tatweel, Eastern digits) and Latin diacritics for search. */
export function foldSearch(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[آأإٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

type Compare = (a: string, b: string) => number;
/** Intl.Collator for the locale when the runtime has it, else a code point comparison on folded text. */
export function makeCollator(locale: string): Compare {
  try {
    const c = new Intl.Collator(locale.startsWith("en") ? "en" : "ar");
    return (a, b) => c.compare(a, b);
  } catch {
    return (a, b) => { const x = foldSearch(a), y = foldSearch(b); return x < y ? -1 : x > y ? 1 : 0; };
  }
}

/** Egypt first, then everyone else sorted by localised name. */
export function sortedCountries(locale: string, compare: Compare = makeCollator(locale)): readonly Country[] {
  const rest = COUNTRIES.filter((c) => c.code !== HOME_MARKET).slice().sort((a, b) => compare(countryName(a, locale), countryName(b, locale)));
  const home = COUNTRIES.find((c) => c.code === HOME_MARKET);
  return home === undefined ? rest : [home, ...rest];
}

/** Matches the folded query against the English name, Arabic name and code. Egypt stays pinned first; prefix matches rank next. */
export function searchCountries(list: readonly Country[], query: string, locale: string): readonly Country[] {
  const q = foldSearch(query);
  if (q === "") return list;
  const scored: { c: Country; rank: number; i: number }[] = [];
  list.forEach((c, i) => {
    const names = [foldSearch(c.en), foldSearch(c.ar)];
    const code = c.code.toLowerCase();
    const prefix = names.some((n) => n.startsWith(q)) || code === q;
    const hit = prefix || names.some((n) => n.includes(q));
    if (hit) scored.push({ c, rank: c.code === HOME_MARKET ? 0 : prefix ? 1 : 2, i });
  });
  void locale;
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).map((s) => s.c);
}

/** Device region only pre-selects when it is EG. Never any other country, never an auto-redirect. */
export function preselectedCountry(deviceRegion: string | null | undefined): string | null {
  return deviceRegion?.toUpperCase() === HOME_MARKET ? HOME_MARKET : null;
}

export const SHOP_FOR = ["women", "men", "everyone", "none"] as const;
export type ShopFor = (typeof SHOP_FOR)[number];

export const RegionPrefSchema = z.object({
  v: z.literal(1),
  /** What the shopper said (any ISO code), kept only on this device. */
  country: z.string().regex(/^[A-Z]{2}$/),
  /** The store they browse. Always EG today. */
  market: z.literal("EG"),
  shopFor: z.enum(SHOP_FOR).nullable(),
}).strict();
export type RegionPref = z.infer<typeof RegionPrefSchema>;

export function makePref(country: string, shopFor: ShopFor | null): RegionPref {
  return { v: 1, country, market: HOME_MARKET, shopFor };
}

/** Port over the device store. */
export interface RegionPrefPort {
  load(): Promise<RegionPref | null>;
  save(p: RegionPref): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryRegionPrefPort implements RegionPrefPort {
  constructor(private current: RegionPref | null = null) {}
  async load(): Promise<RegionPref | null> { return this.current; }
  async save(p: RegionPref): Promise<void> { this.current = RegionPrefSchema.parse(p); }
  async clear(): Promise<void> { this.current = null; }
}
