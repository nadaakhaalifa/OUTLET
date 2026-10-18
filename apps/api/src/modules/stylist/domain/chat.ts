/**
 * Stylist chat, pure domain (spec P3-07, docs/specs/phase-3/stylist-chat.md).
 *
 * Design rule (LLM05, LLM09): the model only classifies a turn into an enum-typed intent plus slots.
 * It never writes a reply, a price, a stock count, a size or a product id. Replies are rendered from
 * the fixed catalogue below and cards come from catalogue rows by id. The rule-based parser in this
 * file produces the same `ParsedIntent` and is both the fallback (LLM down, kill switch, breaker,
 * budget) and the oracle of the golden evaluation set.
 */
import { z } from "zod";
import { SLOTS, type Season, type Slot } from "./bridge";
import type { World } from "./ports";

export const CHAT_OCCASIONS = ["work", "wedding_guest", "date", "eid", "beach", "gym", "university", "casual"] as const;
export type ChatOccasion = (typeof CHAT_OCCASIONS)[number];
export const CHAT_SEASONS = ["summer", "winter", "spring", "autumn", "all"] as const;
export const CHAT_VIBES = ["classic", "trendy", "minimal", "sporty", "festive"] as const;
export type ChatVibe = (typeof CHAT_VIBES)[number];
export const CHAT_PALETTES = ["neutral", "bright", "dark", "pastel"] as const;
export type ChatPalette = (typeof CHAT_PALETTES)[number];
export const CHAT_WORLDS = ["local", "global", "everything", "my_stores"] as const;
export const REFUSAL_REASONS = ["non_fashion", "unsafe", "financial_advice", "external_site", "medical_legal", "abusive", "injection"] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
export const CLARIFY_TOPICS = ["palette", "occasion", "budget"] as const;
export type ClarifyTopic = (typeof CLARIFY_TOPICS)[number];
export type ChatLang = "ar" | "en";
export type ChatIntentKind = "outfit" | "cheaper" | "more_modest" | "change_scope" | "swap_item" | "clarify" | "refuse";

export const MAX_BUDGET_EGP = 1_000_000;
export const MAX_REJECTED = 50;

/** What a turn asks for, from the LLM or from the rules parser. camelCase mirror of the prompt schema. */
export interface ParsedIntent {
  readonly intent: ChatIntentKind;
  readonly occasion?: ChatOccasion;
  readonly season?: Season;
  readonly modest?: boolean;
  readonly formality?: number;
  readonly vibe?: ChatVibe;
  readonly budgetEgp?: number;
  readonly world?: World;
  readonly slot?: Slot;
  readonly clarify?: ClarifyTopic;
  readonly refuse?: RefusalReason;
  readonly language: ChatLang;
}

// ---- session state -----------------------------------------------------------------------------

/** Structured memory (spec: occasion, vibe, scope, budget, rejected items). Never holds free text. */
export const ChatStateSchema = z
  .object({
    occasion: z.enum(CHAT_OCCASIONS).nullable(),
    vibe: z.enum(CHAT_VIBES).nullable(),
    palette: z.enum(CHAT_PALETTES).nullable(),
    season: z.enum(CHAT_SEASONS),
    modest: z.boolean(),
    formality: z.number().int().min(0).max(4).nullable(),
    world: z.enum(CHAT_WORLDS),
    storeIds: z.array(z.uuid()).max(30),
    /** Budget the shopper typed, integer piastres as a string. A budget-suite value is never stored. */
    budgetPiastres: z.string().regex(/^\d{1,18}$/).nullable(),
    rejectedItemIds: z.array(z.uuid()).max(MAX_REJECTED),
    lastOutfitIds: z.array(z.uuid()).max(5),
    lastTotalPiastres: z.string().regex(/^\d{1,18}$/).nullable(),
    clarificationsAsked: z.number().int().min(0).max(5),
    language: z.enum(["ar", "en"]),
  })
  .strict();
export type ChatState = z.infer<typeof ChatStateSchema>;

export const initialChatState = (language: ChatLang, world: World = "everything", storeIds: readonly string[] = []): ChatState => ({
  occasion: null,
  vibe: null,
  palette: null,
  season: "all",
  modest: false,
  formality: null,
  world,
  storeIds: [...storeIds],
  budgetPiastres: null,
  rejectedItemIds: [],
  lastOutfitIds: [],
  lastTotalPiastres: null,
  clarificationsAsked: 0,
  language,
});

