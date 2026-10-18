import { describe, expect, it } from "vitest";
import { cardsSideBySide, entranceMode, panelShare } from "./layout-mode";

describe("entranceMode", () => {
  it("compact is always the phone layout", () => expect(entranceMode("compact", 390)).toBe("phone"));
  it("band below 640 effective", () => {
    expect(entranceMode("regular", 431)).toBe("band");
    expect(entranceMode("regular", 598)).toBe("band");
    expect(entranceMode("regular", 639.9)).toBe("band");
  });
  it("split from 640 effective", () => {
    expect(entranceMode("expanded", 640)).toBe("split");
    expect(entranceMode("expanded", 798)).toBe("split");
  });
});
describe("panelShare", () => {
  it("42% below 760, 50% from 760", () => {
    expect(panelShare(692)).toBe(0.42);
    expect(panelShare(760)).toBe(0.5);
  });
});
describe("cardsSideBySide", () => {
  it("side by side from 500 effective content", () => {
    expect(cardsSideBySide(566)).toBe(true);
    expect(cardsSideBySide(451)).toBe(false);
  });
});
