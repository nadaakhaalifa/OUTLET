import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_FACETS,
  canonicalizeFilter,
  capSponsored,
  SponsoredRanker,
  countFacets,
  didYouMean,
  expandKeyword,
  lookupConcept,
  normalizeDigits,
  normalizeSearchText,
  parseEgpAmount,
  parseSearchQuery,
  relaxOnce,
  sponsoredInTop,
  tokenize,
  type SearchFilter,
} from "./index";

describe("normalizeSearchText", () => {
  it("folds alef, ya, ta marbuta, diacritics, tatweel and digits", () => {
    expect(normalizeSearchText("أَبْيَض")).toBe("ابيض");
    expect(normalizeSearchText("إسلام آمنة")).toBe("اسلام امنه");
    expect(normalizeSearchText("مصـــر")).toBe("مصر");
    expect(normalizeSearchText("فستان ١٥٠٠ و۱۲۳")).toBe("فستان 1500 و123");
    expect(normalizeSearchText("  FOSTAN   Abyad  ")).toBe("fostan abyad");
    expect(normalizeSearchText("هدية")).toBe(normalizeSearchText("هديه"));
    expect(normalizeSearchText("على")).toBe(normalizeSearchText("علي"));
  });
  it("keeps number separators and drops other punctuation", () => {
    expect(normalizeSearchText("تحت ١٬٥٠٠!!")).toBe("تحت 1,500");
    expect(normalizeSearchText("dress, (white)")).toBe("dress, white");
  });
  it("is idempotent for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const once = normalizeSearchText(s);
        expect(normalizeSearchText(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[؀-ۿa-zA-Z0-9 ,.ـ]{0,40}$/u), (s) => {
        const once = normalizeSearchText(s);
        expect(normalizeSearchText(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });
  it("never contains the folded-away characters", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        expect(normalizeSearchText(s)).not.toMatch(/[ً-ٟـآأإةى٠-٩]/u);
      }),
      { numRuns: 300 },
    );
  });
  it("normalizeDigits only touches digits", () => {
    expect(normalizeDigits("a٣b۴")).toBe("a3b4");
  });
  it("tokenize trims separators", () => {
    expect(tokenize("1,500. dress ,")).toEqual(["1,500", "dress"]);
  });
});

describe("lexicon", () => {
  it("fostan, fustan, فستان, الفستان and dress are one concept", () => {
    for (const w of ["fostan", "fustan", "فستان", "الفستان", "Dress", "fostaan"]) {
      expect(lookupConcept(w)?.id, w).toBe("dress");
    }
  });
  it("expands a canonical id to AR, EN and Franco forms", () => {
    const forms = expandKeyword("dress");
    expect(forms).toContain("فستان");
    expect(forms).toContain("dress");
    expect(forms).toContain("fostan");
  });
  it("unknown words are not concepts", () => {
    expect(lookupConcept("zzzz")).toBeNull();
  });
});

describe("parseEgpAmount", () => {
  it.each([
    ["1500", 150000n],
    ["1,500", 150000n],
    ["1.5k", 150000n],
    ["2k", 200000n],
    ["99.5", 9950n],
  ])("%s", (t, v) => {
    expect(parseEgpAmount(t)).toBe(v);
  });
  it("rejects garbage and out of range", () => {
    expect(parseEgpAmount("abc")).toBeNull();
    expect(parseEgpAmount("99999999999")).toBeNull();
    expect(parseEgpAmount("1.234")).toBeNull();
  });
});

describe("parseSearchQuery", () => {
  const ar = parseSearchQuery("فستان ابيض لينين تحت ١٥٠٠");
  const en = parseSearchQuery("white linen dress under 1500");
  it("Arabic and English queries are equivalent (spec 4 acceptance)", () => {
    expect(ar.filter).toEqual(en.filter);
    expect(ar.keywords).toBe(en.keywords);
    expect(en.filter).toEqual({ colors: ["white"], materials: ["linen"], priceMax: 150000n });
    expect(en.keywords).toBe("dress");
    expect(ar.unparsed).toEqual([]);
  });
  it("Franco and mixed script are equivalent too", () => {
    const fr = parseSearchQuery("fostan abyad linen taht 1500 egp");
    expect(fr.filter).toEqual(en.filter);
    expect(fr.keywords).toBe("dress");
    const mixed = parseSearchQuery("dress أبيض 1500 under");
    expect(mixed.keywords).toBe("dress");
  });
  it("handles min, ranges, flags and Arabic ranges", () => {
    expect(parseSearchQuery("shoes over 500").filter).toEqual({ priceMin: 50000n });
    expect(parseSearchQuery("shoes between 500 and 900").filter).toEqual({ priceMin: 50000n, priceMax: 90000n });
    expect(parseSearchQuery("جزمه من ٥٠٠ الي ٩٠٠").filter).toEqual({ priceMin: 50000n, priceMax: 90000n });
    expect(parseSearchQuery("جزمة my size installments").filter).toEqual({ mySizeOnly: true, installmentsAvailable: true });
  });
  it("keeps unknown words and bare numbers as keywords", () => {
    expect(parseSearchQuery("nike air 270").keywords).toBe("nike air 270");
  });
  it("reports markers with no number", () => {
    const p = parseSearchQuery("dress under");
    expect(p.unparsed).toEqual(["under"]);
    expect(p.filter).toEqual({});
  });
  it("never produces a number from out-of-range input", () => {
    expect(parseSearchQuery("dress under 999999999999").filter.priceMax).toBeUndefined();
  });
  it("is total and bounded for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const p = parseSearchQuery(s);
        expect(countFacets(p.filter)).toBeLessThanOrEqual(MAX_FACETS);
      }),
      { numRuns: 300 },
    );
  });
});

