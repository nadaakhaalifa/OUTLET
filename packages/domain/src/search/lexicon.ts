import { normalizeSearchText } from "./arabic";

export type ConceptKind = "category" | "color" | "material";

export interface Concept {
  /** Canonical English id; this is what filters and keyword remainders carry. */
  readonly id: string;
  readonly kind: ConceptKind;
  /** AR, EN and Franco-Arabic spellings (any script). */
  readonly forms: readonly string[];
}

const c = (id: string, kind: ConceptKind, forms: readonly string[]): Concept => ({ id, kind, forms });

/** Curated launch lexicon. Extend by data, not code, once the catalog taxonomy is final. */
export const CONCEPTS: readonly Concept[] = [
  c("dress", "category", ["dress", "dresses", "gown", "فستان", "فساتين", "fostan", "fustan", "fosta2in", "fasateen", "sahra", "فستان سهره"]),
  c("shirt", "category", ["shirt", "shirts", "قميص", "قمصان", "komesh", "qamis", "amees", "قميص"]),
  c("tshirt", "category", ["tshirt", "t-shirt", "tee", "تيشيرت", "تي شيرت", "tishert", "tishirt", "teshert"]),
  c("blouse", "category", ["blouse", "top", "بلوزه", "بلوزة", "بلوزات", "bluza", "blouza", "bloza"]),
  c("pants", "category", ["pants", "trousers", "بنطلون", "بناطيل", "pantalon", "bantalon", "bntalon", "bantaloon"]),
  c("jeans", "category", ["jeans", "جينز", "جينس", "jinz", "geans"]),
  c("skirt", "category", ["skirt", "skirts", "جيبه", "جيبة", "جيبات", "jiba", "gonella", "جونيله"]),
  c("jacket", "category", ["jacket", "جاكيت", "جاكت", "jaket", "jakit", "jakeet", "jacket"]),
  c("coat", "category", ["coat", "بالطو", "balto", "palto", "معطف"]),
  c("hoodie", "category", ["hoodie", "هودي", "hodi", "hoodi", "sweatshirt", "سويتشيرت"]),
  c("sweater", "category", ["sweater", "pullover", "سويتر", "بلوفر", "switer", "bulover", "pullover"]),
  c("shorts", "category", ["shorts", "short", "شورت", "shorte", "shorat"]),
  c("suit", "category", ["suit", "بدله", "بدلة", "badla", "bazla"]),
  c("abaya", "category", ["abaya", "abayah", "عبايه", "عباية", "عبايات", "3abaya"]),
  c("hijab", "category", ["hijab", "scarf", "حجاب", "طرحه", "طرحة", "esharb", "اشارب", "eshar2", "tarha"]),
  c("shoes", "category", ["shoes", "shoe", "حذاء", "جزمه", "جزمة", "جزم", "gazma", "gazam", "gezma", "ahzia", "كوتشي", "كوتشى", "kotshi", "koshi"]),
  c("sneakers", "category", ["sneakers", "sneaker", "trainers", "سنيكرز", "snikerz", "sneakerz"]),
  c("boots", "category", ["boots", "boot", "بوت", "بوتس", "bot"]),
  c("sandals", "category", ["sandals", "sandal", "صندل", "sandal", "شبشب", "shebsheb", "chabchab"]),
  c("bag", "category", ["bag", "bags", "handbag", "شنطه", "شنطة", "شنط", "shanta", "shanta", "shonta"]),
  c("watch", "category", ["watch", "watches", "ساعه", "ساعة", "ساعات", "sa3a", "saa3a"]),
  c("white", "color", ["white", "ابيض", "أبيض", "بيضا", "بيضاء", "abyad", "abyadh", "abiad", "abyed", "ابيض"]),
  c("black", "color", ["black", "اسود", "أسود", "سوداء", "aswad", "eswed", "aswed", "esoud", "swad"]),
  c("red", "color", ["red", "احمر", "أحمر", "حمراء", "ahmar", "a7mar", "ahmer"]),
  c("blue", "color", ["blue", "ازرق", "أزرق", "زرقاء", "azra2", "azraq", "azrak", "azra'"]),
  c("navy", "color", ["navy", "كحلي", "كحلى", "ka7ly", "kohly", "kuhli"]),
  c("green", "color", ["green", "اخضر", "أخضر", "خضراء", "akhdar", "a5dar", "akhdr", "okhdar"]),
  c("yellow", "color", ["yellow", "اصفر", "أصفر", "صفراء", "asfar", "asfer"]),
  c("pink", "color", ["pink", "بينك", "وردي", "وردى", "pink", "wardi", "bamby", "rosy"]),
  c("beige", "color", ["beige", "بيج", "beij", "bayge", "beich"]),
  c("brown", "color", ["brown", "بني", "بنى", "bunny", "bonny", "benny", "bonni"]),
  c("grey", "color", ["grey", "gray", "رمادي", "رمادى", "ramadi", "rumady", "ramady"]),
  c("purple", "color", ["purple", "بنفسجي", "بنفسجى", "banafsegy", "banafsagi", "mov", "موف"]),
  c("orange", "color", ["orange", "برتقالي", "برتقالى", "borto2ali", "portoqali", "bortokaly"]),
  c("linen", "material", ["linen", "لينين", "كتان", "linin", "kettan", "keten", "lenin"]),
  c("cotton", "material", ["cotton", "قطن", "كوتون", "koton", "ootn", "qutn", "cotton"]),
  c("wool", "material", ["wool", "صوف", "souf", "sof", "woll"]),
  c("leather", "material", ["leather", "جلد", "جلود", "geld", "gild", "leder"]),
  c("silk", "material", ["silk", "حرير", "7areer", "hareer", "harir"]),
  c("denim", "material", ["denim", "دنيم", "denem", "daneem"]),
  c("satin", "material", ["satin", "ساتان", "ساتين", "satan", "satin", "saten"]),
];

