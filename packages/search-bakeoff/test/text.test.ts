import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseBudget } from "../src/budget.js";
import { FRANCO_WORDS, levenshtein, transliterateFranco } from "../src/franco.js";
import { GROUPS, LEXICON_CONFLICTS, SYNONYM_VERSION, canonicalTerm, groupById } from "../src/lexicon.js";
import { normalizeArabic, tokenize, toAsciiDigits } from "../src/normalize.js";
import { analyzeQuery } from "../src/query.js";

describe("normalizeArabic", () => {
  it("folds alef, ya, ta-marbuta and strips tashkeel and tatweel", () => {
    expect(normalizeArabic("أُمِّـــي إلى آخر ٱلمدرسة")).toBe("امي الي اخر المدرسه");
    expect(normalizeArabic("  Dress   ")).toBe("dress");
    expect(normalizeArabic("مستشفى")).toBe("مستشفي");
  });
  it("maps Eastern and Persian digits and separators to ASCII", () => {
    expect(normalizeArabic("تحت ١٥٠٠")).toBe("تحت 1500");
    expect(normalizeArabic("۱٢٣٬٤٥٦٫٧")).toBe("123,456.7");
    expect(toAsciiDigits("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹")).toBe("01234567890123456789");
  });
  it("is idempotent and leaves no non-ASCII digits (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const once = normalizeArabic(s);
        expect(normalizeArabic(once)).toBe(once);
        expect(/[٠-٩۰-۹]/.test(once)).toBe(false);
      }),
      { numRuns: 400 },
    );
    const arabic = fc.string({ unit: fc.constantFrom(..."أإآىةًٌَُّـ٠١٢٣٤٥٦٧٨٩ابتثجح dress1500".split("")) });
    fc.assert(fc.property(arabic, (s) => normalizeArabic(normalizeArabic(s)) === normalizeArabic(s)), { numRuns: 400 });
  });
});

describe("tokenize", () => {
  it("splits on punctuation, keeps thousands-grouped numbers whole", () => {
    expect(tokenize("H&M، فستان 1,500 جنيه!")).toEqual(["h", "m", "فستان", "1500", "جنيه"]);
    expect(tokenize("...")).toEqual([]);
  });
});

describe("lexicon", () => {
  it("has no variant claimed by two groups and a complete shape", () => {
    expect(LEXICON_CONFLICTS).toEqual([]);
    expect(SYNONYM_VERSION).toBe(1);
    expect(GROUPS.length).toBeGreaterThan(60);
    for (const g of GROUPS) {
      expect(g.ar.length).toBeGreaterThan(0);
      expect(g.en.length).toBeGreaterThan(0);
    }
    expect(groupById("dress")?.kind).toBe("category");
    expect(groupById("nope")).toBeUndefined();
    expect(canonicalTerm("dress")).toBe("dress");
    expect(canonicalTerm("nope")).toBe("nope");
  });
});

describe("transliterateFranco", () => {
  it("round-trips the top 100 dictionary words with the Arabic form ranked first", () => {
    const top = FRANCO_WORDS.slice(0, 100);
    expect(top).toHaveLength(100);
    for (const w of top) {
      const [best] = transliterateFranco(w.franco);
      expect(best?.text, w.franco).toBe(w.arabic);
      expect(best?.source).toBe("dictionary");
    }
  });
  it("covers the documented examples", () => {
    expect(transliterateFranco("fostan")[0]?.text).toBe("فستان");
    expect(transliterateFranco("7egab")[0]?.text).toBe("حجاب");
    expect(transliterateFranco("FOSTAN")[0]?.text).toBe("فستان");
  });
  it("finds dictionary words one edit away with lower confidence", () => {
    const c = transliterateFranco("fostn");
    expect(c[0]).toMatchObject({ text: "فستان", source: "fuzzy" });
    expect(c[0]?.confidence).toBeLessThan(0.95);
  });
  it("falls back to rules for unknown words and ignores Arabic, digits and blanks", () => {
    const c = transliterateFranco("kobry");
    expect(c.map((x) => x.source)).toEqual(["rule", "rule"]);
    expect(c[0]?.confidence).toBeGreaterThan(c[1]?.confidence ?? 1);
    expect(transliterateFranco("sh5ra3a")[0]?.text).toContain("ش");
    expect(transliterateFranco("gheer")[0]?.text).toContain("غ");
    expect(transliterateFranco("aboo")).not.toHaveLength(0);
    expect(transliterateFranco("eman")[0]?.text.startsWith("ا")).toBe(true);
    expect(transliterateFranco("1500")).toEqual([]);
    expect(transliterateFranco("فستان")).toEqual([]);
    expect(transliterateFranco("  ")).toEqual([]);
  });
  it("levenshtein basics", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("abc", "abd")).toBe(1);
    expect(levenshtein("", "ab")).toBe(2);
  });
});

