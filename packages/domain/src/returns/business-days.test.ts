import { describe, expect, it } from "vitest";
import { addBusinessDays } from "./business-days";

const utc = (s: string): number => Date.parse(s);

describe("addBusinessDays (Africa/Cairo, Friday and Saturday off)", () => {
  it("skips the weekend", () => {
    // Sunday 2026-10-11 10:00 Cairo, +5 working days = Sunday 2026-10-18 (Mon,Tue,Wed,Thu,Sun).
    expect(addBusinessDays(utc("2026-10-11T08:00:00Z"), 5)).toBe(utc("2026-10-18T08:00:00Z"));
  });
  it("counts from a Friday", () => {
    // Friday 2026-10-09 + 1 working day = Sunday 2026-10-11.
    expect(addBusinessDays(utc("2026-10-09T08:00:00Z"), 1)).toBe(utc("2026-10-11T08:00:00Z"));
  });
  it("zero days is the same instant and negatives throw", () => {
    expect(addBusinessDays(1000, 0)).toBe(1000);
    expect(() => addBusinessDays(0, -1)).toThrow();
  });
});
