import { normalizeArabic } from "./normalize.js";

export interface Budget {
  /** Upper bound in piastres (integer minor units). */
  readonly maxMinor: bigint;
  readonly matched: string;
  /** Query text with the budget phrase removed. */
  readonly rest: string;
}

const WB_START = "(?<![\\p{L}\\p{N}])";
const WB_END = "(?![\\p{L}\\p{N}])";
const PREFIX = [
  "under", "below", "less than", "less", "max", "maximum", "up to", "upto", "within", "budget", "not more than",
  "تحت", "اقل من", "اقل", "لحد", "حتي", "اقصي", "في حدود", "ميزانيتي", "بحد اقصي", "لا يزيد عن",
  "ta7t", "ta7et", "a2al men", "a2al", "le7ad", "la7ad", "7ata",
]
  .map((p) => p.replace(/ /g, "\\s+"))
  .sort((a, b) => b.length - a.length)
  .join("|");
const NUM = "(\\d+(?:[.,]\\d+)*)\\s*(k|الف|الاف)?";
const CUR = "(?:\\s*(?:egp|e\\.?g\\.?p|l\\.?e|pounds?|جنيه|ج\\.م|جم|gneh|geneh))?";
const SUFFIX = "(?:max|maximum|or\\s+less|او\\s+اقل|حد\\s+اقصي)";
const BEFORE = new RegExp(`${WB_START}(?:${PREFIX})\\s*${NUM}${CUR}${WB_END}`, "u");
const AFTER = new RegExp(`${WB_START}${NUM}${CUR}\\s*${SUFFIX}${WB_END}`, "u");

/** "1,500" -> 1500; "1.5" stays decimal. A comma followed by exactly 3 digits is a thousands separator. */
const toMinor = (digits: string, mult: bigint): bigint | undefined => {
  const cleaned = digits.replace(/,(?=\d{3}(?!\d))/g, "").replace(/,/g, ".");
  const [intPart = "0", fracPart = ""] = cleaned.split(".");
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) return undefined;
  const cents = BigInt(intPart) * 100n + BigInt(fracPart.padEnd(2, "0").slice(0, 2));
  const value = cents * mult;
  return value > 0n ? value : undefined;
};

/** Bigint to number for engine filters (fixture-scale values only). */
export const bigintToNumber = (v: bigint): number => Number(v);

/** Extracts an upper price bound from AR/EN/Franco phrases, Eastern digits included. */
export const parseBudget = (text: string): Budget | null => {
  const s = normalizeArabic(text);
  const m = BEFORE.exec(s) ?? AFTER.exec(s);
  if (m === null) return null;
  const mult = m[2] === undefined ? 1n : 1000n;
  const maxMinor = toMinor(m[1] ?? "", mult);
  if (maxMinor === undefined) return null;
  const rest = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
  return { maxMinor, matched: m[0], rest };
};
