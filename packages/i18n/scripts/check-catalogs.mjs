// Fails when ar-EG and en-EG diverge. Run: node scripts/check-catalogs.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";

/** Strip ICU selector tokens like `=0` and `{name}` bodies' syntax so only literal text is left to scan. */
function literalText(message) {
  return message.replace(/=\d+/g, "").replace(/\{[^{}]*,\s*(?:plural|select|selectordinal)\s*,/g, "{");
}

function argNames(message) {
  const names = new Set();
  for (const m of message.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)) {
    const name = m[1];
    if (!["plural", "select", "selectordinal", "number", "date", "time", "one", "two", "few", "many", "other", "zero"].includes(name)) names.add(name);
  }
  return names;
}

/** @returns {string[]} human-readable problems; empty means the catalogs agree. */
export function checkCatalogs(ar, en) {
  const problems = [];
  for (const k of Object.keys(en)) if (!(k in ar)) problems.push(`missing in ar-EG: ${k}`);
  for (const k of Object.keys(ar)) if (!(k in en)) problems.push(`missing in en-EG: ${k}`);
  for (const [name, cat] of [["ar-EG", ar], ["en-EG", en]]) {
    for (const [k, v] of Object.entries(cat)) {
      if (typeof v !== "string" || v.trim() === "") {
        problems.push(`${name}.${k}: empty value`);
        continue;
      }
      if (/[0-9٠-٩۰-۹]/.test(literalText(v))) problems.push(`${name}.${k}: hard-coded digit, use a placeholder`);
      try {
        new IntlMessageFormat(v, name);
      } catch (e) {
        problems.push(`${name}.${k}: invalid ICU message (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  for (const k of Object.keys(ar)) {
    if (typeof ar[k] !== "string" || typeof en[k] !== "string") continue;
    const a = [...argNames(ar[k])].sort().join(",");
    const e = [...argNames(en[k])].sort().join(",");
    if (a !== e) problems.push(`${k}: placeholders differ (ar: ${a || "none"}; en: ${e || "none"})`);
  }
  return problems;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const load = (n) => JSON.parse(readFileSync(join(here, "..", "src", "catalogs", `${n}.json`), "utf8"));
  const problems = checkCatalogs(load("ar-EG"), load("en-EG"));
  for (const p of problems) console.error(p);
  console.log(problems.length ? `check-catalogs: ${problems.length} problem(s)` : "check-catalogs: ok");
  process.exit(problems.length ? 1 : 0);
}
