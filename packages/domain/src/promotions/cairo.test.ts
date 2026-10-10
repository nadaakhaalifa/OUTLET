import { describe, expect, it } from "vitest";
import { cairoDayKey, startOfCairoDayMs } from "./cairo";

describe("cairo calendar", () => {
  it("an instant just after 21:00 UTC in winter is already the next Cairo day", () => {
    // Cairo is UTC+2 in January
    expect(cairoDayKey(Date.UTC(2026, 0, 10, 21, 59, 59))).toBe("2026-01-10");
    expect(cairoDayKey(Date.UTC(2026, 0, 10, 22, 0, 0))).toBe("2026-01-11");
  });
  it("uses UTC+3 during Egyptian DST", () => {
    expect(cairoDayKey(Date.UTC(2026, 6, 10, 20, 59, 59))).toBe("2026-07-10");
    expect(cairoDayKey(Date.UTC(2026, 6, 10, 21, 0, 0))).toBe("2026-07-11");
  });
  it("finds the start of the Cairo day, including a DST change day", () => {
    const t = Date.UTC(2026, 0, 10, 12, 0, 0);
    expect(startOfCairoDayMs(t)).toBe(Date.UTC(2026, 0, 9, 22, 0, 0));
    const s = startOfCairoDayMs(Date.UTC(2026, 3, 24, 12, 0, 0));
    expect(cairoDayKey(s)).toBe(cairoDayKey(Date.UTC(2026, 3, 24, 12, 0, 0)));
    expect(cairoDayKey(s - 1)).not.toBe(cairoDayKey(s));
  });
});
