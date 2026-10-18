import { describe, expect, it } from "vitest";
import { METER_CSS, meterBucket, meterClass } from "./meter";

describe("meter buckets", () => {
  it("clamps and rounds to 5% steps", () => {
    expect(meterBucket(-1)).toBe(0);
    expect(meterBucket(0.5)).toBe(10);
    expect(meterBucket(0.52)).toBe(10);
    expect(meterBucket(0.58)).toBe(12);
    expect(meterBucket(7)).toBe(20);
    expect(meterBucket(Number.NaN)).toBe(0);
    expect(meterClass(1)).toBe("mw-20");
  });
  it("defines CSS for every bucket and uses no style attribute", () => {
    for (let i = 0; i <= 20; i++) expect(METER_CSS).toContain(`.mw-${i}{inline-size:${i * 5}%}`);
  });
});