describe("parseBudget", () => {
  it.each([
    ["تحت ١٥٠٠", 150000n],
    ["under 1500", 150000n],
    ["a2al men 1500", 150000n],
    ["white dress less than 2,500 egp", 250000n],
    ["فستان اقل من ٣٠٠٠ جنيه", 300000n],
    ["jacket up to 1.5k", 150000n],
    ["shoes ta7t 800 gneh", 80000n],
    ["بنطلون لحد ۱۲۰۰", 120000n],
    ["dress 700 egp max", 70000n],
    ["under 99.5", 9950n],
  ])("%s -> %s piastres", (text, expected) => {
    expect(parseBudget(text)?.maxMinor).toBe(expected);
  });
  it("returns the remainder and null when there is no budget", () => {
    const b = parseBudget("فستان ابيض تحت ١٥٠٠");
    expect(b?.rest).toBe("فستان ابيض");
    expect(b?.matched).toBe("تحت 1500");
    expect(parseBudget("white dress")).toBeNull();
    expect(parseBudget("under 0")).toBeNull();
    expect(parseBudget("size 1500 dress")).toBeNull();
  });
});

describe("analyzeQuery", () => {
  it("ACCEPTANCE: Arabic and English queries produce equivalent filters", () => {
    const ar = analyzeQuery("فستان ابيض لينين تحت ١٥٠٠");
    const en = analyzeQuery("white linen dress under 1500");
    expect(ar.canonical).toBe(en.canonical);
    expect(ar.canonical).toBe("dress linen white");
    expect(ar.maxPriceMinor).toBe(150000n);
    expect(en.maxPriceMinor).toBe(150000n);
    expect(ar.engineQuery.split(" ").sort()).toEqual(en.engineQuery.split(" ").sort());
  });
  it("resolves Franco, mixed script, multi-word brands, fillers and the al- prefix", () => {
    expect(analyzeQuery("3ayez fostan abyad a2al men 1500").canonical).toBe("dress white");
    expect(analyzeQuery("dress ابيض").canonical).toBe("dress white");
    expect(analyzeQuery("h&m t-shirt").canonical).toBe("hm tshirt");
    expect(analyzeQuery("الفستان").canonical).toBe("dress");
    expect(analyzeQuery("i want 5 red dresses").canonical).toBe("dress red");
  });
  it("keeps unknown tokens when fuzzy is off and recovers typos when on", () => {
    expect(analyzeQuery("whte dres", { fuzzy: false }).unknown).toEqual(["whte", "dres"]);
    expect(analyzeQuery("whte dres").canonical).toBe("dress white");
    expect(analyzeQuery("xyzzy dress").unknown).toEqual(["xyzzy"]);
    expect(analyzeQuery("dress dress").concepts).toEqual(["dress"]);
  });
});

describe("normalize/relevance edge branches", () => {
  it("normalizeArabic reaches a fixed point and is idempotent for stacked decoration", () => {
    const x = "أأأآإٱ" + "ـ".repeat(3) + "ًٌٍ" + "ةى";
    expect(normalizeArabic(normalizeArabic(x))).toBe(normalizeArabic(x));
  });
  it("percentile / ndcg / isRelevant handle empty, clamped and price-capped inputs", async () => {
    const { percentile, ndcgAtK, isRelevant } = await import("../src/relevance.js");
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
    expect(percentile([1, 2, 3], 1000)).toBe(3);
    expect(ndcgAtK([], 0)).toBe(0);
    expect(ndcgAtK([true, false], 1)).toBe(1);
    const doc = { id: "1", titleAr: "فستان", titleEn: "Dress", category: "c", color: "", material: "", audience: "", brand: "", priceMinor: 500 } as never;
    const j = { queryId: "q", patterns: ["فستان|dress"], grade: 1, source: "synthetic" } as const;
    expect(isRelevant(doc, j)).toBe(true);
    expect(isRelevant(doc, j, 400)).toBe(false);
    expect(isRelevant(doc, j, 500)).toBe(true);
    expect(isRelevant(doc, { ...j, patterns: ["shoe"] })).toBe(false);
  });
});
