import { COUNTRIES, HOME_MARKET, isServed } from "./model";

/**
 * Default region on the first-launch screen (owner rule): App Store storefront (alpha-3), then the device locale
 * region (alpha-2), then Egypt. It only preselects a row; the shopper can always pick another. Nothing here asks for
 * location, reads a GPS, or sends anything anywhere.
 */

/** ISO 3166-1 alpha-3 to alpha-2, as the App Store storefront reports it (for example "EGY"). Plus XKX for Kosovo. */
const PAIRS =
  "AFG:AF ALA:AX ALB:AL DZA:DZ ASM:AS AND:AD AGO:AO AIA:AI ATA:AQ ATG:AG ARG:AR ARM:AM ABW:AW AUS:AU AUT:AT AZE:AZ " +
  "BHS:BS BHR:BH BGD:BD BRB:BB BLR:BY BEL:BE BLZ:BZ BEN:BJ BMU:BM BTN:BT BOL:BO BES:BQ BIH:BA BWA:BW BVT:BV BRA:BR " +
  "IOT:IO BRN:BN BGR:BG BFA:BF BDI:BI CPV:CV KHM:KH CMR:CM CAN:CA CYM:KY CAF:CF TCD:TD CHL:CL CHN:CN CXR:CX CCK:CC " +
  "COL:CO COM:KM COG:CG COD:CD COK:CK CRI:CR CIV:CI HRV:HR CUB:CU CUW:CW CYP:CY CZE:CZ DNK:DK DJI:DJ DMA:DM DOM:DO " +
  "ECU:EC EGY:EG SLV:SV GNQ:GQ ERI:ER EST:EE SWZ:SZ ETH:ET FLK:FK FRO:FO FJI:FJ FIN:FI FRA:FR GUF:GF PYF:PF ATF:TF " +
  "GAB:GA GMB:GM GEO:GE DEU:DE GHA:GH GIB:GI GRC:GR GRL:GL GRD:GD GLP:GP GUM:GU GTM:GT GGY:GG GIN:GN GNB:GW GUY:GY " +
  "HTI:HT HMD:HM VAT:VA HND:HN HKG:HK HUN:HU ISL:IS IND:IN IDN:ID IRN:IR IRQ:IQ IRL:IE IMN:IM ISR:IL ITA:IT JAM:JM " +
  "JPN:JP JEY:JE JOR:JO KAZ:KZ KEN:KE KIR:KI PRK:KP KOR:KR KWT:KW KGZ:KG LAO:LA LVA:LV LBN:LB LSO:LS LBR:LR LBY:LY " +
  "LIE:LI LTU:LT LUX:LU MAC:MO MDG:MG MWI:MW MYS:MY MDV:MV MLI:ML MLT:MT MHL:MH MTQ:MQ MRT:MR MUS:MU MYT:YT MEX:MX " +
  "FSM:FM MDA:MD MCO:MC MNG:MN MNE:ME MSR:MS MAR:MA MOZ:MZ MMR:MM NAM:NA NRU:NR NPL:NP NLD:NL NCL:NC NZL:NZ NIC:NI " +
  "NER:NE NGA:NG NIU:NU NFK:NF MKD:MK MNP:MP NOR:NO OMN:OM PAK:PK PLW:PW PSE:PS PAN:PA PNG:PG PRY:PY PER:PE PHL:PH " +
  "PCN:PN POL:PL PRT:PT PRI:PR QAT:QA REU:RE ROU:RO RUS:RU RWA:RW BLM:BL SHN:SH KNA:KN LCA:LC MAF:MF SPM:PM VCT:VC " +
  "WSM:WS SMR:SM STP:ST SAU:SA SEN:SN SRB:RS SYC:SC SLE:SL SGP:SG SXM:SX SVK:SK SVN:SI SLB:SB SOM:SO ZAF:ZA SGS:GS " +
  "SSD:SS ESP:ES LKA:LK SDN:SD SUR:SR SJM:SJ SWE:SE CHE:CH SYR:SY TWN:TW TJK:TJ TZA:TZ THA:TH TLS:TL TGO:TG TKL:TK " +
  "TON:TO TTO:TT TUN:TN TUR:TR TKM:TM TCA:TC TUV:TV UGA:UG UKR:UA ARE:AE GBR:GB USA:US UMI:UM URY:UY UZB:UZ VUT:VU " +
  "VEN:VE VNM:VN VGB:VG VIR:VI WLF:WF ESH:EH YEM:YE ZMB:ZM ZWE:ZW XKX:XK";

export const ALPHA3_TO_ALPHA2: Readonly<Record<string, string>> = Object.fromEntries(PAIRS.split(" ").map((p) => p.split(":") as [string, string]));

/** Storefront alpha-3 to alpha-2. Null for anything unknown (the App Store value is reported unreliable on TestFlight). */
export function storefrontToRegion(alpha3: string | null | undefined): string | null {
  if (alpha3 === null || alpha3 === undefined) return null;
  return ALPHA3_TO_ALPHA2[alpha3.trim().toUpperCase()] ?? null;
}

const KNOWN = new Set(COUNTRIES.map((c) => c.code));
const asKnown = (code: string | null | undefined): string | null => {
  const c = code?.trim().toUpperCase();
  return c !== undefined && KNOWN.has(c) ? c : null;
};

export type DefaultSource = "storefront" | "locale" | "fallback";
export interface DefaultRegion { readonly code: string; readonly source: DefaultSource }

/** Order: storefront, then locale region, then Egypt. A value that is not a known country is skipped. */
export function defaultRegion(storefrontAlpha3: string | null | undefined, localeRegion: string | null | undefined): DefaultRegion {
  const s = asKnown(storefrontToRegion(storefrontAlpha3));
  if (s !== null) return { code: s, source: "storefront" };
  const l = asKnown(localeRegion);
  if (l !== null) return { code: l, source: "locale" };
  return { code: HOME_MARKET, source: "fallback" };
}

/** Reads the App Store storefront country (alpha-3). Local only. */
export interface StorefrontReader { countryCode(): Promise<string | null> }

/**
 * No native StoreKit reader is bundled yet (Expo Go has none), so the storefront step yields nothing and the order
 * falls through to the locale region, then Egypt. A dev-client adapter can replace this behind the same port.
 */
export const unconfiguredStorefront: StorefrontReader = { countryCode: async () => null };

/** Never throws: a failing reader counts as no storefront. */
export async function readStorefront(reader: StorefrontReader): Promise<string | null> {
  try { return await reader.countryCode(); } catch { return null; }
}

/**
 * First launch only: the region is written when none exists yet, or in edit mode. A second pass through the first-launch
 * screen (a stale deep link) never overwrites a saved choice and never shows the screen again.
 */
export function mayWriteRegion(input: { readonly edit: boolean; readonly existing: boolean }): boolean {
  return input.edit || !input.existing;
}

/** The language a region usually reads (separate setting; only ever a suggestion). */
const REGION_LANGUAGE: Readonly<Record<string, "ar" | "en">> = { EG: "ar" };

/** Edit mode only, only when the shopper never chose a language, only when it differs from the current one. */
export function suggestLanguage(input: { readonly edit: boolean; readonly languageChosen: boolean; readonly region: string; readonly current: string }): "ar" | "en" | null {
  if (!input.edit || input.languageChosen || !isServed(input.region)) return null;
  const wanted = REGION_LANGUAGE[input.region];
  if (wanted === undefined) return null;
  return input.current.startsWith(wanted) ? null : wanted;
}
