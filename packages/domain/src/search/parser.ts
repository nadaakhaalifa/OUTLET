import { normalizeSearchText, tokenize } from "./arabic";
import { canonicalizeFilter, MAX_QUERY_LENGTH, type SearchFilter } from "./filter";
import { lookupConcept } from "./lexicon";

/** Hard cap: 10,000,000 EGP. Larger numbers are never turned into a price. */
const MAX_EGP = 10_000_000n;

type Marker =
  | { readonly kind: "max" }
  | { readonly kind: "min" }
  | { readonly kind: "between_open" }
  | { readonly kind: "flag"; readonly key: "mySizeOnly" | "installmentsAvailable" | "codAvailable" | "freeDeliveryEligible" }
  | { readonly kind: "noise" };

/** Phrases are stored normalized (alef/ya/ta-marbuta folded) and matched on token sequences. */
const PHRASES: readonly (readonly [string, Marker])[] = [
  ["less than", { kind: "max" }],
  ["cheaper than", { kind: "max" }],
  ["no more than", { kind: "max" }],
  ["up to", { kind: "max" }],
  ["under", { kind: "max" }],
  ["below", { kind: "max" }],
  ["within", { kind: "max" }],
  ["max", { kind: "max" }],
  ["taht", { kind: "max" }],
  ["ta7t", { kind: "max" }],
  ["تحت", { kind: "max" }],
  ["اقل من", { kind: "max" }],
  ["اقل", { kind: "max" }],
  ["حتي", { kind: "max" }],
  ["more than", { kind: "min" }],
  ["over", { kind: "min" }],
  ["above", { kind: "min" }],
  ["min", { kind: "min" }],
  ["fo2", { kind: "min" }],
  ["foq", { kind: "min" }],
  ["فوق", { kind: "min" }],
  ["اكتر من", { kind: "min" }],
  ["اكثر من", { kind: "min" }],
  ["between", { kind: "between_open" }],
  ["بين", { kind: "between_open" }],
  ["my size", { kind: "flag", key: "mySizeOnly" }],
  ["مقاسي", { kind: "flag", key: "mySizeOnly" }],
  ["installments", { kind: "flag", key: "installmentsAvailable" }],
  ["installment", { kind: "flag", key: "installmentsAvailable" }],
  ["تقسيط", { kind: "flag", key: "installmentsAvailable" }],
  ["cod", { kind: "flag", key: "codAvailable" }],
  ["free delivery", { kind: "flag", key: "freeDeliveryEligible" }],
  ["توصيل مجاني", { kind: "flag", key: "freeDeliveryEligible" }],
  // noise: connectives and request verbs
  ["for", { kind: "noise" }],
  ["a", { kind: "noise" }],
  ["an", { kind: "noise" }],
  ["the", { kind: "noise" }],
  ["in", { kind: "noise" }],
  ["with", { kind: "noise" }],
  ["and", { kind: "noise" }],
  ["i", { kind: "noise" }],
  ["want", { kind: "noise" }],
  ["need", { kind: "noise" }],
  ["show", { kind: "noise" }],
  ["me", { kind: "noise" }],
  ["find", { kind: "noise" }],
  ["و", { kind: "noise" }],
  ["عايز", { kind: "noise" }],
  ["عاوز", { kind: "noise" }],
  ["محتاج", { kind: "noise" }],
  ["ب", { kind: "noise" }],
  ["في", { kind: "noise" }],
  ["of", { kind: "noise" }],
  ["to", { kind: "noise" }],
  ["الي", { kind: "noise" }],
  ["من", { kind: "noise" }],
];

const PHRASE_TABLE = new Map<string, Marker>(PHRASES.map(([p, m]) => [normalizeSearchText(p), m]));
const MAX_PHRASE_TOKENS = 3;

const CURRENCY = new Set(["egp", "le", "l.e", "جنيه", "جنية", "جنيها", "ج", "جم", "pounds", "pound", "ج.م"].map(normalizeSearchText));
const NUMBER = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^\d+(?:\.\d+)?k?$/u;

/** "1,500" "1500" "1.5k" -> piastres; null when out of range or unsupported. */
export function parseEgpAmount(token: string): bigint | null {
  if (!NUMBER.test(token)) return null;
  const k = token.endsWith("k");
  const body = (k ? token.slice(0, -1) : token).replace(/,/gu, "");
  const [whole = "0", frac = ""] = body.split(".");
  if (!k && frac.length > 2) return null;
  let pounds: bigint;
  let piastres: bigint;
  if (k) {
    // x.yk = x*1000 + y*100 (one decimal digit used per 100); more digits are not "k" notation.
    if (frac.length > 3) return null;
    const f = frac.padEnd(3, "0");
    const total = BigInt(whole) * 1000n + BigInt(f);
    pounds = total;
    piastres = 0n;
  } else {
    pounds = BigInt(whole);
    piastres = frac.length === 0 ? 0n : BigInt(frac.padEnd(2, "0"));
  }
  if (pounds > MAX_EGP) return null;
  return pounds * 100n + piastres;
}

export interface ParsedQuery {
  readonly filter: SearchFilter;
  /** Canonical keyword remainder: concept ids (English) and untouched tokens, in input order. */
  readonly keywords: string;
  /** Markers that could not bind to a number and other leftovers worth showing. */
  readonly unparsed: readonly string[];
  readonly normalized: string;
}

