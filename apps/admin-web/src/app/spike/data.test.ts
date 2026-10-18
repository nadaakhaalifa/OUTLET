import { describe, expect, it } from "vitest";
import { DAYPARTS, HEAT, WEEKDAYS, heatSummary } from "./data";

describe("heatSummary", () => {
  it("is computed from the data: 12-16 is the peak on four of seven weekdays (not 'evening on every weekday')", () => {
    const peaks = HEAT.map((row) => DAYPARTS[row.indexOf(Math.max(...row))]);
    expect(peaks.filter((p) => p === "12-16")).toHaveLength(4);
    const s = heatSummary();
    expect(s).toContain("12-16 on 4 of 7 weekdays");
    expect(s).not.toMatch(/every weekday/i);
    for (let i = 0; i < WEEKDAYS.length; i++) expect(s).toContain(`${WEEKDAYS[i]} ${peaks[i]}`);
  });
  it("follows other data", () => {
    const all = WEEKDAYS.map(() => DAYPARTS.map((_, h) => (h === 5 ? 9 : 1)));
    expect(heatSummary(all)).toContain("20-24 on 7 of 7 weekdays");
  });
});