describe("filter rules", () => {
  it("counts scalar facets and array elements", () => {
    const f: SearchFilter = { priceMax: 1n, colors: ["red", "blue"], newArrivals: true };
    expect(countFacets(f)).toBe(4);
  });
  it("canonical form sorts and dedupes", () => {
    expect(canonicalizeFilter({ colors: ["red", "blue", "red"] })).toEqual({ colors: ["blue", "red"] });
  });
  it("relaxes least important first and never touches hard constraints", () => {
    let f: SearchFilter = { priceMax: 100n, mySizeOnly: true, world: "local", colors: ["red"], newArrivals: true, minRating: 4 };
    const dropped: string[] = [];
    for (let r = relaxOnce(f); r !== null; r = relaxOnce(f)) {
      dropped.push(r.dropped);
      f = r.filter;
    }
    expect(dropped).toEqual(["newArrivals", "minRating", "colors"]);
    expect(f).toEqual({ priceMax: 100n, mySizeOnly: true, world: "local" });
  });
});

describe("capSponsored", () => {
  const item = (id: number, sponsored: boolean) => ({ id, sponsored });
  it("moves extra sponsored items below the top 10", () => {
    const items = Array.from({ length: 14 }, (_, i) => item(i, i < 4));
    const out = capSponsored(items);
    expect(sponsoredInTop(out)).toBe(2);
    expect(out.map((x) => x.id).sort((a, b) => a - b)).toEqual(items.map((x) => x.id));
    expect(out.slice(0, 10).map((x) => x.id)).toEqual([0, 1, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
  it("property: cap holds, nothing lost, organic order kept", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 60 }), (flags) => {
        const items = flags.map((s, id) => ({ id, sponsored: s }));
        const out = capSponsored(items);
        expect(sponsoredInTop(out)).toBeLessThanOrEqual(2);
        const organic = out.filter((x) => !x.sponsored).map((x) => x.id);
        expect(organic).toEqual(items.filter((x) => !x.sponsored).map((x) => x.id));
        expect(new Set(out.map((x) => x.id)).size).toBe(out.length);
      }),
    );
  });
});

describe("didYouMean", () => {
  it("corrects near misses", () => {
    expect(didYouMean("fostn")).toBe("fostan");
    expect(didYouMean("white dreas")).toBe("white dress");
  });
  it("returns null for known words, numbers and unknown far words", () => {
    expect(didYouMean("dress 1500")).toBeNull();
    expect(didYouMean("qqqqqqqq")).toBeNull();
  });
});

describe("SponsoredRanker (global, cross-page cap)", () => {
  type It = { id: number; sponsored: boolean };
  const itemsArb = fc
    .array(fc.boolean(), { minLength: 0, maxLength: 80 })
    .map((flags): It[] => flags.map((sponsored, id) => ({ id, sponsored })));

  /** Pages through `items` with page sizes cycling through `sizes`, resuming from serialized state. */
  function paged(items: It[], sizes: number[]): It[] {
    const out: It[] = [];
    let state = { emitted: 0, sponsoredTop: 0 };
    let deferred: It[] = [];
    let pos = 0;
    for (let page = 0; page < 500; page += 1) {
      const limit = sizes[page % sizes.length] ?? 5;
      const r = new SponsoredRanker<It>(state, deferred);
      const got: It[] = [];
      const drain = () => {
        while (got.length < limit) {
          const d = r.nextDeferred();
          if (d === null) return;
          got.push(d);
        }
      };
      drain();
      while (got.length < limit && pos < items.length) {
        const it = items[pos++] as It;
        const e = r.offer(it);
        if (e !== null) got.push(e);
        drain();
      }
      out.push(...got);
      state = r.state;
      deferred = [...r.deferred];
      if (got.length === 0 && pos >= items.length) break;
    }
    return out;
  }

  it("never more than 2 sponsored in first 10, stable across any page sizes, organic order kept", () => {
    fc.assert(
      fc.property(itemsArb, fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 5 }), (items, sizes) => {
        const out = paged(items, sizes);
        expect(out.slice(0, 10).filter((i) => i.sponsored).length).toBeLessThanOrEqual(2);
        for (let start = 0; start + 10 <= out.length && start === 0; start += 1) {
          expect(out.slice(start, start + 10).filter((i) => i.sponsored).length).toBeLessThanOrEqual(2);
        }
        // identical to a single huge page
        expect(out).toEqual(paged(items, [1000]));
        // no duplicates, organic order preserved and never dropped
        expect(new Set(out.map((i) => i.id)).size).toBe(out.length);
        const organicIn = items.filter((i) => !i.sponsored).map((i) => i.id);
        expect(out.filter((i) => !i.sponsored).map((i) => i.id)).toEqual(organicIn);
        // sponsored keep relative order
        const sp = out.filter((i) => i.sponsored).map((i) => i.id);
        expect(sp).toEqual([...sp].sort((a, b) => a - b));
      }),
      { numRuns: 300 },
    );
  });
});