/** Budget band for prompts and events: never the exact amount (LLM02). Same cut points as the stylist events. */
export function chatBudgetBand(piastres: string | null): string {
  if (piastres === null) return "none";
  const egp = BigInt(piastres) / 100n;
  if (egp < 1000n) return "lt_1000";
  if (egp < 3000n) return "1000_2999";
  if (egp < 5000n) return "3000_4999";
  if (egp < 10000n) return "5000_9999";
  return "gte_10000";
}

// ---- text normalisation --------------------------------------------------------------------------

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Lower-cases, folds alef/ya/ta-marbuta, strips diacritics and tatweel, maps Eastern Arabic digits. */
export function normalizeText(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFKC")) {
    const a = ARABIC_INDIC.indexOf(ch);
    const e = EXT_INDIC.indexOf(ch);
    out += a >= 0 ? String(a) : e >= 0 ? String(e) : ch;
  }
  return out
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[،؛؟]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ARABIC_LETTERS = /[؀-ۿ]/g;
const LATIN_LETTERS = /[a-z]/g;

// ---- rules parser --------------------------------------------------------------------------------

const AR_PREFIXES = ["و", "ب", "ل", "ف", "ك"];
const AR_SUFFIXES = ["ها", "نا", "ي", "ك", "ه"];

/** Token forms of one Arabic word: itself, without a clitic prefix, without al-, without a pronoun suffix. */
function arabicForms(tok: string): Set<string> {
  const forms = new Set<string>([tok]);
  const stripAl = (w: string): string => (w.startsWith("ال") && w.length > 3 ? w.slice(2) : w);
  for (const base of [...forms]) forms.add(stripAl(base));
  // "للشغل" is li- + al- with the alif elided: ل + ال + شغل.
  for (const base of [...forms]) if (base.startsWith("لل") && base.length > 4) forms.add(base.slice(2));
  for (const base of [...forms]) {
    for (const p of AR_PREFIXES) if (base.startsWith(p) && base.length > 3) {
      forms.add(base.slice(1));
      forms.add(stripAl(base.slice(1)));
    }
  }
  for (const base of [...forms]) {
    for (const s of AR_SUFFIXES) if (base.endsWith(s) && base.length > s.length + 2) forms.add(base.slice(0, -s.length));
  }
  return forms;
}

/**
 * True when any listed word occurs in the normalised text: Latin words on word boundaries, single
 * Arabic words as tokens (so "عشان" does not match "عشا"), multi-word phrases as substrings.
 */
