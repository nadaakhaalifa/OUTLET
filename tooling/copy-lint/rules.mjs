// Copy-lint text rules (A2 rule 13, CPL 181/2018). Pure: text in, rule hits out.
// Every rule is language-tagged for reporting only; all rules run on all text.

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Normalise for matching: ASCII digits, no tashkeel/tatweel, folded alef and ya. */
export function normalize(text) {
  return text
    .replace(/[٠-٩]/g, (c) => String(AR_DIGITS.indexOf(c)))
    .replace(/[۰-۹]/g, (c) => String(FA_DIGITS.indexOf(c)))
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\u00a0/g, " ");
}

const N = "\\d+(?:[.,]\\d+)?";

/** @type {{id:string, lang:'en'|'ar', category:string, re:RegExp, message:string}[]} */
export const TEXT_RULES = [
  { id: "social-proof-viewing", lang: "en", category: "social-proof", re: new RegExp(`\\b${N}\\s+(?:\\w+\\s+)?(?:people|persons|shoppers|customers|users|others|buyers|members)\\s+(?:are\\s+|is\\s+)?(?:currently\\s+)?(?:viewing|watching|looking|browsing|have\\s+this)`, "i"), message: "Hard-coded 'N people viewing' social proof" },
  { id: "social-proof-viewing", lang: "en", category: "social-proof", re: new RegExp(`\\b${N}\\s+(?:viewing|watching|viewers)\\b`, "i"), message: "Hard-coded 'N viewing' social proof" },
  { id: "social-proof-viewing", lang: "ar", category: "social-proof", re: new RegExp(`${N}[^\\d]{0,25}(?:يشاهد|يتصفح|يشاهدون|يتصفحون|يتابع|مشاهد)|(?:يشاهد|يتصفح|يشاهدون|يتصفحون)[^\\d]{0,25}${N}`), message: "Hard-coded 'N viewing now' social proof (AR)" },
  { id: "social-proof-bought", lang: "en", category: "social-proof", re: new RegExp(`\\b${N}\\+?\\s+(?:\\w+\\s+)?(?:bought|sold|purchased|ordered|orders)\\b[^.]{0,30}\\b(?:today|this\\s+(?:week|hour|month)|in\\s+the\\s+(?:last|past)|recently|just\\s+now)`, "i"), message: "Hard-coded 'N bought today' social proof" },
  { id: "social-proof-bought", lang: "en", category: "social-proof", re: new RegExp(`\\b(?:bought|sold|purchased)\\s+(?:by\\s+)?${N}\\b`, "i"), message: "Hard-coded 'sold N' social proof" },
  { id: "social-proof-bought", lang: "ar", category: "social-proof", re: new RegExp(`${N}[^\\d]{0,25}(?:اشتر|بيع|تم\\s+بيع|طلب|مشتري)[^\\d]{0,25}(?:اليوم|الساعه|ساعه|الاسبوع|مؤخرا|منذ)|(?:تم\\s+بيع|اشتري|اشتروا|بيعت|طلب)[^\\d]{0,25}${N}[^\\d]{0,25}(?:اليوم|ساعه|الاسبوع|مؤخرا)`), message: "Hard-coded 'N bought today' social proof (AR)" },
  { id: "fake-scarcity", lang: "en", category: "scarcity", re: new RegExp(`\\bonly\\s+${N}\\s+(?:\\w+\\s+)?(?:left|remaining|available|in\\s+stock)\\b|\\b${N}\\s+(?:items?\\s+|pieces?\\s+|units?\\s+)?(?:left|remaining)\\s+in\\s+(?:stock|size|\\w)|\\blast\\s+${N}\\s+(?:items?|pieces?|units?)\\b`, "i"), message: "Hard-coded scarcity count; must be server-derived stock" },
  { id: "fake-scarcity", lang: "ar", category: "scarcity", re: new RegExp(`(?:متبقي|متبقيه|متبقيين|باقي|بقي|فقط|اخر)\\s*${N}\\s*(?:قطع|قطعه|قطعة|حبه|حبات|وحده|وحدات|مقاس|متبقي|فقط)|${N}\\s*(?:قطع|قطعه)\\s*(?:متبقيه|متبقي|فقط|باقيه)`), message: "Hard-coded scarcity count (AR); must be server-derived stock" },
  { id: "fake-urgency", lang: "en", category: "urgency", re: /\b(?:selling\s+fast|sells?\s+out\s+(?:fast|quickly|soon)|going\s+fast|almost\s+gone|hurry(?:\s+up)?|don'?t\s+miss\s+out|act\s+now|last\s+chance\s+to\s+buy|while\s+(?:stocks?|supplies)\s+last|flying\s+off\s+(?:the\s+)?shelves|everyone\s+is\s+buying|trending\s+now\s+and\s+selling)\b/i, message: "Unsubstantiated urgency phrase" },
  { id: "fake-urgency", lang: "ar", category: "urgency", re: /(?:يباع\s+بسرعه|بيتباع\s+بسرعه|ينفد\s+بسرعه|تنفد\s+بسرعه|سارع|الحق\s+(?:نفسك|العرض)|لا\s+تفوت|ما\s+تفوتش|الكميه\s+محدوده\s+جدا|اوشك\s+علي\s+النفاد|على\s+وشك\s+النفاد)/, message: "Unsubstantiated urgency phrase (AR)" },
  { id: "fake-countdown", lang: "en", category: "urgency", re: new RegExp(`\\b\\d{1,2}:\\d{2}:\\d{2}\\b(?!\\s*(?:GMT|UTC))|\\b(?:ends?|offer\\s+ends?|expires?|sale\\s+ends?)\\s+in\\s+${N}\\s*(?:h|hrs?|hours?|m|mins?|minutes?|seconds?|s)\\b|\\b${N}\\s*(?:hours?|hrs?|minutes?|mins?)\\s+left\\b`, "i"), message: "Hard-coded countdown; timers must come from a server timestamp" },
  { id: "fake-countdown", lang: "ar", category: "urgency", re: new RegExp(`(?:ينتهي|ينتهى|ينتهي\\s+العرض|ينتهي\\s+خلال|يخلص)\\s*(?:خلال|بعد|في)?\\s*${N}\\s*(?:ساعه|ساعات|دقيقه|دقائق|ثانيه|يوم|ايام)|(?:باقي|متبقي)\\s*${N}\\s*(?:ساعه|ساعات|دقيقه|دقائق|ثانيه)`), message: "Hard-coded countdown (AR); timers must come from a server timestamp" },
  { id: "fake-discount", lang: "en", category: "discount", re: new RegExp(`\\b(?:up\\s+to\\s+|save\\s+(?:up\\s+to\\s+)?|extra\\s+|flat\\s+)?${N}\\s?%\\s*(?:off|discount|savings?|cheaper)\\b|\\bsave\\s+${N}\\s?%`, "i"), message: "Hard-coded '% off' claim; discount claims come only from the verified price (spec 9)" },
  { id: "fake-discount", lang: "ar", category: "discount", re: new RegExp(`(?:خصم|تخفيض|وفر|وفّر|وفري)\\s*(?:يصل\\s+الي|حتي|ما\\s+يصل\\s+الي|يصل\\s+الى|بنسبه|بنسبة)?\\s*${N}\\s*(?:%|٪|بالمائه|في\\s+المائه)|${N}\\s*(?:%|٪)\\s*(?:خصم|تخفيض|off)`), message: "Hard-coded '% off' claim (AR); discount claims come only from the verified price" },
  { id: "confirm-shaming", lang: "en", category: "dark-pattern", re: /\bno,?\s+thanks?,?\s+i\s+(?:hate|don'?t\s+(?:want|like|need|care)|do\s+not\s+(?:want|like)|prefer|love\s+paying|enjoy\s+paying)|\bi\s+(?:hate|don'?t\s+(?:like|want))\s+(?:saving|savings|deals|money|discounts?)|\bno,?\s+i'?d?\s+(?:rather|prefer|like\s+to)\s+(?:pay|miss|stay|lose|skip)|\bi'?ll\s+(?:pay|stay)\s+(?:full\s+price|broke)|\bi\s+don'?t\s+want\s+to\s+(?:save|be\s+(?:stylish|smart))|\bno,?\s+i\s+(?:like|enjoy)\s+(?:overpaying|paying\s+more)/i, message: "Confirm-shaming copy on a decline option" },
  { id: "confirm-shaming", lang: "ar", category: "dark-pattern", re: /(?:لا\s+شكرا|لا\s+،?\s*شكرا|لا)[\s،,.-]+(?:انا\s+|أنا\s+)?(?:اكره|بكره|لا\s+احب|ما\s+احب|مش\s+عايز|لا\s+اريد|مش\s+بحب)\s*(?:التوفير|الخصم|الخصومات|العروض|التوفير|اوفر|أوفر|اوفّر)|انا\s+(?:افضل|بفضل)\s+دفع\s+(?:السعر\s+كاملا|اكتر|اكثر)|مش\s+عايز\s+اوفر|لا\s+اهتم\s+بالتوفير/, message: "Confirm-shaming copy on a decline option (AR)" },
];

const CONSENT_RE = /consent|marketing|analytics|tracking|personali[sz]|newsletter|cross_?border|measurements?|budget_?insights|opt_?in|whatsapp|promo(?:tional)?/i;
export { CONSENT_RE };

// Fold the rule sources the same way as input text so patterns need not repeat variants.
for (const r of TEXT_RULES) {
  r.re = new RegExp(r.re.source.replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه"), r.re.flags);
}

export function matchText(rawText) {
  const text = normalize(rawText);
  const out = [];
  for (const r of TEXT_RULES) {
    const m = r.re.exec(text);
    if (m) out.push({ rule: r.id, lang: r.lang, category: r.category, message: r.message, match: m[0].trim() });
  }
  return out;
}