interface Acc {
  priceMin?: bigint;
  priceMax?: bigint;
  mySizeOnly?: boolean;
  installmentsAvailable?: boolean;
  codAvailable?: boolean;
  freeDeliveryEligible?: boolean;
  colors: string[];
  materials: string[];
  categories: string[];
}

/** Deterministic, side-effect free. Never calls a model. Equivalent AR/EN/Franco queries give equal output. */
export function parseSearchQuery(text: string): ParsedQuery {
  const normalized = normalizeSearchText(text.slice(0, MAX_QUERY_LENGTH));
  const tokens = tokenize(normalized);
  const acc: Acc = { colors: [], materials: [], categories: [] };
  const keywords: string[] = [];
  const unparsed: string[] = [];

  const matchPhrase = (i: number): { marker: Marker; len: number; text: string } | null => {
    for (let len = Math.min(MAX_PHRASE_TOKENS, tokens.length - i); len >= 1; len -= 1) {
      const p = tokens.slice(i, i + len).join(" ");
      const m = PHRASE_TABLE.get(p);
      if (m !== undefined) return { marker: m, len, text: p };
    }
    return null;
  };

  const readAmount = (from: number): { amount: bigint; next: number } | null => {
    const t = tokens[from];
    if (t === undefined) return null;
    const amount = parseEgpAmount(t);
    if (amount === null) return null;
    let next = from + 1;
    const cur = tokens[next];
    if (cur !== undefined && CURRENCY.has(cur)) next += 1;
    return { amount, next };
  };

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined) break;
    if (tok === "من" || tok === "from") {
      const lo = readAmount(i + 1);
      const joiner = lo === null ? undefined : tokens[lo.next];
      if (lo !== null && (joiner === "الي" || joiner === "to")) {
        const hi = readAmount(lo.next + 1);
        if (hi !== null) {
          acc.priceMin = lo.amount < hi.amount ? lo.amount : hi.amount;
          acc.priceMax = lo.amount < hi.amount ? hi.amount : lo.amount;
          i = hi.next;
          continue;
        }
      }
    }
    const hit = matchPhrase(i);
    if (hit !== null) {
      const { marker } = hit;
      if (marker.kind === "noise") {
        i += hit.len;
        continue;
      }
      if (marker.kind === "flag") {
        acc[marker.key] = true;
        i += hit.len;
        continue;
      }
      if (marker.kind === "max" || marker.kind === "min") {
        const a = readAmount(i + hit.len);
        if (a === null) {
          // Postfix form: "1500 under" / "1500 تحت". The number was already kept as a keyword.
          const before = tokens[i - 1];
          const prior = before === undefined ? null : parseEgpAmount(before);
          if (prior !== null && keywords[keywords.length - 1] === before) {
            keywords.pop();
            if (marker.kind === "max") acc.priceMax = prior;
            else acc.priceMin = prior;
            i += hit.len;
            continue;
          }
          unparsed.push(hit.text);
          i += hit.len;
          continue;
        }
        if (marker.kind === "max") acc.priceMax = a.amount;
        else acc.priceMin = a.amount;
        i = a.next;
        continue;
      }
      // between A and B  (also: من A الي B handled by the noise words around numbers)
      const lo = readAmount(i + hit.len);
      let cursor = lo === null ? i + hit.len : lo.next;
      if (tokens[cursor] === "and" || tokens[cursor] === "و") cursor += 1;
      const hi = lo === null ? null : readAmount(cursor);
      if (lo !== null && hi !== null) {
        acc.priceMin = lo.amount < hi.amount ? lo.amount : hi.amount;
        acc.priceMax = lo.amount < hi.amount ? hi.amount : lo.amount;
        i = hi.next;
      } else {
        unparsed.push(hit.text);
        i += hit.len;
      }
      continue;
    }
    const concept = lookupConcept(tok);
    if (concept !== null) {
      const bucket = concept.kind === "color" ? acc.colors : concept.kind === "material" ? acc.materials : acc.categories;
      bucket.push(concept.id);
      if (concept.kind === "category") keywords.push(concept.id);
      i += 1;
      continue;
    }
    const prevToken = tokens[i - 1];
    if (CURRENCY.has(tok) && prevToken !== undefined && NUMBER.test(prevToken)) {
      i += 1;
      continue;
    }
    keywords.push(tok);
    i += 1;
  }

  const filter: Record<string, unknown> = {};
  if (acc.priceMin !== undefined) filter.priceMin = acc.priceMin;
  if (acc.priceMax !== undefined) filter.priceMax = acc.priceMax;
  if (acc.mySizeOnly === true) filter.mySizeOnly = true;
  if (acc.installmentsAvailable === true) filter.installmentsAvailable = true;
  if (acc.codAvailable === true) filter.codAvailable = true;
  if (acc.freeDeliveryEligible === true) filter.freeDeliveryEligible = true;
  if (acc.colors.length > 0) filter.colors = acc.colors;
  if (acc.materials.length > 0) filter.materials = acc.materials;
  return {
    filter: canonicalizeFilter(filter as SearchFilter),
    keywords: [...new Set(keywords)].join(" "),
    unparsed,
    normalized,
  };
}

/** Index-side term groups: each keyword becomes the OR-group of its AR/EN/Franco forms. */
export { expandTerm as expandKeyword } from "./lexicon";