const LATIN = /^[a-z0-9'-]+$/u;

/**
 * Folds a Latin spelling so common Franco variants collide: o/u, e/i, y/i, then collapse repeats,
 * drop apostrophes and hyphens. Applied to lexicon forms and query tokens alike, so it only
 * has to be consistent, not linguistically correct.
 */
export function foldLatin(token: string): string {
  return token
    .toLowerCase()
    .replace(/['-]/gu, "")
    .replace(/[ou]/gu, "u")
    .replace(/[ei]/gu, "i")
    .replace(/y/gu, "i")
    .replace(/(.)\1+/gu, "$1");
}

/** Lookup key for any token: Latin tokens are folded, everything else is Arabic-normalized. */
export function lexiconKey(token: string): string {
  const n = normalizeSearchText(token);
  return LATIN.test(n) ? foldLatin(n) : n;
}

const INDEX: ReadonlyMap<string, Concept> = (() => {
  const m = new Map<string, Concept>();
  for (const concept of CONCEPTS) {
    for (const form of concept.forms) {
      const key = lexiconKey(form);
      // First declaration wins so a shared spelling resolves deterministically.
      if (key.length > 0 && !m.has(key)) m.set(key, concept);
    }
  }
  return m;
})();

const AL_PREFIX = /^ال(?=\p{L}{3,})/u;

/** Resolves one token (any script) to a concept, trying the definite-article-stripped form too. */
export function lookupConcept(token: string): Concept | null {
  const key = lexiconKey(token);
  const hit = INDEX.get(key);
  if (hit !== undefined) return hit;
  const stripped = key.replace(AL_PREFIX, "");
  return stripped !== key ? (INDEX.get(stripped) ?? null) : null;
}

/** The concept for a canonical id, or null. */
export function conceptById(id: string): Concept | null {
  return CONCEPTS.find((x) => x.id === id) ?? null;
}

/**
 * Index-side expansion: every normalized form (AR, EN, Franco) of a canonical id, for OR matching
 * against Arabic and English titles. Unknown ids expand to themselves.
 */
export function expandTerm(canonical: string): string[] {
  const concept = conceptById(canonical);
  if (concept === null) return [normalizeSearchText(canonical)].filter((s) => s.length > 0);
  const out = new Set<string>();
  for (const f of concept.forms) {
    const n = normalizeSearchText(f);
    if (n.length > 0 && !n.includes(" ")) out.add(n);
  }
  out.add(concept.id);
  return [...out];
}

/** All normalized vocabulary forms, used by did-you-mean. */
export function vocabulary(): string[] {
  const out = new Set<string>();
  for (const concept of CONCEPTS) for (const f of concept.forms) out.add(normalizeSearchText(f));
  return [...out].filter((s) => s.length > 0 && !s.includes(" "));
}
