// Deterministic generator for docs/search/queries.v1.jsonl and judgments.v1.jsonl (ADR-0010).
// Usage (after `pnpm --filter @outlet/search-bakeoff build`): node scripts/generate-corpus.mjs
// Every row is source "synthetic": built from the lexicon, NOT from real user logs.
import { readFileSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import { normalizeArabic } from "../dist/normalize.js";

const lex = JSON.parse(readFileSync(new URL("../src/synonyms.v1.json", import.meta.url), "utf8"));
const OUT = new URL("../../../docs/search/", import.meta.url);

let seed = 20261108;
const rng = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rng() * xs.length)];
const kind = (k) => lex.groups.filter((g) => g.kind === k);
const CAT = kind("category"), COL = kind("color"), MAT = kind("material"), AUD = kind("audience"), BR = kind("brand");
const STY = [...kind("style"), ...kind("occasion"), ...kind("season")];
const enSet = new Set(lex.groups.flatMap((g) => g.en.map(normalizeArabic)));
const allVariants = new Set(lex.groups.flatMap((g) => [...g.ar, ...g.en, ...g.franco].map(normalizeArabic)));
const EAST = "٠١٢٣٤٥٦٧٨٩", PERS = "۰۱۲۳۴۵۶۷۸۹";
const eastern = (s, table = EAST) => s.replace(/\d/g, (d) => table[Number(d)]);

const francoOptions = (g) => g.franco.filter((f) => !enSet.has(f));
const word = (g, lang) => {
  if (lang === "franco") {
    const o = francoOptions(g);
    if (o.length === 0) return { text: pick(g.en), lang: "en" }; // Latin brand names etc.
    return { text: pick(o), lang: "franco" };
  }
  return { text: pick(lang === "ar" ? g.ar : g.en), lang };
};

const FILL = { ar: ["عايز", "عايزة", "عاوز", "ابغي"], en: ["i want", "looking for", "show me", "find me"], franco: ["3ayez", "3ayza", "3awez"] };
const PRICE = [300, 500, 750, 800, 1000, 1200, 1500, 2000, 2500, 3000, 5000];
const BEFORE = { ar: ["تحت", "اقل من", "لحد", "في حدود"], en: ["under", "below", "less than", "max", "up to"], franco: ["ta7t", "a2al men", "le7ad"] };
const CUR = { ar: ["", "", "جنيه"], en: ["", "", "egp"], franco: ["", "", "gneh"] };

// A shape lists the concept slots; English reorders them adjective-first.
const SHAPES = [["C"], ["C", "K"], ["C", "A"], ["C", "M", "K"], ["C", "B"], ["C", "K", "A"], ["C", "S"], ["C", "M"], ["C", "A", "S"], ["C", "K", "B"], ["C", "M", "K", "A"]];
const slotGroup = (s) => ({ C: pick(CAT), K: pick(COL), M: pick(MAT), A: pick(AUD), B: pick(BR), S: pick(STY) })[s];

const mutate = (t) => {
  if (t.length < 5 || t.includes(" ")) return null;
  for (let k = 0; k < 12; k += 1) {
    const i = 1 + Math.floor(rng() * (t.length - 2));
    const op = Math.floor(rng() * 3);
    const m = op === 0 ? t.slice(0, i) + t.slice(i + 1) : op === 1 ? t.slice(0, i) + t[i + 1] + t[i] + t.slice(i + 2) : t.slice(0, i) + t[i] + t.slice(i);
    if (m !== t && !allVariants.has(normalizeArabic(m))) return m;
  }
  return null;
};