const has = (t: string, words: readonly string[]): boolean => {
  let forms: Set<string> | null = null;
  return words.some((w) => {
    if (/^[a-z0-9 ']+$/.test(w)) return new RegExp(`(^|[^a-z0-9])${w}($|[^a-z0-9])`).test(t);
    if (!w.includes(" ") && /[\u0600-\u06FF]/.test(w)) {
      if (forms === null) {
        forms = new Set<string>();
        for (const tok of t.split(" ")) for (const f of arabicForms(tok)) forms.add(f);
      }
      return forms.has(w);
    }
    return t.includes(w);
  });
};

const OCCASION_WORDS: readonly (readonly [ChatOccasion, readonly string[]])[] = [
  ["wedding_guest", ["فرح", "زفاف", "عرس", "خطوبه", "كتب كتاب", "wedding", "engagement", "fara7", "farah", "fra7", "khotoba", "katb el ketab"]],
  ["work", ["شغل", "مكتب", "انترفيو", "مقابله عمل", "work", "office", "interview", "shoghl", "sho8l", "sha8l", "shogl"]],
  ["date", ["خروجه", "سهره", "عشا", "موعد", "date", "dinner", "night out", "sahra", "khorga"]],
  ["eid", ["عيد", "رمضان", "افطار", "سحور", "eid", "ramadan", "iftar", "3eed", "3id", "ramadan"]],
  ["beach", ["بحر", "شاطي", "مصيف", "بيتش", "حمام سباحه", "beach", "pool", "bahr", "sahel", "masyaf"]],
  ["gym", ["جيم", "تمرين", "رياضه", "gym", "workout", "training", "yoga"]],
  ["university", ["جامعه", "كليه", "university", "college", "uni", "gam3a", "gam3et", "kolleya"]],
  ["casual", ["كاجوال", "يومي", "casual", "everyday", "daily", "kazual"]],
];

const MODEST_WORDS = ["محجبه", "محجبات", "حجاب", "محتشم", "محتشمه", "ساتر", "اكمام طويله", "كم طويل", "modest", "hijab", "hijabi", "mohagaba", "mo7agaba", "mohgaba", "m7agaba", "mohtashem", "covered"];
const CHEAPER_WORDS = ["ارخص", "اقل سعر", "سعر اقل", "اوفر", "اقل في السعر", "cheaper", "less expensive", "lower price", "lower cost", "arkhas", "ar5as", "akal fel se3r"];
const MORE_MODEST_WORDS = ["اكتر احتشام", "احتشام اكتر", "اكثر احتشام", "محتشم اكتر", "more modest", "longer sleeves", "more covered", "akter ehteshaam"];
const SWAP_VERBS = ["غير", "بدل", "استبدل", "مش عاجب", "swap", "change", "replace", "ghayar", "badel", "ghayyar"];
const SLOT_WORDS: readonly (readonly [Slot, readonly string[]])[] = [
  ["shoes", ["حذاء", "جزمه", "جزم", "كوتشي", "صندل", "shoes", "shoe", "sandals", "heels", "sneakers", "gazma", "gazam"]],
  ["bag", ["شنطه", "شنط", "حقيبه", "bag", "handbag", "purse", "shanta"]],
  ["dress", ["فستان", "فساتين", "عبايه", "dress", "gown", "abaya", "fostan", "fustan", "fsatin"]],
  ["bottom", ["بنطلون", "بنطال", "جيبه", "تنورات", "pants", "trousers", "skirt", "jeans", "bantalon", "bantalone", "gonella"]],
  ["top", ["بلوزه", "قميص", "تيشيرت", "توب", "top", "shirt", "blouse", "tshirt", "t-shirt", "bluza", "qamis"]],
  ["accessory", ["اكسسوار", "اكسسوارات", "حلق", "سلسله", "اوشحه", "ايشارب", "accessory", "accessories", "jewelry", "jewellery", "scarf", "belt", "ekseswar"]],
];
const GARMENT_ANY = ["لبس", "ملابس", "هدوم", "طقم", "اطلاله", "ستايل", "outfit", "clothes", "look", "style", "wear", "hadoom", "ta2m", "taqm", "labs"];
const GREETINGS = ["مرحبا", "اهلا", "هاي", "ازيك", "سلام", "صباح", "مساء", "hi", "hello", "hey", "salam", "ahlan", "azayak", "ezayak"];
const SCOPE_WORDS: readonly (readonly [World, readonly string[]])[] = [
  ["my_stores", ["متاجري", "محلاتي", "محلات المفضله", "my stores", "favorite stores", "favourite stores", "matagery"]],
  ["local", ["محلي", "محلية", "مصري", "ماركات مصريه", "local", "egyptian brands", "mahally", "ma7ally"]],
  ["global", ["عالمي", "عالميه", "ماركات عالميه", "global", "international", "3alamy", "alamy"]],
  ["everything", ["كل المتاجر", "كل الماركات", "اي متجر", "everything", "all stores", "any store", "kol el matager"]],
];
const SEASON_WORDS: readonly (readonly [Season, readonly string[]])[] = [
  ["summer", ["صيف", "صيفي", "summer", "sayf", "seify"]],
  ["winter", ["شتا", "شتوي", "شتاء", "winter", "shita", "sheta"]],
  ["spring", ["ربيع", "ربيعي", "spring", "rabee3"]],
  ["autumn", ["خريف", "خريفي", "autumn", "fall", "khareef"]],
];
const VIBE_WORDS: readonly (readonly [ChatVibe, readonly string[]])[] = [
  ["classic", ["كلاسيك", "classic", "classy", "elegant", "راقي", "شيك"]],
  ["trendy", ["ترند", "trendy", "modern", "عصري"]],
  ["minimal", ["مينيمال", "بسيط", "minimal", "simple", "basic"]],
  ["sporty", ["سبور", "رياضي", "sporty", "athletic"]],
  ["festive", ["احتفالي", "festive", "party", "حفله"]],
];
const FORMAL_WORDS: readonly (readonly [number, readonly string[]])[] = [
  [4, ["رسمي جدا", "black tie", "very formal"]],
  [3, ["رسمي", "formal", "elegant", "راقي"]],
  [0, ["مريح", "comfy", "comfortable", "loungewear"]],
];

const FINANCIAL = ["قرض", "استلف", "سلفه", "كريدت سكور", "loan", "borrow", "credit score", "credit card debt", "should i take credit", "should i finance"];
const MEDICAL_LEGAL = ["دواء", "علاج", "تشخيص", "محامي", "قضيه", "medicine", "diagnos", "prescription", "lawyer", "sue "];
const UNSAFE = ["سلاح", "قنبله", "bomb", "weapon", "how to hack", "اختراق حساب"];
const ABUSIVE = ["fuck", "shit", "bitch", "stupid bot", "غبي"];
const EXTERNAL = ["[link]", "http://", "https://", "www.", ".com", "amazon", "shein", "temu", "jumia", "noon.com", "زارا", "شي ان", "اشتري من موقع"];

const BUDGET_KEYWORD = "(?:تحت|ta7t|taht|t7t|اقل من|2a2al men|لحد|حد اقصي|حد اقصى|ميزانيتي|ميزانيه|ميزانية|بميزانيه|budget|under|below|less than|max|maximum|up to|within|upto|around|about)";
const NUMBER = "(\\d{1,3}(?:[,.]\\d{3})+|\\d+(?:\\.\\d+)?)";
const MULT = "(?:\\s*(k|الف|الاف|آلاف|ألف))?";
const CURRENCY = "(?:\\s*(?:جنيه|ج\\.م|جنيها|egp|le|l\\.e|pounds?|جم))";
const BUDGET_TRAILER = "(?:max|maximum|or less|or under|at most|tops|فاقل|او اقل|حد اقصي|حد اقصى|بالكتير)";
const BUDGET_C = new RegExp(`${NUMBER}${MULT}(?:${CURRENCY})?\\s*${BUDGET_TRAILER}`, "u");
const BUDGET_A = new RegExp(`${BUDGET_KEYWORD}\\s*(?:of\\s*|ب\\s*|حوالي\\s*|حوالى\\s*)?${NUMBER}${MULT}`, "u");
const BUDGET_B = new RegExp(`${NUMBER}${MULT}${CURRENCY}`, "u");

function toEgp(numStr: string, mult: string | undefined): number | null {
  let s = numStr;
  // "1,500" and "1.500" are thousands separators; "1.5" with a multiplier is a decimal.
  if (/^\d{1,3}([,.]\d{3})+$/.test(s)) s = s.replace(/[,.]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  const m = mult === undefined ? 1 : 1000;
  const v = Math.round(n * m);
  return v >= 1 && v <= MAX_BUDGET_EGP ? v : null;
}

/** The budget the shopper wrote in the text, in whole EGP, or null. Used to reject invented budgets. */
export function budgetFromText(text: string): number | null {
  const t = normalizeText(text);
  const a = BUDGET_A.exec(t);
  if (a !== null) {
    const v = toEgp(a[1] ?? "", a[2]);
    if (v !== null) return v;
  }
  const c = BUDGET_C.exec(t);
  if (c !== null) {
    const v = toEgp(c[1] ?? "", c[2]);
    if (v !== null) return v;
  }
  const b = BUDGET_B.exec(t);
  if (b !== null) return toEgp(b[1] ?? "", b[2]);
  return null;
}

/** Every whole number the shopper wrote (after digit folding), used to validate a model-supplied budget. */
export function numbersInText(text: string): ReadonlySet<number> {
  const out = new Set<number>();
  const t = normalizeText(text);
  for (const m of t.matchAll(/(?<![a-z\d])(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)(?=$|[^a-z\d]|k\b)/g)) {
    const raw = m[1] ?? "";
    const plain = /^\d{1,3}([,.]\d{3})+$/.test(raw) ? raw.replace(/[,.]/g, "") : raw;
    const n = Number(plain);
    if (Number.isFinite(n)) {
      out.add(Math.round(n));
      out.add(Math.round(n * 1000)); // "3k" / "3 الاف"
    }
  }
  return out;
}

export function detectLanguage(text: string, hint: ChatLang | null = null): ChatLang {
  const t = normalizeText(text);
  const ar = (t.match(ARABIC_LETTERS) ?? []).length;
  const en = (t.match(LATIN_LETTERS) ?? []).length;
  if (ar > 0 && ar >= en) return "ar";
  if (en > 0) {
    // Franco-Arabic is Arabic: it gets an Arabic reply (Arabic-first, spec 25).
    const franco = /\b(fostan|fara7|shoghl|3eed|mohagaba|mo7agaba|3ayz|3ayza|3ayez|3ayeza|ana|ezay|ezayak|aya|mesh|keda|kteer|awy|taht|2a2al|gneh|geneh)\b/.test(t);
    return franco ? "ar" : "en";
  }
  return hint ?? "ar";
}

const NO_MATCH = Symbol("none");

function firstOf<T>(t: string, table: readonly (readonly [T, readonly string[]])[]): T | typeof NO_MATCH {
  for (const [v, words] of table) if (has(t, words)) return v;
  return NO_MATCH;
}

/**
 * Deterministic parser of a (scrubbed) message. Covers the quick-action vocabulary, occasions,
 * modesty, budget forms ("تحت ٣٠٠٠", "under 3000", "3k"), scope words and refusal classes in
 * Egyptian Arabic, Franco-Arabic and English. Anything it cannot place is `clarify`, then `refuse`.
 */
export function parseRules(message: string, hintLang: ChatLang | null = null): ParsedIntent {
  const raw = message.trim();
  const language = detectLanguage(raw, hintLang);
  const t = normalizeText(raw);
  if (t.length === 0) return { intent: "clarify", clarify: "occasion", language };

  const refuse = (reason: RefusalReason): ParsedIntent => ({ intent: "refuse", refuse: reason, language });
  if (has(t, ABUSIVE)) return refuse("abusive");
  if (has(t, UNSAFE)) return refuse("unsafe");
  if (has(t, FINANCIAL)) return refuse("financial_advice");
  if (has(t, MEDICAL_LEGAL)) return refuse("medical_legal");
  if (has(t, EXTERNAL)) return refuse("external_site");

  const occasion = firstOf(t, OCCASION_WORDS);
  const slotHit = firstOf(t, SLOT_WORDS);
  const scope = firstOf(t, SCOPE_WORDS);
  const season = firstOf(t, SEASON_WORDS);
  const vibe = firstOf(t, VIBE_WORDS);
  const formal = firstOf(t, FORMAL_WORDS);
  const budget = budgetFromText(raw);
  const modestWord = has(t, MODEST_WORDS);

  const base = {
    language,
    ...(season !== NO_MATCH ? { season } : {}),
    ...(vibe !== NO_MATCH ? { vibe } : {}),
    ...(formal !== NO_MATCH ? { formality: formal } : {}),
    ...(budget !== null ? { budgetEgp: budget } : {}),
  };

  if (has(t, MORE_MODEST_WORDS)) return { ...base, intent: "more_modest", modest: true };
  if (has(t, CHEAPER_WORDS)) return { ...base, intent: "cheaper" };
  if (has(t, SWAP_VERBS) && slotHit !== NO_MATCH && occasion === NO_MATCH) return { ...base, intent: "swap_item", slot: slotHit };

  const garmentAny = has(t, GARMENT_ANY);
  if (occasion !== NO_MATCH || slotHit !== NO_MATCH || budget !== null || garmentAny || modestWord) {
    return {
      ...base,
      intent: "outfit",
      ...(occasion !== NO_MATCH ? { occasion } : {}),
      ...(modestWord ? { modest: true } : {}),
      ...(scope !== NO_MATCH ? { world: scope } : {}),
    };
  }
  if (scope !== NO_MATCH) return { ...base, intent: "change_scope", world: scope };
  if (season !== NO_MATCH || vibe !== NO_MATCH || formal !== NO_MATCH) return { ...base, intent: "outfit" };
  if (has(t, GREETINGS)) return { intent: "clarify", clarify: "occasion", language };
  return refuse("non_fashion");
}

/**
 * Server-side reconciliation of a model-supplied intent (LLM05): a budget the shopper did not
 * write is dropped (a model, or injected text, cannot set a budget), and scope words are trusted
 * only from the enum. Idempotent.
 */
export function reconcileIntent(p: ParsedIntent, message: string): ParsedIntent {
  if (p.budgetEgp === undefined) return p;
  const written = numbersInText(message);
  if (written.has(p.budgetEgp)) return p;
  const { budgetEgp: _drop, ...rest } = p;
  return rest;
}

// ---- planner -------------------------------------------------------------------------------------

export type ChatPlan =
  | { readonly kind: "refuse"; readonly reason: RefusalReason; readonly state: ChatState }
  | { readonly kind: "clarify"; readonly topic: ClarifyTopic; readonly state: ChatState }
  | { readonly kind: "ask_swap_slot"; readonly state: ChatState }
  | {
      readonly kind: "generate";
      readonly state: ChatState;
      readonly why: "outfit" | "cheaper" | "more_modest" | "change_scope" | "swap_item" | "refine";
    };

export interface PlanContext {
  /** Items of the first outfit of the previous generation (DB rows), for swap. */
  readonly lastItems: readonly { readonly itemId: string; readonly slot: Slot }[];
}

const toPiastres = (egp: number): string => (BigInt(egp) * 100n).toString();
const addRejected = (ids: readonly string[], more: readonly string[]): string[] => [...new Set([...ids, ...more])].slice(-MAX_REJECTED);

/** Applies a parsed intent to the session state and decides what the turn does. Pure and total. */
export function planTurn(state: ChatState, p: ParsedIntent, ctx: PlanContext, swapItemId: string | null = null): ChatPlan {
  const withLang: ChatState = { ...state, language: p.language };
  if (p.intent === "refuse") return { kind: "refuse", reason: p.refuse ?? "non_fashion", state: withLang };

  const merged: ChatState = {
    ...withLang,
    occasion: p.occasion ?? withLang.occasion,
    vibe: p.vibe ?? withLang.vibe,
    season: p.season ?? withLang.season,
    formality: p.formality ?? withLang.formality,
    modest: withLang.modest || p.modest === true || p.intent === "more_modest",
    world: p.world ?? withLang.world,
    budgetPiastres: p.budgetEgp !== undefined ? toPiastres(p.budgetEgp) : withLang.budgetPiastres,
  };

  if (p.intent === "clarify") {
    // One clarifying question at most, then best effort (spec Edge cases).
    if (state.clarificationsAsked >= 1) return { kind: "generate", state: { ...merged, clarificationsAsked: 0 }, why: "refine" };
    return { kind: "clarify", topic: p.clarify ?? "occasion", state: { ...merged, clarificationsAsked: state.clarificationsAsked + 1 } };
  }

  if (p.intent === "cheaper") {
    if (state.lastTotalPiastres === null) {
      if (state.clarificationsAsked >= 1) return { kind: "generate", state: { ...merged, clarificationsAsked: 0 }, why: "cheaper" };
      return { kind: "clarify", topic: "budget", state: { ...merged, clarificationsAsked: state.clarificationsAsked + 1 } };
    }
    // 20% below the previous outfit total, never above a budget the shopper typed (integer math).
    const target = (BigInt(state.lastTotalPiastres) * 80n) / 100n;
    const typed = merged.budgetPiastres === null ? null : BigInt(merged.budgetPiastres);
    const next = typed !== null && typed < target ? typed : target;
    return { kind: "generate", state: { ...merged, budgetPiastres: next.toString(), clarificationsAsked: 0 }, why: "cheaper" };
  }

  if (p.intent === "swap_item") {
    const target =
      swapItemId !== null
        ? ctx.lastItems.find((i) => i.itemId === swapItemId)
        : p.slot !== undefined
          ? ctx.lastItems.find((i) => i.slot === p.slot)
          : undefined;
    if (target === undefined) return { kind: "ask_swap_slot", state: merged };
    return {
      kind: "generate",
      state: { ...merged, rejectedItemIds: addRejected(merged.rejectedItemIds, [target.itemId]), clarificationsAsked: 0 },
      why: "swap_item",
    };
  }

  if (p.intent === "outfit") {
    return { kind: "generate", state: { ...merged, clarificationsAsked: 0 }, why: p.intent };
  }
  return { kind: "generate", state: { ...merged, clarificationsAsked: 0 }, why: p.intent === "more_modest" ? "more_modest" : "change_scope" };
}

// ---- colour palette filter (soft) ---------------------------------------------------------------

const PALETTE_COLORS: Readonly<Record<ChatPalette, readonly string[]>> = {
  neutral: ["black", "white", "beige", "cream", "grey", "gray", "brown", "camel", "navy", "ivory", "tan"],
  bright: ["red", "yellow", "orange", "pink", "fuchsia", "green", "blue", "turquoise", "purple", "coral"],
  dark: ["black", "navy", "charcoal", "dark green", "burgundy", "brown", "dark blue", "maroon"],
  pastel: ["pastel", "baby blue", "lilac", "mint", "blush", "peach", "light pink", "lavender", "powder"],
};

/**
 * Keeps candidates in the palette per slot, but only when at least `minKeep` remain in that slot:
 * a palette is a preference, never a reason to return an empty outfit.
 */
export function applyPalette<T extends { readonly slot: Slot; readonly colors: readonly string[] }>(
  items: readonly T[],
  palette: ChatPalette | null,
  minKeep = 2,
): T[] {
  if (palette === null) return [...items];
  const allowed = new Set(PALETTE_COLORS[palette]);
  const out: T[] = [];
  for (const slot of SLOTS) {
    const inSlot = items.filter((i) => i.slot === slot);
    const kept = inSlot.filter((i) => i.colors.some((c) => allowed.has(c.toLowerCase())));
    out.push(...(kept.length >= minKeep ? kept : inSlot));
  }
  return out;
}

// ---- replies -------------------------------------------------------------------------------------

export type ReplyCode =
  | "outfits_ready"
  | "outfit_partial"
  | "no_items_in_size"
  | "no_items_in_scope"
  | "catalog_unavailable"
  | "clarify_occasion"
  | "clarify_palette"
  | "clarify_budget"
  | "swap_which"
  | "swap_done"
  | "refuse_non_fashion"
  | "refuse_unsafe"
  | "refuse_financial"
  | "refuse_external"
  | "refuse_medical_legal"
  | "refuse_abusive"
  | "refuse_injection";

interface ReplyTemplate {
  readonly ar: string;
  readonly en: string;
  /** Names the template may interpolate. Values come from DB rows, never from a model. */
  readonly params: readonly string[];
}

/**
 * Fixed reply catalogue (AR first). No weight, size-shaming or body-image language; no price or
 * stock claim except through a named numeric parameter read from the database.
 */
export const REPLIES: Readonly<Record<ReplyCode, ReplyTemplate>> = {
  outfits_ready: { ar: "دي اقتراحاتي ليكي. كل قطعة متاحة في مقاسك وفي حدود ميزانيتك.", en: "Here are my suggestions. Every piece is in stock in your size.", params: [] },
  outfit_partial: {
    ar: "ده أفضل طقم متاح دلوقتي. ضيفي {amount} ج.م عشان تكمّلي القطعة الناقصة ({slot}).",
    en: "This is the best outfit available now. Add {amount} EGP to complete the missing piece ({slot}).",
    params: ["amount", "slot"],
  },
  no_items_in_size: { ar: "مفيش قطع كفاية في مقاسك دلوقتي. جرّبي توسّعي النطاق أو غيّري المناسبة.", en: "There are not enough pieces in your size right now. Try widening the scope or changing the occasion.", params: [] },
  no_items_in_scope: { ar: "مفيش نتايج في النطاق ده. تحبي أوسّع البحث لكل المتاجر؟", en: "No results in this scope. Want me to widen the search to all stores?", params: [] },
  catalog_unavailable: { ar: "الكتالوج مش متاح دلوقتي. جرّبي تاني بعد شوية أو استخدمي المصمم المنظّم.", en: "The catalogue is unavailable right now. Try again shortly or use the structured stylist.", params: [] },
  clarify_occasion: { ar: "المناسبة إيه؟ (شغل، فرح، خروجة، عيد...)", en: "What is the occasion? (work, wedding, date, Eid...)", params: [] },
  clarify_palette: { ar: "تفضّلي أي مجموعة ألوان؟", en: "Which colour palette do you prefer?", params: [] },
  clarify_budget: { ar: "ميزانيتك تقريبًا كام؟", en: "Roughly what is your budget?", params: [] },
  swap_which: { ar: "تحبي أغيّر أنهي قطعة؟", en: "Which piece should I change?", params: [] },
  swap_done: { ar: "غيّرت القطعة وده الطقم الجديد.", en: "I swapped that piece. Here is the new outfit.", params: [] },
  refuse_non_fashion: { ar: "أنا مساعد الموضة بس. اسأليني عن لبس لمناسبة أو ميزانية.", en: "I can only help with fashion. Ask me about an outfit for an occasion or a budget.", params: [] },
  refuse_unsafe: { ar: "مش هقدر أساعد في الطلب ده.", en: "I can't help with that request.", params: [] },
  refuse_financial: { ar: "مش بقدّم نصايح تمويل أو قروض. أقدر أساعدك تلاقي لبس في ميزانيتك.", en: "I don't give credit or loan advice. I can help you find outfits within your budget.", params: [] },
  refuse_external: { ar: "أنا بقترح من متاجر المنصة بس. قوليلي المناسبة والميزانية.", en: "I only suggest items from this platform's stores. Tell me the occasion and budget.", params: [] },
  refuse_medical_legal: { ar: "ده برّه تخصصي. أقدر أساعدك في اختيار لبس بس.", en: "That is outside what I can help with. I can only help you choose clothes.", params: [] },
  refuse_abusive: { ar: "أنا هنا أساعدك في اختيار اللبس. قوليلي تحبي إيه.", en: "I'm here to help you choose clothes. Tell me what you like.", params: [] },
  refuse_injection: { ar: "مقدرش أنفّذ تعليمات داخل الرسالة. قوليلي المناسبة والميزانية وأنا أقترح لبس.", en: "I can't follow instructions inside the message. Tell me the occasion and budget and I will suggest outfits.", params: [] },
};

export const SLOT_LABELS: Readonly<Record<Slot, { readonly ar: string; readonly en: string }>> = {
  top: { ar: "بلوزة", en: "top" },
  bottom: { ar: "بنطلون أو جيبة", en: "bottom" },
  dress: { ar: "فستان", en: "dress" },
  shoes: { ar: "حذاء", en: "shoes" },
  bag: { ar: "شنطة", en: "bag" },
  accessory: { ar: "إكسسوار", en: "accessory" },
};

export const REFUSAL_CODE: Readonly<Record<RefusalReason, ReplyCode>> = {
  non_fashion: "refuse_non_fashion",
  unsafe: "refuse_unsafe",
  financial_advice: "refuse_financial",
  external_site: "refuse_external",
  medical_legal: "refuse_medical_legal",
  abusive: "refuse_abusive",
  injection: "refuse_injection",
};

/**
 * Renders a reply. Post-check (LLM05/09): every digit run in the output must equal a supplied
 * parameter, so a template edit or a bad caller cannot smuggle a numeric claim. On violation the
 * caller gets the parameter-free generic reply.
 */
export function renderReply(code: ReplyCode, lang: ChatLang, params: Readonly<Record<string, string>> = {}): string {
  const tpl = REPLIES[code];
  let out = tpl[lang];
  for (const name of tpl.params) {
    const v = params[name];
    if (v === undefined) return REPLIES.outfits_ready[lang];
    out = out.replaceAll(`{${name}}`, v);
  }
  const allowedNumbers = new Set(Object.values(params).flatMap((v) => v.match(/\d+/g) ?? []));
  for (const run of out.match(/\d+/g) ?? []) {
    if (!allowedNumbers.has(run)) return REPLIES.outfits_ready[lang];
  }
  return out;
}

// ---- chips and blocks ---------------------------------------------------------------------------

export interface ChipOption {
  readonly id: string;
  readonly ar: string;
  readonly en: string;
}

export const PALETTE_CHIPS: readonly ChipOption[] = [
  { id: "neutral", ar: "ألوان هادية", en: "Neutrals" },
  { id: "bright", ar: "ألوان زاهية", en: "Bright" },
  { id: "dark", ar: "ألوان غامقة", en: "Dark" },
  { id: "pastel", ar: "ألوان باستيل", en: "Pastel" },
];
export const OCCASION_CHIPS: readonly ChipOption[] = [
  { id: "work", ar: "شغل", en: "Work" },
  { id: "wedding_guest", ar: "فرح", en: "Wedding guest" },
  { id: "date", ar: "خروجة", en: "Date" },
  { id: "eid", ar: "عيد", en: "Eid" },
  { id: "casual", ar: "كاجوال", en: "Casual" },
];
export const BUDGET_CHIPS: readonly ChipOption[] = [
  { id: "1000", ar: "حتى ١٠٠٠ ج.م", en: "Up to 1,000 EGP" },
  { id: "3000", ar: "حتى ٣٠٠٠ ج.م", en: "Up to 3,000 EGP" },
  { id: "5000", ar: "حتى ٥٠٠٠ ج.م", en: "Up to 5,000 EGP" },
];
export const QUICK_ACTIONS: readonly ChipOption[] = [
  { id: "cheaper", ar: "أرخص", en: "Cheaper" },
  { id: "more_modest", ar: "أكثر احتشامًا", en: "More modest" },
  { id: "swap_item", ar: "غيّر قطعة", en: "Swap an item" },
  { id: "scope_everything", ar: "كل المتاجر", en: "All stores" },
];

export type StoredBlock =
  | { readonly type: "text"; readonly code: string; readonly params: Readonly<Record<string, string>>; readonly lang: ChatLang }
  | { readonly type: "outfits"; readonly outfitIds: readonly string[] }
  | { readonly type: "chips"; readonly topic: ClarifyTopic | "swap_slot"; readonly optionIds: readonly string[] }
  | { readonly type: "quick_actions"; readonly optionIds: readonly string[] };

export const StoredBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    code: z.string().max(60),
    params: z.record(z.string().max(30), z.string().max(60)),
    lang: z.enum(["ar", "en"]),
  }),
  z.object({ type: z.literal("outfits"), outfitIds: z.array(z.uuid()).max(10) }),
  z.object({ type: z.literal("chips"), topic: z.enum(["palette", "occasion", "budget", "swap_slot"]), optionIds: z.array(z.string().max(30)).max(10) }),
  z.object({ type: z.literal("quick_actions"), optionIds: z.array(z.string().max(30)).max(10) }),
]);

export const chipsFor = (topic: ClarifyTopic | "swap_slot"): readonly ChipOption[] =>
  topic === "palette"
    ? PALETTE_CHIPS
    : topic === "occasion"
      ? OCCASION_CHIPS
      : topic === "budget"
        ? BUDGET_CHIPS
        : SLOTS.map((s) => ({ id: s, ar: SLOT_LABELS[s].ar, en: SLOT_LABELS[s].en }));

/** Whole EGP, rounded up, from piastres (a DB-derived number shown in "add X EGP for shoes"). */
export const egpCeil = (piastres: bigint): string => ((piastres + 99n) / 100n).toString();
