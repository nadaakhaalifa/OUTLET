// Rejects theme text (taglines, editorial text) that makes price, discount, percent, scarcity,
// countdown, verified or rating claims (ADR-0057 decision 2 rule 3; CPL 181/2018; master A2.13).
// AR and EN; Western, Eastern Arabic-Indic and Persian digits.

export type CopyViolationKind = "percent" | "discount" | "price" | "countdown" | "scarcity" | "claim";

export interface CopyViolation {
  readonly kind: CopyViolationKind;
}

const DIGIT_MAP: Readonly<Record<string, string>> = {};
const digitMap = DIGIT_MAP as Record<string, string>;
for (let i = 0; i < 10; i += 1) {
  digitMap[String.fromCharCode(0x0660 + i)] = String(i);
  digitMap[String.fromCharCode(0x06f0 + i)] = String(i);
}

/** Lowercase, Western digits, no Arabic diacritics or tatweel, unified alef/ya/ta-marbuta. */
export function normaliseCopy(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[٠-٩۰-۹]/g, (d) => digitMap[d] ?? d)
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/٪/g, "%")
    .toLowerCase();
}

const NUM = "\\d+(?:[.,\\u066b]\\d+)?";
const RULES: readonly { kind: CopyViolationKind; re: RegExp }[] = [
  { kind: "percent", re: /%|\bpercent\b|\bpct\b|بالمايه|في المايه|بالمئه|\bنسبه\b/ },
  {
    kind: "discount",
    re: /\b(?:discount\w*|sale|clearance|markdown|off|deal|deals|bargain|save|saving|savings|cheap\w*|coupon|promo\w*|voucher)\b|خصم|تخفيض|تخفيضات|اوكازيون|عرض|عروض|وفر|توفير|ارخص|رخيص|كوبون|بدل من|سعر خاص/,
  },
  {
    kind: "price",
    re: new RegExp(
      `(?:${NUM}\\s*(?:egp|le|l\\.e|ج\\.?م|جنيه|جنيها|pounds?|\\$|usd|sar|aed)(?![a-z]))|(?:\\b(?:egp|le|usd|\\$)\\s*${NUM})|(?:ج\\.?م\\.?\\s*${NUM})|\\bprice\\w*|\\bcost\\w*|\\bfrom\\s+${NUM}|سعر|اسعار|ابتداء من|يبدا من|تبدا من|بس ب|\\bب\\s*${NUM}|\\bonly\\s+${NUM}`,
    ),
  },
  {
    kind: "countdown",
    re: new RegExp(
      `countdown|\\bends?\\b|\\bending\\b|expires?|hurry|last chance|limited time|today only|flash|\\bhours? left\\b|\\bdays? left\\b|${NUM}\\s*(?:hours?|hrs?|mins?|minutes?|days?|ساعه|ساعات|دقيقه|دقايق|يوم|ايام)|ينتهي|ينتهى|تنتهي|متبقي|باقي|اسرع|لفتره محدوده|لمده محدوده|اليوم فقط|اخر فرصه|عد تنازلي|فلاش`,
    ),
  },
  {
    kind: "scarcity",
    re: /\b(?:only|just)\s+\d+\s+left\b|\bleft in stock\b|\bsold out\b|\blow stock\b|\bselling fast\b|\blimited (?:stock|quantity|edition)\b|اخر قطعه|اخر \d+|كميه محدوده|كميات محدوده|نفدت|نفذت|اوشك/,
  },
  {
    kind: "claim",
    re: /\bverified\b|\bratings?\b|\brated\b|\bstars?\b|★|☆|\breviews?\b|\bbest[- ]?sell\w*|\b#1\b|\bno\.? ?1\b|موثق|موثوق|تقييم|تقييمات|نجوم|نجمه|الاكثر مبيعا|الاعلي مبيعا|رقم 1|رقم واحد|\d+\s*\+?\s*(?:buyers|customers|sold|عميل|مشتري|مبيعات)/,
  },
];

/** Distinct violation kinds found in the text (empty = clean). */
export function findCopyViolations(text: string): CopyViolation[] {
  const n = normaliseCopy(text);
  const out: CopyViolation[] = [];
  for (const rule of RULES) if (rule.re.test(n)) out.push({ kind: rule.kind });
  return out;
}

export function isCleanCopy(text: string): boolean {
  return findCopyViolations(text).length === 0;
}
