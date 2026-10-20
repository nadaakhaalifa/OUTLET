import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../domain/sha256";

describe("pure sha256", () => {
  it("matches node:crypto for edge lengths and non-ASCII input", () => {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const s = "a".repeat(n);
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }
    const u = "analytics-event:v1\0type\0مفتاح-🙂";
    expect(sha256Hex(u)).toBe(createHash("sha256").update(u).digest("hex"));
  });
});
