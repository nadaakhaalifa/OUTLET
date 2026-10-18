import { describe, expect, it } from "vitest";
import { addresses } from "../../../../../packages/domain/src/index";
import { resources } from "../../../../../packages/i18n/src/index";
import { EGYPT_AREAS, EGYPT_GOVERNORATES, areaById, areasOfGovernorate, matchesArea, searchAreas, sortByName } from "./egypt-areas";

const { GOVERNORATE_FIXTURES } = addresses;
const { en, ar } = resources;

const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe("egypt dataset integrity", () => {
  it("has unique ids and valid parents", () => {
    expect(new Set(ids(EGYPT_AREAS)).size).toBe(EGYPT_AREAS.length);
    expect(new Set(ids(EGYPT_GOVERNORATES)).size).toBe(EGYPT_GOVERNORATES.length);
    for (const a of EGYPT_AREAS) expect(ids(EGYPT_GOVERNORATES)).toContain(a.governorateId);
  });
  it("has Arabic and English names everywhere", () => {
    for (const x of [...EGYPT_GOVERNORATES, ...EGYPT_AREAS]) { expect(x.ar.trim()).not.toBe(""); expect(x.en.trim()).not.toBe(""); }
  });
  it("governorates mirror the repo coverage codes (drift test)", () => {
    expect(EGYPT_GOVERNORATES.map((g) => [g.id, g.ar, g.en])).toEqual(GOVERNORATE_FIXTURES.map((g) => [g[0], g[1], g[2]]));
    expect(ids(EGYPT_GOVERNORATES)).toContain("EG-QH"); // repo code kept; ISO says EG-KB (see egypt-areas.ts)
  });
  it("area ids that exist in the repo keep the repo parent and slug", () => {
    for (const [gov, , , cities] of GOVERNORATE_FIXTURES) for (const [slug] of cities) {
      const a = areaById(slug);
      if (a !== undefined) expect(a.governorateId).toBe(gov);
    }
  });
  it("flags the rows the report marks UNVERIFIED", () => {
    for (const id of ["madinaty", "rehab-city", "mohandessin", "agouza", "haram", "hadayek-el-ahram", "faisal", "obour", "shubra-el-kheima", "smouha", "montaza", "agami", "borg-el-arab", "15th-may-city", "badr-city", "hurghada", "sharm-el-sheikh"]) {
      expect(areaById(id)?.verified, id).toBe(false);
    }
    for (const id of ["nasr-city", "heliopolis", "new-cairo", "fifth-settlement", "maadi", "zamalek", "6th-october", "sheikh-zayed", "dokki", "imbaba", "new-capital"]) {
      expect(areaById(id)?.verified, id).toBe(true);
    }
  });
  it("places Giza and Cairo areas as the report does", () => {
    expect(areasOfGovernorate("EG-GZ").map((a) => a.id)).toEqual(expect.arrayContaining(["6th-october", "sheikh-zayed", "dokki", "mohandessin", "agouza", "haram", "faisal", "hadayek-el-ahram", "imbaba"]));
    expect(areaById("shorouk")?.governorateId).toBe("EG-C");
    expect(areaById("obour")?.governorateId).toBe("EG-QH");
  });
});

describe("alias-aware search", () => {
  const find = (q: string) => searchAreas(EGYPT_AREAS, q).map((a) => a.id);
  it("finds 6th of October by Arabic, Franco and English spellings", () => {
    for (const q of ["سيتة اكتوبر", "سيته أكتوبر", "6th of october", "Sitta October", "6 اكتوبر", "السادس من اكتوبر"]) expect(find(q), q).toContain("6th-october");
  });
  it("finds Sheikh Zayed and Tagamoa", () => {
    expect(find("sheikh zayed")).toContain("sheikh-zayed");
    expect(find("الشيخ زايد")).toContain("sheikh-zayed");
    expect(find("tagamoa")).toContain("fifth-settlement");
    expect(find("مدينه نصر")).toContain("nasr-city");
  });
  it("empty query matches all and nonsense matches none", () => {
    expect(find("")).toHaveLength(EGYPT_AREAS.length);
    expect(find("zzzzqq")).toEqual([]);
    expect(matchesArea(areaById("maadi")!, "  ")).toBe(true);
  });
  it("matching by governorate name lists its areas", () => {
    expect(find("giza")).toEqual(expect.arrayContaining(ids(areasOfGovernorate("EG-GZ"))));
  });
});

describe("sortByName", () => {
  it("sorts without dropping or duplicating items in both locales", () => {
    for (const loc of ["ar", "en"] as const) {
      const out = sortByName(EGYPT_AREAS, loc);
      expect(ids(out).sort()).toEqual(ids(EGYPT_AREAS).sort());
    }
  });
  it("is deterministic and does not mutate the input", () => {
    const copy = [...EGYPT_AREAS];
    expect(sortByName(EGYPT_AREAS, "en")).toEqual(sortByName(copy, "en"));
    expect(EGYPT_AREAS).toEqual(copy);
  });
});

describe("filter i18n keys", () => {
  it("exist in both languages for every plural form", () => {
    const keys = ["appliedOne", "appliedTwo", "appliedFew", "appliedMany", "showOne", "showTwo", "showFew", "showMany", "showOther", "appliedOther", "showNone", "regionValue", "regionNote"] as const;
    for (const k of keys) { expect(en.storesDir.filter[k]).toBeTruthy(); expect(ar.storesDir.filter[k]).toBeTruthy(); }
    expect(ar.storesDir.filter.regionNote).toContain("{{product}}");
    expect(ar.storesDir.filter.regionValue).toBe("الدولة: مصر");
    // No launch promise ("not available yet") in either language.
    expect(ar.storesDir.filter.regionNote).not.toContain("بعد");
    expect(en.storesDir.filter.regionNote).not.toMatch(/not available yet|other countries/i);
    expect(en.storesDir.filter.regionNote).toBe("{{product}} currently serves Egypt only. Prices are in EGP.");
  });
});
