import { describe, expect, it } from "vitest";
import { ageBlockKey, ageOn, checkSignCount, parseCalendarDate, type CalendarDate } from "./index";

const d = (s: string): CalendarDate => {
  const p = parseCalendarDate(s);
  if (p === null) throw new Error(`bad date ${s}`);
  return p;
};

describe("parseCalendarDate", () => {
  it("accepts valid dates and rejects impossible, malformed and ancient ones", () => {
    expect(parseCalendarDate("2000-02-29")).toEqual({ year: 2000, month: 2, day: 29 });
    for (const bad of ["2001-02-29", "2001-13-01", "2001-00-10", "2001-04-31", "01-01-2001", "2001-1-1", "1899-12-31", ""]) {
      expect(parseCalendarDate(bad), bad).toBeNull();
    }
  });
});

describe("ageOn", () => {
  it("turns 18 exactly on the birthday, not the day before", () => {
    expect(ageOn(d("2008-06-15"), d("2026-06-14"))).toBe(17);
    expect(ageOn(d("2008-06-15"), d("2026-06-15"))).toBe(18);
  });
  it("handles a 29 February birthday in a common year (completes on 1 March)", () => {
    expect(ageOn(d("2008-02-29"), d("2026-02-28"))).toBe(17);
    expect(ageOn(d("2008-02-29"), d("2026-03-01"))).toBe(18);
    expect(ageOn(d("2008-02-29"), d("2028-02-29"))).toBe(20);
  });
});

describe("ageBlockKey", () => {
  const secret = new Uint8Array(32).fill(7);
  it("is keyed: another secret gives another value, and kinds are domain separated", () => {
    const a = ageBlockKey(secret, "dob", "2010-01-01", "salt");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ageBlockKey(new Uint8Array(32).fill(8), "dob", "2010-01-01", "salt")).not.toBe(a);
    expect(ageBlockKey(secret, "device_id_hash", "2010-01-01", "salt")).not.toBe(a);
    expect(ageBlockKey(secret, "dob", "2010-01-01", "salt")).toBe(a);
  });
  it("is not a plain hash of the date of birth", () => {
    expect(ageBlockKey(secret, "dob", "2010-01-01")).not.toContain("2010");
  });
});

describe("checkSignCount", () => {
  it("allows increases and the counterless 0/0 case, rejects equal and lower values", () => {
    expect(checkSignCount(0, 0).ok).toBe(true);
    expect(checkSignCount(5, 6).ok).toBe(true);
    expect(checkSignCount(0, 1).ok).toBe(true);
    expect(checkSignCount(5, 5)).toEqual({ ok: false, reason: "sign_count_regression" });
    expect(checkSignCount(5, 2).ok).toBe(false);
    expect(checkSignCount(3, 0).ok).toBe(false);
  });
});
