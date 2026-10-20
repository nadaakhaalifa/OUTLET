import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENSITY, DENSITIES, allowedDensities, anchorIndexAfterChange, cardDetailLevel, clamp, columnWidth, cycleDensity, detailDensityForWidth,
  imageWidthRequest, maxDensityForFontScale, parseDensity, pinchToDensity, serializeDensity, stepDenser, stepSparser,
} from "./model";

describe("steps and clamp", () => {
  it("clamps at both ends", () => {
    expect(stepDenser(4)).toBe(4);
    expect(stepSparser(1)).toBe(1);
    expect(stepDenser(2)).toBe(3);
    expect(stepSparser(3)).toBe(2);
    expect(clamp(9)).toBe(4);
    expect(clamp(-3)).toBe(1);
    expect(clamp(Number.NaN)).toBe(DEFAULT_DENSITY);
  });
  it("respects a cap", () => {
    expect(stepDenser(2, 2)).toBe(2);
    expect(clamp(4, 3)).toBe(3);
  });
});

describe("pinchToDensity", () => {
  it("does nothing inside the hysteresis band", () => {
    for (const s of [0.8, 0.9, 1, 1.1, 1.25]) expect(pinchToDensity(2, s)).toBe(2);
  });
  it("steps once past the thresholds", () => {
    expect(pinchToDensity(2, 1.26)).toBe(1);
    expect(pinchToDensity(2, 3)).toBe(1);
    expect(pinchToDensity(2, 0.79)).toBe(3);
    expect(pinchToDensity(2, 0.1)).toBe(3);
  });
  it("clamps and ignores bad scales", () => {
    expect(pinchToDensity(1, 2)).toBe(1);
    expect(pinchToDensity(4, 0.5)).toBe(4);
    expect(pinchToDensity(3, Number.NaN)).toBe(3);
    expect(pinchToDensity(3, 0.5, 3)).toBe(3);
  });
  it("always lands in range", () => {
    for (const d of DENSITIES) for (let s = 0; s < 4; s += 0.05) expect(DENSITIES).toContain(pinchToDensity(d, s));
  });
});

describe("font scale cap", () => {
  it("caps columns", () => {
    expect(maxDensityForFontScale(1)).toBe(4);
    expect(maxDensityForFontScale(1.29)).toBe(4);
    expect(maxDensityForFontScale(1.3)).toBe(3);
    expect(maxDensityForFontScale(1.49)).toBe(3);
    expect(maxDensityForFontScale(1.5)).toBe(2);
    expect(allowedDensities(2)).toEqual([1, 2]);
  });
});

describe("cycle", () => {
  it("goes 2 -> 3 -> 4 -> 1 -> 2", () => {
    expect(cycleDensity(2)).toBe(3);
    expect(cycleDensity(3)).toBe(4);
    expect(cycleDensity(4)).toBe(1);
    expect(cycleDensity(1)).toBe(2);
  });
  it("skips capped values", () => {
    expect(cycleDensity(2, 2)).toBe(1);
    expect(cycleDensity(1, 2)).toBe(2);
    expect(cycleDensity(3, 3)).toBe(1);
  });
});

describe("columnWidth at 390pt", () => {
  it("matches 358/175/114/84", () => {
    expect(columnWidth(390, 1, 8, 16)).toBe(358);
    expect(columnWidth(390, 2, 8, 16)).toBe(175);
    expect(columnWidth(390, 3, 8, 16)).toBe(114);
    expect(columnWidth(390, 4, 8, 16)).toBe(83); // 83.5 floored so rows never overflow
  });
  it("never negative", () => expect(columnWidth(10, 4, 8, 16)).toBe(0));
});

describe("card detail", () => {
  it("1 and 2 show everything with a full heart", () => {
    for (const d of [1, 2] as const) {
      const l = cardDetailLevel(d);
      expect(l).toMatchObject({ showStore: true, showName: true, showPrice: true, heart: "full" });
    }
  });
  it("3 has a small heart with a 44 target", () => {
    const l = cardDetailLevel(3);
    expect(l.nameLines).toBe(1);
    expect(l.showStore).toBe(false);
    expect(l.heartSize + 2 * l.heartHitSlop).toBeGreaterThanOrEqual(44);
  });
  it("4 is image and price only", () => {
    const l = cardDetailLevel(4);
    expect(l).toMatchObject({ showName: false, showStore: false, showPrice: true, heart: "longPress", heartSize: 0 });
  });
});

describe("imageWidthRequest", () => {
  it("scales with density and pixel ratio, bucketed", () => {
    expect(imageWidthRequest(4, 3)).toBe(256);
    expect(imageWidthRequest(2, 2)).toBe(384);
    expect(imageWidthRequest(1, 3)).toBeLessThanOrEqual(1200);
    expect(imageWidthRequest(2, 2, 100)).toBe(256);
    expect(imageWidthRequest(2, Number.NaN)).toBe(384);
  });
});

describe("persistence", () => {
  it("round-trips and falls back", () => {
    for (const d of DENSITIES) expect(parseDensity(serializeDensity(d))).toBe(d);
    for (const bad of [null, undefined, "", "0", "5", "abc", "2.5", "{}", "NaN"]) expect(parseDensity(bad)).toBe(2);
  });
});

describe("anchorIndexAfterChange", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("finds the item", () => expect(anchorIndexAfterChange(items, "c")).toBe(2));
  it("falls back to 0", () => {
    expect(anchorIndexAfterChange(items, "zzz")).toBe(0);
    expect(anchorIndexAfterChange(items, null)).toBe(0);
    expect(anchorIndexAfterChange([], "a")).toBe(0);
  });
});

describe("detail level from the card width (iPad)", () => {
  it("at the nominal phone widths the width rule equals the density's level (so nothing changes when it matches)", () => {
    expect(cardDetailLevel(detailDensityForWidth(358))).toEqual(cardDetailLevel(1));
    expect(cardDetailLevel(detailDensityForWidth(175))).toEqual(cardDetailLevel(2));
    expect(detailDensityForWidth(114)).toBe(3);
    expect(detailDensityForWidth(84)).toBe(4);
  });
  it("boundaries are monotonic: wider cards never show less", () => {
    const rank = { 2: 2, 3: 1, 4: 0 } as const;
    let prev = -1;
    for (let w = 0; w <= 500; w += 1) {
      const r = rank[detailDensityForWidth(w) as 2 | 3 | 4];
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(detailDensityForWidth(NaN)).toBe(DEFAULT_DENSITY);
  });
});

describe("iPad: the phone font-scale cap applies on compact only", () => {
  it("compact keeps the phone cap; zoomed windows skip it (the adaptive grid grows minCard instead)", () => {
    expect(maxDensityForFontScale(1.5)).toBe(2);
    expect(maxDensityForFontScale(1.5, false)).toBe(2);
    expect(maxDensityForFontScale(1.3, false)).toBe(3);
    expect(maxDensityForFontScale(1.5, true)).toBe(4);
    expect(allowedDensities(1.5)).toEqual([1, 2]);
    expect(allowedDensities(1.5, true)).toEqual([1, 2, 3, 4]);
  });
  it("image requests cap at 1600 px", () => {
    expect(imageWidthRequest(1, 3, 2000)).toBe(1600);
    expect(imageWidthRequest(2, 2, 400)).toBeLessThanOrEqual(1600);
  });
});