const seen = new Set();
const rows = [];
const emit = (opts) => {
  const { langs, shape, filler = false, price = false, digits = null, typo = false, requireMixed = false, group } = opts;
  const groups = shape.map(slotGroup);
  const lang = (i) => (typeof langs === "function" ? langs(i) : langs);
  let toks = groups.map((g, i) => ({ g, ...word(g, lang(i)), slot: shape[i] }));
  if (requireMixed) {
    const hasAr = toks.some((t) => t.lang === "ar"), hasLat = toks.some((t) => t.lang !== "ar");
    if (!hasAr || !hasLat) return false;
  }
  if (typo) {
    const cand = toks.filter((t) => (t.slot === "C" || t.slot === "K") && t.lang !== "ar");
    const t = cand.length ? pick(cand) : null;
    const m = t ? mutate(t.text) : null;
    if (m === null) return false;
    t.text = m;
  }
  // order: Arabic/Franco noun-first; English adjective-first
  const enOrder = ["B", "S", "K", "M", "C"];
  const primary = toks.some((t) => t.lang === "ar") ? "ar" : toks.some((t) => t.lang === "franco") ? "franco" : "en";
  let ordered = toks;
  if (primary === "en" && !toks.some((t) => t.lang === "franco")) {
    ordered = [...toks].sort((a, b) => enOrder.indexOf(a.slot) - enOrder.indexOf(b.slot));
    const aud = ordered.findIndex((t) => t.slot === "A");
    if (aud >= 0) ordered.splice(aud, 1, { ...ordered[aud], text: `for ${ordered[aud].text}` });
  }
  const parts = ordered.map((t) => t.text);
  const pl = primary;
  if (filler) parts.unshift(pick(FILL[pl]));
  let max = null;
  if (price) {
    max = pick(PRICE);
    const useK = pl === "en" && max % 1000 === 0 && rng() < 0.4;
    let num = useK ? `${max / 1000}k` : String(max);
    if (digits === "east") num = eastern(num);
    if (digits === "persian") num = eastern(num, PERS);
    parts.push([pick(BEFORE[pl]), num, pick(CUR[pl])].filter(Boolean).join(" "));
  }
  const text = parts.join(" ");
  if (seen.has(text)) return false;
  seen.add(text);
  const concepts = [...new Set(groups.map((g) => g.id))];
  const scripts = new Set(toks.map((t) => (t.lang === "ar" ? "ar" : "latin")));
  const hasFranco = toks.some((t) => t.lang === "franco");
  const script = scripts.size === 2 ? "mixed" : scripts.has("ar") ? "ar" : hasFranco ? "franco" : "en";
  let intent = "product_type";
  if (price) intent = "price_constrained";
  else if (filler) intent = "natural_language";
  else if (concepts.some((c) => BR.some((b) => b.id === c))) intent = "brand";
  else if (concepts.some((c) => ["kids", "boys", "girls", "baby"].includes(c))) intent = "kids";
  else if (concepts.includes("modest")) intent = "modest";
  else if (concepts.includes("sale")) intent = "deal";
  else if (shape.length > 1) intent = "attribute";
  const tags = [group];
  if (typo) tags.push("typo");
  if (price) tags.push("price");
  if (digits) tags.push("digits");
  rows.push({
    text, script, intent, expected_normalized: [...concepts].sort().join(" "),
    ...(max === null ? {} : { expected_filters: { maxPriceMinor: max * 100 } }),
    tags: [...new Set(tags)], concepts, source: "synthetic",
  });
  return true;
};

const fill = (n, make) => {
  let made = 0, guard = 0;
  while (made < n && guard < n * 400) { guard += 1; if (make()) made += 1; }
  if (made < n) throw new Error(`only ${made}/${n}`);
};
const shape = () => pick(SHAPES);
fill(150, () => emit({ langs: "ar", shape: shape(), filler: rng() < 0.2, group: "ar" }));
fill(100, () => emit({ langs: "en", shape: shape(), filler: rng() < 0.15, group: "en" }));
fill(100, () => emit({ langs: "franco", shape: shape(), filler: rng() < 0.2, group: "franco" }));
fill(50, () => emit({ langs: () => pick(["ar", "en", "franco"]), shape: shape(), requireMixed: true, group: "mixed" }));
let k = 0;
fill(50, () => {
  k += 1;
  const lang = k % 5 < 2 ? "ar" : k % 5 < 4 ? "en" : "franco";
  const mixed = k % 10 === 9;
  const digits = lang === "ar" || mixed ? (rng() < 0.1 ? "persian" : "east") : null;
  return emit({ langs: mixed ? () => pick(["ar", "en"]) : lang, shape: pick(SHAPES.slice(0, 6)), price: true, digits, requireMixed: mixed, group: "digits" });
});
fill(50, () => emit({ langs: rng() < 0.5 ? "en" : "franco", shape: pick(SHAPES.slice(0, 6)), typo: true, group: "typo" }));

const queries = rows.map((r, i) => ({ id: `q${String(i + 1).padStart(4, "0")}`, ...r }));
const judgments = [];
queries.forEach((q, i) => {
  if (i % 2 !== 0) return;
  const patterns = q.concepts.map((id) => {
    const g = lex.groups.find((x) => x.id === id);
    return `${normalizeArabic(g.ar[0])}|${normalizeArabic(g.en[0])}`;
  });
  judgments.push({ queryId: q.id, patterns, grade: 3, source: "synthetic" });
});
const out = queries.map((q) => {
  const copy = { ...q };
  delete copy.concepts;
  return copy;
});
writeFileSync(new URL("queries.v1.jsonl", OUT), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(new URL("judgments.v1.jsonl", OUT), judgments.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`queries=${out.length} judgments=${judgments.length}`);
