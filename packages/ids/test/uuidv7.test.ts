import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { uuidv7, uuidV7Schema, uuidV7Timestamp } from "../src/index.js";

describe("uuidv7", () => {
  it("matches the UUIDv7 schema and embeds the timestamp", () => {
    const id = uuidv7(1_700_000_000_123);
    expect(uuidV7Schema.safeParse(id).success).toBe(true);
    expect(uuidV7Timestamp(id)).toBe(1_700_000_000_123);
  });

  it("is strictly increasing within one millisecond", () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7(1_800_000_000_000));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stays monotonic when the clock goes backwards", () => {
    const a = uuidv7(1_900_000_000_000);
    const b = uuidv7(1_900_000_000_000 - 5000);
    expect(b > a).toBe(true);
  });

  it("sorts by time across milliseconds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2_000_000_000_000, max: 2_000_000_100_000 }), fc.integer({ min: 1, max: 10_000 }), (t, d) => {
        const lo = uuidv7(t);
        expect(uuidv7(t + 100_000 + d) > lo).toBe(true);
      }),
    );
  });

  it("rejects out-of-range timestamps", () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(1.5)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
  });

  it("schema rejects other versions and uppercase", () => {
    expect(uuidV7Schema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(false);
    expect(uuidV7Schema.safeParse(uuidv7().toUpperCase()).success).toBe(false);
    expect(() => uuidV7Timestamp("nope")).toThrow();
  });

  it("works with the default clock", () => {
    expect(uuidV7Schema.safeParse(uuidv7()).success).toBe(true);
  });
});

describe("uuidv7 with a degenerate random source", () => {
  it("treats a missing counter seed as zero and still yields a valid id", async () => {
    const { vi } = await import("vitest");
    const real = crypto.getRandomValues.bind(crypto);
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: ArrayBufferView) =>
      a instanceof Uint16Array ? new Uint16Array(0) : real(a as Uint8Array<ArrayBuffer>)));
    try {
      const id = uuidv7(2_100_000_000_000);
      expect(uuidV7Schema.safeParse(id).success).toBe(true);
      expect(id.split("-")[2]).toMatch(/^7[0-9a-f]{3}$/);
    } finally {
      spy.mockRestore();
    }
  });
});
