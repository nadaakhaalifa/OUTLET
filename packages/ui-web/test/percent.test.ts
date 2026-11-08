import { describe, expect, it } from "vitest";
import { floorPercent } from "../src/percent.js";

describe("floorPercent", () => {
  it("floors (never rounds up into a larger claim)", () => {
    expect(floorPercent(1n, 3n)).toBe(33);
    expect(floorPercent(2n, 3n)).toBe(66);
    expect(floorPercent(199n, 200n)).toBe(99);
    expect(floorPercent(50n, 100n)).toBe(50);
  });
  it("is 0 for a zero or negative part or whole (no divide by zero)", () => {
    expect(floorPercent(0n, 100n)).toBe(0);
    expect(floorPercent(-5n, 100n)).toBe(0);
    expect(floorPercent(5n, 0n)).toBe(0);
    expect(floorPercent(5n, -10n)).toBe(0);
  });
  it("clamps to 100 and handles amounts beyond Number precision", () => {
    expect(floorPercent(300n, 100n)).toBe(100);
    expect(floorPercent(100n, 100n)).toBe(100);
    expect(floorPercent(10n ** 30n, 4n * 10n ** 30n)).toBe(25);
  });
});
