import { describe, expect, it } from "vitest";
import {
  addMonths, canGoNext, canGoPrev, draftFromSelection, fromIso, initialView, isDayDisabled, localeDigits,
  monthMatrix, selectionFromDraft, toIso, weekdayOf, weekdayOrder, yearIndex, yearList,
} from "./dob-calendar";
import { daysInMonth } from "./dob";

const today = { year: 2026, month: 10, day: 12 };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe("dob-calendar", () => {
  it("knows real weekdays", () => {
    expect(weekdayOf(2026, 10, 12)).toBe(1); // Monday
    expect(weekdayOf(2000, 1, 1)).toBe(6); // Saturday
    expect(weekdayOf(1900, 1, 1)).toBe(1); // Monday
  });
  it("starts the week on Saturday", () => {
    expect(weekdayOrder()).toEqual([6, 0, 1, 2, 3, 4, 5]);
    expect(weekdayOrder(0)[0]).toBe(0);
  });
  it("Jan 2000 starts in the first Saturday column; Feb leap years", () => {
    expect(monthMatrix(2000, 1)[0]?.[0]).toBe(1);
    const flat = monthMatrix(2024, 2).flat().filter((x) => x !== null);
    expect(flat.length).toBe(29);
    expect(monthMatrix(1900, 2).flat().filter((x) => x !== null).length).toBe(28);
    expect(monthMatrix(2000, 2).flat().filter((x) => x !== null).length).toBe(29);
  });
  it("property: matrix has right day count, rows of 7 and the right first weekday", () => {
    const r = rng(7);
    for (let i = 0; i < 400; i += 1) {
      const y = 1900 + Math.floor(r() * 200);
      const m = 1 + Math.floor(r() * 12);
      const ws = Math.floor(r() * 7);
      const rows = monthMatrix(y, m, ws);
      expect(rows.every((row) => row.length === 7)).toBe(true);
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows.length).toBeLessThanOrEqual(6);
      const flat = rows.flat();
      const days = flat.filter((x): x is number => x !== null);
      expect(days).toEqual(Array.from({ length: daysInMonth(y, m) }, (_, k) => k + 1));
      const col = flat.indexOf(1);
      expect(weekdayOrder(ws)[col]).toBe(weekdayOf(y, m, 1));
      for (let d = 1; d <= days.length; d += 1) expect(weekdayOrder(ws)[flat.indexOf(d) % 7]).toBe(weekdayOf(y, m, d));
    }
  });
  it("navigates months across years", () => {
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 5, -17)).toEqual({ year: 2024, month: 12 });
  });
  it("bounds: future days and months disabled", () => {
    expect(isDayDisabled(2026, 10, 12, today)).toBe(false);
    expect(isDayDisabled(2026, 10, 13, today)).toBe(true);
    expect(isDayDisabled(2026, 11, 1, today)).toBe(true);
    expect(isDayDisabled(1899, 12, 31, today)).toBe(true);
    expect(canGoNext(2026, 10, today)).toBe(false);
    expect(canGoNext(2026, 9, today)).toBe(true);
    expect(canGoPrev(1900, 1)).toBe(false);
    expect(canGoPrev(1900, 2)).toBe(true);
  });
  it("opens near 25 years back when empty, on the selection otherwise", () => {
    expect(initialView(null, today)).toEqual({ year: 2001, month: 10 });
    expect(initialView({ year: 1990, month: 3, day: 4 }, today)).toEqual({ year: 1990, month: 3 });
  });
  it("converts draft and selection", () => {
    expect(selectionFromDraft("25031998", today)).toEqual({ year: 1998, month: 3, day: 25 });
    expect(selectionFromDraft("2503", today)).toBeNull();
    expect(selectionFromDraft("31022000", today)).toBeNull();
    expect(draftFromSelection({ year: 1998, month: 3, day: 5 }, today)).toBe("05031998");
    expect(draftFromSelection({ year: 2027, month: 1, day: 1 }, today)).toBeNull();
  });
  it("ISO round trip and rejects", () => {
    expect(toIso({ year: 1998, month: 3, day: 5 })).toBe("1998-03-05");
    expect(fromIso("1998-03-05")).toEqual({ year: 1998, month: 3, day: 5 });
    expect(fromIso("2023-02-29")).toBeNull();
    expect(fromIso("2024-02-29")).not.toBeNull();
    expect(fromIso("bad")).toBeNull();
  });
  it("locale digits and years", () => {
    expect(localeDigits(1998, "ar")).toBe("١٩٩٨");
    expect(localeDigits(1998, "en")).toBe("1998");
    const ys = yearList(2026);
    expect(ys[0]).toBe(2026);
    expect(ys[ys.length - 1]).toBe(1900);
    expect(ys[yearIndex(2001, 2026)]).toBe(2001);
  });
});
