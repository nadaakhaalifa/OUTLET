import { describe, expect, it } from "vitest";
import {
  DOB_MIN_YEAR,
  applyDobInput,
  civilToday,
  daysInMonth,
  digitsOf,
  displayDobDraft,
  draftFromPicker,
  draftToFields,
  fieldsToDraft,
  formatDobDraft,
  isLeapYear,
  parseDobFields,
  pickerYears,
  validateDobDraft,
  EMPTY_DOB_FIELDS,
  INITIAL_ATTESTED,
} from "./dob";

const today = { year: 2026, month: 10, day: 10 };

/** Small deterministic PRNG so the property loops are reproducible (fast-check is not a mobile dep). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** Simulates a user typing character by character. */
function type(text: string, start = ""): string {
  let draft = start;
  for (const ch of text) draft = applyDobInput(draft, formatDobDraft(draft) + ch);
  return draft;
}

describe("dob mask", () => {
  it("keeps the fresh-install semantics", () => {
    expect(EMPTY_DOB_FIELDS).toEqual({ day: "", month: "", year: "" });
    expect(INITIAL_ATTESTED).toBe(false);
    expect(formatDobDraft("")).toBe("");
    expect(displayDobDraft("")).toBe("");
  });
  it("auto-inserts separators while typing and never shows a dangling one", () => {
    expect(formatDobDraft("2")).toBe("2");
    expect(formatDobDraft("25")).toBe("25");
    expect(formatDobDraft("250")).toBe("25 / 0");
    expect(formatDobDraft("2503199")).toBe("25 / 03 / 199");
    expect(formatDobDraft("25031998")).toBe("25 / 03 / 1998");
  });
  it("auto-pads a first digit that cannot start a day or a month", () => {
    expect(type("4")).toBe("04");
    expect(type("3")).toBe("3");
    expect(type("25")).toBe("25");
    expect(type("255")).toBe("2505");
    expect(type("251")).toBe("251");
    expect(type("25031998")).toBe("25031998");
    expect(type("1")).toBe("1");
    expect(type("5")).toBe("05");
  });
  it("types a full date digit by digit through the formatted text", () => {
    expect(type("15061995")).toBe("15061995");
    expect(type("7 3 1990".replace(/ /g, ""))).toBe("07" + "03" + "1990");
  });
  it("backspace removes one digit and never gets stuck on a separator", () => {
    let draft = "250319";
    draft = applyDobInput(draft, "25 / 03 / 1");
    expect(draft).toBe("25031");
    draft = applyDobInput(draft, "25 / 03 / ");
    expect(draft).toBe("2503");
    draft = applyDobInput(draft, "25 / 0");
    expect(draft).toBe("250");
  });
  it("caps at eight digits", () => {
    expect(applyDobInput("25031998", "25 / 03 / 19989")).toBe("25031998");
  });
  it("normalises Eastern Arabic and Persian digits", () => {
    expect(digitsOf("٢٥ / ٠٣ / ١٩٩٨")).toBe("25031998");
    expect(digitsOf("۲۵")).toBe("25");
    expect(applyDobInput("", "٢٥٠٣١٩٩٨")).toBe("25031998");
    expect(applyDobInput("", "٣/٥/١٩٩٨")).toBe("03051998");
  });
  it("handles paste with separators, unpadded parts and ISO order", () => {
    expect(applyDobInput("", "25/03/1998")).toBe("25031998");
    expect(applyDobInput("", "25-03-1998")).toBe("25031998");
    expect(applyDobInput("", "3.5.1998")).toBe("03051998");
    expect(applyDobInput("", " 1998-03-25 ")).toBe("25031998");
    expect(applyDobInput("", "25031998")).toBe("25031998");
  });
  it("ignores letters, bidi marks and symbols", () => {
    expect(applyDobInput("", "a‎2b5")).toBe("25");
    expect(applyDobInput("", displayDobDraft("25031998"))).toBe("25031998");
  });
  it("display text keeps the digits in order inside an RTL paragraph", () => {
    const shown = displayDobDraft("25031998");
    expect(shown.startsWith("⁦")).toBe(true);
    expect(shown.endsWith("⁩")).toBe(true);
    expect(digitsOf(shown)).toBe("25031998");
  });
  it("round-trips fields and draft", () => {
    expect(draftToFields("25031998")).toEqual({ day: "25", month: "03", year: "1998" });
    expect(draftToFields("250")).toEqual({ day: "25", month: "0", year: "" });
    expect(fieldsToDraft({ day: "25", month: "03", year: "1998" })).toBe("25031998");
    const parsed = parseDobFields(draftToFields("29022000"));
    expect(parsed).toEqual({ ok: true, dob: { year: 2000, month: 2, day: 29 } });
  });
});

