// Generates src/features/welcome-region/countries.generated.json from ISO 3166-1 alpha-2 + CLDR names.
// Run: node apps/mobile/scripts/generate-countries.mjs   (needs a Node with full ICU, the default).
// Why a script: Hermes' Intl.DisplayNames is not confirmed (Hermes IntlAPIs.md), so the app ships this JSON
// and never depends on runtime ICU for names. Names are the CLDR default region names of the ICU bundled with
// the Node that ran this script (printed into the file as `cldrSource`).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ISO = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/);
if (ISO.length !== 249 || new Set(ISO).size !== 249) throw new Error(`expected 249 unique ISO codes, got ${ISO.length}`);

// XK (Kosovo) is not an ISO 3166-1 code; it is the user-assigned code CLDR and most platforms use. Kept, flagged.
const rows = [...ISO.map((code) => ({ code, userAssigned: false })), { code: "XK", userAssigned: true }];
const en = new Intl.DisplayNames(["en"], { type: "region" });
const ar = new Intl.DisplayNames(["ar"], { type: "region" });
const countries = rows.map(({ code, userAssigned }) => {
  const e = en.of(code);
  const a = ar.of(code);
  if (!e || !a || e === code || a === code) throw new Error(`no CLDR name for ${code}: ${e} / ${a}`);
  return { code, en: e, ar: a, ...(userAssigned ? { userAssigned: true } : {}) };
});
const out = join(dirname(fileURLToPath(import.meta.url)), "../src/features/welcome-region/countries.generated.json");
writeFileSync(out, JSON.stringify({ cldrSource: `node ${process.version} ICU ${process.versions.icu} CLDR ${process.versions.cldr}`, countries }, null, 1) + "\n");
console.log(`wrote ${countries.length} countries to ${out}`);
