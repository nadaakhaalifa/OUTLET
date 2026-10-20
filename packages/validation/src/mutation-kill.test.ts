import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CursorSchema,
  DEFAULT_LOCALE,
  E164Schema,
  EgyptE164Schema,
  LocaleSchema,
  MoneySchema,
  NonNegativeMoneySchema,
  PageInfoSchema,
  UUID_V7_PATTERN,
  UuidSchema,
  UuidV7Schema,
  formatUuidV7,
  maskPhone,
  moneyToWire,
  toViolations,
} from "./index";

const messageOf = (r: { success: boolean; error?: z.ZodError }): string[] =>
  r.error === undefined ? [] : r.error.issues.map((i) => i.message);

describe("identifiers", () => {
  it("UUID_V7_PATTERN is anchored", () => {
    const id = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
    expect(UUID_V7_PATTERN.test(id)).toBe(true);
    expect(UUID_V7_PATTERN.test(`x${id}`)).toBe(false);
    expect(UUID_V7_PATTERN.test(`${id}x`)).toBe(false);
    expect(UUID_V7_PATTERN.test(`${id}\n`)).toBe(false);
  });
  it("UuidV7Schema message and normalisation", () => {
    expect(messageOf(UuidV7Schema.safeParse("nope"))).toEqual(["must be a UUIDv7"]);
    expect(UuidV7Schema.parse("0192F3A4-5B6C-7D8E-9F01-23456789ABCD")).toBe("0192f3a4-5b6c-7d8e-9f01-23456789abcd");
  });
  it("UuidSchema accepts any uuid version and lowercases", () => {
    expect(UuidSchema.parse("550E8400-E29B-41D4-A716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(UuidSchema.safeParse("550e8400").success).toBe(false);
  });
  it("formatUuidV7 produces exact bytes", () => {
    const r = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(formatUuidV7(0x0192f3a45b6c, r)).toBe("0192f3a4-5b6c-7102-8304-05060708090a");
    const ff = new Uint8Array(10).fill(0xff);
    expect(formatUuidV7(0x0192f3a45b6c, ff)).toBe("0192f3a4-5b6c-7fff-bfff-ffffffffffff");
    expect(formatUuidV7(2 ** 48 - 1, new Uint8Array(10))).toBe("ffffffff-ffff-7000-8000-000000000000");
    expect(formatUuidV7(0x010203040506, new Uint8Array(10))).toBe("01020304-0506-7000-8000-000000000000");
  });
  it("formatUuidV7 uses exactly the first 10 random bytes", () => {
    const long = new Uint8Array(16).fill(0xab);
    const short = new Uint8Array(10).fill(0xab);
    expect(formatUuidV7(5, long)).toBe(formatUuidV7(5, short));
    const r = new Uint8Array(10);
    r[9] = 0xcd;
    expect(formatUuidV7(0, r).endsWith("0000000000cd")).toBe(true);
  });
  it("formatUuidV7 validates input with messages and exact bounds", () => {
    expect(() => formatUuidV7(-1, new Uint8Array(10))).toThrow("unixMs must be an integer in [0, 2^48)");
    expect(() => formatUuidV7(2 ** 48, new Uint8Array(10))).toThrow("unixMs must be an integer in [0, 2^48)");
    expect(() => formatUuidV7(NaN, new Uint8Array(10))).toThrow(RangeError);
    expect(() => formatUuidV7(2 ** 53, new Uint8Array(10))).toThrow(RangeError);
    expect(() => formatUuidV7(0, new Uint8Array(9))).toThrow("random must provide at least 10 bytes");
    expect(() => formatUuidV7(0, new Uint8Array(10))).not.toThrow();
  });
});

describe("phone", () => {
  it("E.164 digit-count boundaries, anchors and message", () => {
    expect(E164Schema.safeParse("+1234567").success).toBe(true); // 7 digits
    expect(E164Schema.safeParse("+123456").success).toBe(false); // 6 digits
    expect(E164Schema.safeParse("+123456789012345").success).toBe(true); // 15 digits
    expect(E164Schema.safeParse("+1234567890123456").success).toBe(false); // 16 digits
    expect(E164Schema.safeParse("x+201001234567").success).toBe(false);
    expect(E164Schema.safeParse("+201001234567x").success).toBe(false);
    expect(messageOf(E164Schema.safeParse("1"))).toEqual(["must be an E.164 phone number"]);
  });
  it("Egypt allow-list anchors and message", () => {
    expect(EgyptE164Schema.safeParse("x+201001234567").success).toBe(false);
    expect(EgyptE164Schema.safeParse("+2010012345678").success).toBe(false);
    expect(EgyptE164Schema.safeParse("+201001234567").success).toBe(true);
    expect(messageOf(EgyptE164Schema.safeParse("+14155550100"))).toEqual(["must be an Egyptian E.164 phone number"]);
  });
  it("maskPhone keeps the last three digits and the length", () => {
    expect(maskPhone("+1234567")).toBe("*****567");
    expect(maskPhone("+201001234567")).toHaveLength(13);
  });
});

describe("money messages", () => {
  it("reports specific messages", () => {
    expect(messageOf(MoneySchema.safeParse({ amount: "1.5", currency: "EGP" }))).toEqual([
      "amount must be an integer string of minor units",
    ]);
    expect(messageOf(NonNegativeMoneySchema.safeParse({ amount: "-5", currency: "EGP" }))).toEqual([
      "amount must not be negative",
    ]);
    expect(moneyToWire({ amount: -12n, currency: "EGP" })).toEqual({ amount: "-12", currency: "EGP" });
    expect(MoneySchema.safeParse({ amount: "9".repeat(30), currency: "EGP" }).success).toBe(true);
    expect(MoneySchema.safeParse({ amount: "9".repeat(31), currency: "EGP" }).success).toBe(false);
  });
});

describe("pagination", () => {
  it("cursor message, padding limit and charset", () => {
    expect(messageOf(CursorSchema.safeParse("a b"))).toEqual(["cursor must be URL-safe base64"]);
    expect(CursorSchema.safeParse("abc==").success).toBe(true);
    expect(CursorSchema.safeParse("abc===").success).toBe(false);
    expect(CursorSchema.safeParse("ab=c").success).toBe(false);
    expect(CursorSchema.safeParse("a".repeat(512)).success).toBe(true);
    expect(CursorSchema.safeParse("a-b_c").success).toBe(true);
    expect(CursorSchema.safeParse("a+b").success).toBe(false);
  });
  it("PageInfoSchema is strict and typed", () => {
    expect(PageInfoSchema.parse({ next_cursor: null, has_more: false })).toEqual({ next_cursor: null, has_more: false });
    expect(PageInfoSchema.parse({ next_cursor: "abc", has_more: true }).next_cursor).toBe("abc");
    expect(PageInfoSchema.safeParse({ next_cursor: null, has_more: false, extra: 1 }).success).toBe(false);
    expect(PageInfoSchema.safeParse({ next_cursor: null }).success).toBe(false);
    expect(PageInfoSchema.safeParse({ has_more: true }).success).toBe(false);
    expect(PageInfoSchema.safeParse({ next_cursor: "a b", has_more: true }).success).toBe(false);
  });
});

describe("locale", () => {
  it("has exactly two wire locales and an Arabic default", () => {
    expect(DEFAULT_LOCALE).toBe("ar-EG");
    expect(LocaleSchema.options).toEqual(["ar-EG", "en"]);
    expect(LocaleSchema.safeParse("").success).toBe(false);
  });
});

describe("violations pointers", () => {
  const failing = (schema: z.ZodType, value: unknown): z.ZodError => {
    const r = schema.safeParse(value);
    if (r.success) throw new Error("expected failure");
    return r.error;
  };
  it("escapes ~ before / and joins array indices", () => {
    const schema = z.object({ "a~b": z.string(), "c/d": z.string(), "~/": z.string(), list: z.array(z.object({ x: z.number() })) });
    const err = failing(schema, { "a~b": 1, "c/d": 2, "~/": 3, list: [{ x: "s" }] });
    expect(toViolations(err)).toEqual([
      { pointer: "/a~0b", code: "invalid_type" },
      { pointer: "/c~1d", code: "invalid_type" },
      { pointer: "/~0~1", code: "invalid_type" },
      { pointer: "/list/0/x", code: "invalid_type" },
    ]);
  });
  it("uses an empty root by default and prefixes a given root", () => {
    const err = failing(z.object({ a: z.string() }), { a: 1 });
    expect(toViolations(err)).toEqual([{ pointer: "/a", code: "invalid_type" }]);
    expect(toViolations(err, "/query")).toEqual([{ pointer: "/query/a", code: "invalid_type" }]);
    expect(toViolations(failing(z.string(), 5))).toEqual([{ pointer: "", code: "invalid_type" }]);
  });
});