describe("calendar rules", () => {
  it("leap years", () => {
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2023)).toBe(false);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(2023, 4)).toBe(30);
    expect(daysInMonth(2023, 12)).toBe(31);
  });
  it("29 February only in leap years", () => {
    expect(validateDobDraft("29022000", today).state).toBe("valid");
    expect(validateDobDraft("29021999", today)).toEqual({ state: "error", issue: "invalid_date" });
    expect(validateDobDraft("29021900", today)).toEqual({ state: "error", issue: "invalid_date" });
  });
  it("flags impossible days and months as soon as they are typed", () => {
    expect(validateDobDraft("32", today)).toEqual({ state: "error", issue: "invalid_day" });
    expect(validateDobDraft("00", today)).toEqual({ state: "error", issue: "invalid_day" });
    expect(validateDobDraft("1513", today)).toEqual({ state: "error", issue: "invalid_month" });
    expect(validateDobDraft("1500", today)).toEqual({ state: "error", issue: "invalid_month" });
    expect(validateDobDraft("3104", today)).toEqual({ state: "error", issue: "invalid_date" });
    expect(validateDobDraft("3004", today).state).toBe("partial");
  });
  it("progress states", () => {
    expect(validateDobDraft("", today)).toEqual({ state: "empty" });
    expect(validateDobDraft("2", today)).toEqual({ state: "partial" });
    expect(validateDobDraft("250319", today)).toEqual({ state: "partial" });
  });
  it("year range and future", () => {
    expect(validateDobDraft("01011899", today)).toEqual({ state: "error", issue: "year_range" });
    expect(validateDobDraft(`0101${DOB_MIN_YEAR}`, today).state).toBe("valid");
    expect(validateDobDraft("01012027", today)).toEqual({ state: "error", issue: "future" });
    expect(validateDobDraft("11102026", today)).toEqual({ state: "error", issue: "future" });
    expect(validateDobDraft("10102026", today).state).toBe("valid");
    expect(validateDobDraft("01112026", today)).toEqual({ state: "error", issue: "future" });
  });
  it("does not judge age: an under-18 date is a valid date for the age gate to refuse", () => {
    expect(validateDobDraft("01012015", today).state).toBe("valid");
  });
  it("civilToday reads UTC parts", () => {
    expect(civilToday(new Date("2026-10-10T23:00:00Z"))).toEqual(today);
  });
  it("picker helpers", () => {
    const years = pickerYears(2026);
    expect(years[0]).toBe(2026);
    expect(years[years.length - 1]).toBe(DOB_MIN_YEAR);
    expect(draftFromPicker(2023, 2, 31)).toBe("28022023");
    expect(draftFromPicker(2024, 2, 31)).toBe("29022024");
    expect(draftFromPicker(1995, 6, 5)).toBe("05061995");
  });
});

describe("properties (seeded)", () => {
  it("every real date round-trips: draft -> valid -> same civil date", () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i += 1) {
      const y = int(r, DOB_MIN_YEAR, today.year - 1);
      const m = int(r, 1, 12);
      const d = int(r, 1, daysInMonth(y, m));
      const draft = draftFromPicker(y, m, d);
      expect(type(draft)).toBe(draft);
      expect(validateDobDraft(draft, today)).toEqual({ state: "valid", dob: { year: y, month: m, day: d } });
      expect(parseDobFields(draftToFields(draft))).toEqual({ ok: true, dob: { year: y, month: m, day: d } });
    }
  });
  it("any day beyond the month length is rejected", () => {
    const r = rng(7);
    for (let i = 0; i < 1000; i += 1) {
      const y = int(r, DOB_MIN_YEAR, today.year - 1);
      const m = int(r, 1, 12);
      const dim = daysInMonth(y, m);
      if (dim === 31) continue;
      const d = int(r, dim + 1, 31);
      const draft = `${String(d).padStart(2, "0")}${String(m).padStart(2, "0")}${y}`;
      expect(validateDobDraft(draft, today).state).toBe("error");
    }
  });
  it("applyDobInput never yields more than 8 chars or non-digits, whatever the input", () => {
    const r = rng(99);
    const alphabet = "0123456789٠١٢٣٤٥٦٧٨٩۰۱ /-.abc‎⁦";
    for (let i = 0; i < 2000; i += 1) {
      const len = int(r, 0, 20);
      let text = "";
      for (let k = 0; k < len; k += 1) text += alphabet[int(r, 0, alphabet.length - 1)] ?? "";
      const prev = String(int(r, 0, 99999999)).slice(0, int(r, 0, 8));
      const out = applyDobInput(prev, text);
      expect(out).toMatch(/^\d{0,8}$/);
    }
  });
  it("formatting is idempotent through applyDobInput", () => {
    const r = rng(5);
    for (let i = 0; i < 1000; i += 1) {
      const draft = String(int(r, 0, 99999999)).padStart(int(r, 0, 8), "0").slice(0, 8);
      expect(applyDobInput(draft, displayDobDraft(draft))).toBe(draft);
    }
  });
});
