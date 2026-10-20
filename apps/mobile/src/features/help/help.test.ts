import { describe, expect, it } from "vitest";
import { toggleFaq } from "./model";

describe("faq toggle", () => {
  it("opens one at a time and closes the open one", () => {
    expect(toggleFaq(null, "track")).toBe("track");
    expect(toggleFaq("track", "return")).toBe("return");
    expect(toggleFaq("return", "return")).toBeNull();
  });
});
