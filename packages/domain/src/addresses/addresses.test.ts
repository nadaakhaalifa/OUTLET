import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COURIER_CITY_OVERRIDES,
  COURIER_FIXTURES,
  COURIER_GOVERNORATE_EXCLUSIONS,
  GOVERNORATE_FIXTURES,
  addressQualityScore,
  dedupeKey,
  evaluateCoverage,
  firstNameOf,
  isCodEligible,
  isValidEgyptMapPin,
  normalizeEgPhone,
  promoteAfterDelete,
  type CoverageEntry,
} from "./index";

const seedEntries = (): CoverageEntry[] => {
  const out: CoverageEntry[] = [];
  for (const [courier, cod] of COURIER_FIXTURES) {
    for (const [gov] of GOVERNORATE_FIXTURES) {
      out.push({ courier, governorateCode: gov, cityCode: null, covered: !(COURIER_GOVERNORATE_EXCLUSIONS[courier] ?? []).includes(gov), codSupported: cod });
    }
  }
  for (const [courier, gov, city, covered] of COURIER_CITY_OVERRIDES) {
    out.push({ courier, governorateCode: gov, cityCode: city, covered, codSupported: courier === "bosta" });
  }
  return out;
};

describe("fixtures", () => {
  it("has the 27 governorates with unique codes, Arabic and English names and cities", () => {
    expect(GOVERNORATE_FIXTURES).toHaveLength(27);
    expect(new Set(GOVERNORATE_FIXTURES.map((g) => g[0])).size).toBe(27);
    for (const [, ar, en, cities] of GOVERNORATE_FIXTURES) {
      expect(/[؀-ۿ]/.test(ar)).toBe(true);
      expect(en.length).toBeGreaterThan(2);
      expect(cities.length).toBeGreaterThanOrEqual(2);
      for (const [c, car] of cities) {
        expect(c).toMatch(/^[a-z0-9-]+$/);
        expect(/[؀-ۿ]/.test(car)).toBe(true);
      }
    }
    const all = GOVERNORATE_FIXTURES.flatMap((g) => g[3].map((c) => `${g[0]}/${c[0]}`));
    expect(new Set(all).size).toBe(all.length);
  });
  it("override rows point at real cities", () => {
    for (const [, g, c] of COURIER_CITY_OVERRIDES) expect(GOVERNORATE_FIXTURES.find((x) => x[0] === g)?.[3].some((y) => y[0] === c)).toBe(true);
  });
});

describe("normalizeEgPhone", () => {
  it.each([
    ["01001234567", "+201001234567"],
    ["+20 100 123 4567", "+201001234567"],
    ["00201112345678", "+201112345678"],
    ["201201234567", "+201201234567"],
    ["٠١٥٠١٢٣٤٥٦٧", "+201501234567"],
  ])("%s", (i, o) => expect(normalizeEgPhone(i)).toBe(o));
  it.each(["", "0100123456", "01301234567", "+971501234567", "0100123456a", "0221234567", "+2001001234567"])("rejects %s", (i) =>
    expect(normalizeEgPhone(i)).toBeNull(),
  );
  it("is idempotent on its own output", () => {
    fc.assert(
      fc.property(fc.constantFrom("10", "11", "12", "15"), fc.integer({ min: 0, max: 99_999_999 }), (p, n) => {
        const e = normalizeEgPhone(`0${p}${String(n).padStart(8, "0")}`);
        expect(e).not.toBeNull();
        expect(normalizeEgPhone(e ?? "")).toBe(e);
      }),
    );
  });
});

