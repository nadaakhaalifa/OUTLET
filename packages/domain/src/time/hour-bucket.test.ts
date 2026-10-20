import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cairoDayBounds } from "./cairo";
import { cairoHourBucket } from "./hour-bucket";

const HOUR = 3_600_000;

describe("cairoHourBucket (rollup row labels)", () => {
  it("winter is UTC+2 and summer UTC+3", () => {
    expect(cairoHourBucket(Date.parse("2026-01-15T10:20:00Z"))).toEqual({ hourUtcMs: Date.parse("2026-01-15T10:00:00Z"), cairoDate: "2026-01-15", cairoHour: 12, utcOffsetMin: 120 });
    expect(cairoHourBucket(Date.parse("2026-07-15T10:20:00Z"))).toMatchObject({ cairoDate: "2026-07-15", cairoHour: 13, utcOffsetMin: 180 });
  });

  it("the skipped spring hour does not exist: 2026-04-24 starts at local 01:00", () => {
    const b = cairoHourBucket(Date.parse("2026-04-23T22:10:00Z"));
    expect(b).toMatchObject({ cairoDate: "2026-04-24", cairoHour: 1, utcOffsetMin: 180 });
    expect(cairoHourBucket(Date.parse("2026-04-23T21:59:00Z"))).toMatchObject({ cairoDate: "2026-04-23", cairoHour: 23, utcOffsetMin: 120 });
  });

  it("the repeated autumn hour appears twice with different offsets (2026-10-29 local 23:00)", () => {
    const first = cairoHourBucket(Date.parse("2026-10-29T20:30:00Z"));
    const second = cairoHourBucket(Date.parse("2026-10-29T21:30:00Z"));
    expect(first).toMatchObject({ cairoDate: "2026-10-29", cairoHour: 23, utcOffsetMin: 180 });
    expect(second).toMatchObject({ cairoDate: "2026-10-29", cairoHour: 23, utcOffsetMin: 120 });
    expect(first.hourUtcMs).not.toBe(second.hourUtcMs);
  });

  it("property: every instant maps to one UTC hour whose day bucket matches cairoDayBounds", () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2028, 0, 1) }), (ms) => {
        const b = cairoHourBucket(ms);
        expect(b.hourUtcMs % HOUR).toBe(0);
        expect(ms - b.hourUtcMs).toBeLessThan(HOUR);
        expect(b.cairoHour).toBeGreaterThanOrEqual(0);
        expect(b.cairoHour).toBeLessThanOrEqual(23);
        const [y, m, d] = b.cairoDate.split("-").map(Number) as [number, number, number];
        const day = cairoDayBounds(y, m, d);
        expect(b.hourUtcMs).toBeGreaterThanOrEqual(day.startMs);
        expect(b.hourUtcMs).toBeLessThan(day.endMs);
      }),
      { numRuns: 1000 },
    );
  });
});
