import { describe, expect, it } from "vitest";
import { PromotionError, cairoDateWindow, cairoMidnight } from "../src/index.js";

describe("cairo date handling", () => {
  it("uses +2h in winter and +3h during Egypt DST", () => {
    expect(cairoMidnight("2026-01-15").toISOString()).toBe("2026-01-14T22:00:00.000Z");
    expect(cairoMidnight("2026-07-15").toISOString()).toBe("2026-07-14T21:00:00.000Z");
  });
  it("rejects malformed and impossible dates", () => {
    expect(() => cairoMidnight("15-01-2026")).toThrow(PromotionError);
    expect(() => cairoMidnight("2026-02-30")).toThrow(PromotionError);
    expect(() => cairoMidnight("")).toThrow(/bad date/);
  });
  it("window is inclusive of the last day, exclusive of the next midnight", () => {
    const w = cairoDateWindow("2026-01-01", "2026-01-01");
    expect(w.endsAt.getTime() - w.startsAt.getTime()).toBe(24 * 3600_000);
  });
  it("rejects an inverted window and a bad end date", () => {
    expect(() => cairoDateWindow("2026-01-05", "2026-01-01")).toThrow(/ends before/);
    expect(() => cairoDateWindow("2026-01-01", "nope")).toThrow(PromotionError);
  });
  it("spans the DST change correctly", () => {
    const w = cairoDateWindow("2026-04-23", "2026-04-25");
    expect(w.endsAt.getTime() - w.startsAt.getTime()).toBeGreaterThanOrEqual(71 * 3600_000);
  });
});