describe("coverage", () => {
  const t = seedEntries();
  it("covers Cairo with COD and not New Valley", () => {
    expect(evaluateCoverage(t, "EG-C", "maadi")).toEqual({ coverage: "covered", codSupported: true });
    expect(evaluateCoverage(t, "EG-WAD", "kharga")).toEqual({ coverage: "not_covered", codSupported: false });
  });
  it("a city row overrides the governorate row", () => {
    expect(evaluateCoverage(t, "EG-BA", "marsa-alam").coverage).toBe("covered"); // aramex still covers
    expect(evaluateCoverage(t.filter((e) => e.courier === "bosta"), "EG-BA", "marsa-alam").coverage).toBe("not_covered");
    expect(evaluateCoverage(t.filter((e) => e.courier === "bosta"), "EG-BA", "hurghada").coverage).toBe("covered");
  });
  it("aramex alone covers but cannot collect COD", () => {
    expect(evaluateCoverage(t.filter((e) => e.courier === "aramex"), "EG-C", "maadi")).toEqual({ coverage: "covered", codSupported: false });
  });
  it("an empty table is unknown, never a guess", () => {
    expect(evaluateCoverage([], "EG-C", "maadi")).toEqual({ coverage: "unknown", codSupported: false });
  });
});

describe("cod, pin, quality", () => {
  const pin = { lat: 30.05, lng: 31.23 };
  it("COD needs landmark, pin, coverage and a COD courier", () => {
    const base = { landmark: "Next to the mosque", mapPin: pin, coverage: "covered" as const, codSupported: true };
    expect(isCodEligible(base)).toBe(true);
    expect(isCodEligible({ ...base, landmark: undefined })).toBe(false);
    expect(isCodEligible({ ...base, landmark: "  " })).toBe(false);
    expect(isCodEligible({ ...base, mapPin: undefined })).toBe(false);
    expect(isCodEligible({ ...base, coverage: "unknown" })).toBe(false);
    expect(isCodEligible({ ...base, codSupported: false })).toBe(false);
  });
  it("pin must be inside Egypt and finite", () => {
    expect(isValidEgyptMapPin(pin)).toBe(true);
    expect(isValidEgyptMapPin({ lat: 51.5, lng: -0.1 })).toBe(false);
    expect(isValidEgyptMapPin({ lat: Number.NaN, lng: 31 })).toBe(false);
  });
  it("quality is 0 for nothing, 100 for everything, always within 0..100 and monotone in fields", () => {
    expect(addressQualityScore({})).toBe(0);
    const full = { recipientName: "Nada K", phoneE164: "+201001234567", governorateCode: "EG-C", cityDistrictCode: "maadi", street: "Road 9", building: "4", floor: "2", apartment: "5", landmark: "Cafe", mapPin: pin };
    expect(addressQualityScore(full)).toBe(100);
    expect(addressQualityScore({ ...full, mapPin: undefined })).toBe(80);
    fc.assert(
      fc.property(fc.record({ street: fc.string(), landmark: fc.option(fc.string(), { nil: undefined }), building: fc.string() }), (r) => {
        const s = addressQualityScore(r);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(100);
      }),
    );
  });
});

describe("default rules and dedupe", () => {
  const rows = [
    { id: "a", createdAtMs: 1, isDefault: false },
    { id: "b", createdAtMs: 3, isDefault: false },
    { id: "c", createdAtMs: 2, isDefault: true },
  ];
  it("deleting the default promotes the most recent; deleting a non-default promotes nothing", () => {
    expect(promoteAfterDelete(rows, "c")).toBe("b");
    expect(promoteAfterDelete(rows, "a")).toBeNull();
    expect(promoteAfterDelete([rows[2] as (typeof rows)[number]], "c")).toBeNull();
    expect(promoteAfterDelete(rows, "zzz")).toBeNull();
  });
  it("dedupe key ignores case and spacing", () => {
    const a = dedupeKey({ governorateCode: "EG-C", cityDistrictCode: "maadi", street: "Road  9", building: "4" });
    const b = dedupeKey({ governorateCode: "EG-C", cityDistrictCode: "maadi", street: " road 9 ", building: "4", floor: "" });
    expect(a).toBe(b);
    expect(dedupeKey({ governorateCode: "EG-C", cityDistrictCode: "maadi", street: "Road 9", building: "5" })).not.toBe(a);
  });
  it("first name", () => {
    expect(firstNameOf(" Nada  Khalifa")).toBe("Nada");
    expect(firstNameOf("  ")).toBeNull();
  });
});
