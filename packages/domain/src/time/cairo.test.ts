import { describe, expect, it } from "vitest";
import { cairoDayBounds, cairoLocalToUtc, cairoParts, cairoWeekStart, nextCairoOccurrence } from "./cairo";

const iso = (ms: number): string => new Date(ms).toISOString();

describe("Cairo calendar days (ADR-0047 fixtures)", () => {
  it("2026-04-24 is the 23-hour spring day and starts at local 01:00 (22:00 UTC the day before)", () => {
    const d = cairoDayBounds(2026, 4, 24);
    expect(d.hours).toBe(23);
    expect(iso(d.startMs)).toBe("2026-04-23T22:00:00.000Z");
    expect(cairoParts(d.startMs).hour).toBe(1);
  });

  it("2026-10-29 is the 25-hour autumn day (local 23:00 occurs twice)", () => {
    const d = cairoDayBounds(2026, 10, 29);
    expect(d.hours).toBe(25);
    expect(iso(d.startMs)).toBe("2026-10-28T21:00:00.000Z");
    expect(iso(d.endMs)).toBe("2026-10-29T22:00:00.000Z");
    // The repeated local hour: the first 23:xx is UTC+3, the second is UTC+2.
    const first = Date.parse("2026-10-29T20:30:00Z");
    const second = Date.parse("2026-10-29T21:30:00Z");
    expect(cairoParts(first)).toMatchObject({ day: 29, hour: 23, minute: 30 });
    expect(cairoParts(second)).toMatchObject({ day: 29, hour: 23, minute: 30 });
  });

  it("the other 2027 transitions match: 2027-04-30 has 23 hours and 2027-10-28 has 25", () => {
    expect(cairoDayBounds(2027, 4, 30).hours).toBe(23);
    expect(cairoDayBounds(2027, 10, 28).hours).toBe(25);
  });

  it("ordinary days have 24 hours", () => {
    expect(cairoDayBounds(2026, 1, 15).hours).toBe(24);
    expect(cairoDayBounds(2026, 7, 15).hours).toBe(24);
    expect(cairoDayBounds(2026, 4, 23).hours).toBe(24);
    expect(cairoDayBounds(2026, 10, 28).hours).toBe(24);
  });

  it("consecutive days tile the timeline with no gap or overlap across both DST changes", () => {
    for (const [y, m, d] of [[2026, 4, 23], [2026, 10, 28]] as const) {
      const a = cairoDayBounds(y, m, d);
      const b = cairoDayBounds(y, m, d + 1);
      const c = cairoDayBounds(y, m, d + 2);
      expect(a.endMs).toBe(b.startMs);
      expect(b.endMs).toBe(c.startMs);
    }
  });

  it("a year has 8760 real hours across its days, or 8784 in a leap year", () => {
    for (const [year, expected] of [[2026, 8760], [2027, 8760], [2028, 8784]] as const) {
      let hours = 0;
      for (let ms = Date.UTC(year, 0, 1); ms < Date.UTC(year + 1, 0, 1); ms += 86_400_000) {
        const dt = new Date(ms);
        hours += cairoDayBounds(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()).hours;
      }
      expect(hours).toBe(expected);
    }
  });

  it("the skipped spring midnight resolves forward", () => {
    expect(iso(cairoLocalToUtc(2026, 4, 24, 0, 0))).toBe("2026-04-23T22:00:00.000Z");
  });
});

describe("Cairo week start (Saturday)", () => {
  it("a Saturday starts its own week", () => {
    // 2026-10-17 is a Saturday.
    expect(cairoWeekStart(cairoLocalToUtc(2026, 10, 17, 0, 0))).toEqual({ year: 2026, month: 10, day: 17 });
  });

  it("Friday belongs to the week that started the previous Saturday", () => {
    expect(cairoWeekStart(cairoLocalToUtc(2026, 10, 23, 18, 0))).toEqual({ year: 2026, month: 10, day: 17 });
  });

  it("uses the Cairo date, not the UTC date, near midnight", () => {
    // 2026-10-16 22:30 UTC is already 2026-10-17 01:30 in Cairo (UTC+3): a Saturday.
    expect(cairoWeekStart(Date.parse("2026-10-16T22:30:00Z"))).toEqual({ year: 2026, month: 10, day: 17 });
  });

  it("crosses a month boundary", () => {
    // 2026-11-02 is a Monday; the week started Saturday 2026-10-31.
    expect(cairoWeekStart(cairoLocalToUtc(2026, 11, 2, 12, 0))).toEqual({ year: 2026, month: 10, day: 31 });
  });
});

describe("nextCairoOccurrence (moved with the helper)", () => {
  it("finds the next 02:30 Cairo after a given instant", () => {
    const after = Date.parse("2026-10-16T12:00:00Z");
    expect(iso(nextCairoOccurrence(after, { hour: 2, minute: 30 }))).toBe("2026-10-16T23:30:00.000Z");
  });
});
