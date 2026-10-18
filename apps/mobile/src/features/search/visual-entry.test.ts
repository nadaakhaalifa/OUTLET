import { describe, expect, it, vi } from "vitest";
import { visualSearchEntry } from "./visual-entry";

describe("visualSearchEntry", () => {
  it("hands out the handler only when the kill switch is known to be open", () => {
    const go = vi.fn();
    expect(visualSearchEntry(true, go)).toBe(go);
    expect(visualSearchEntry(false, go)).toBeUndefined();
    expect(visualSearchEntry(null, go)).toBeUndefined();
  });
});
