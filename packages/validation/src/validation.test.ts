import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CursorSchema,
  EgyptE164Schema,
  E164Schema,
  IdempotencyKeySchema,
  LocaleSchema,
  MoneySchema,
  NonNegativeMoneySchema,
  PaginationQuerySchema,
  UuidV7Schema,
  formatUuidV7,
  maskPhone,
  moneyToWire,
  toLanguage,
  toViolations,
} from "./index";

describe("money wire format", () => {
  it("parses an integer string to bigint minor units", () => {
    const m = MoneySchema.parse({ amount: "12345", currency: "EGP" });
    expect(m).toEqual({ amount: 12345n, currency: "EGP" });
  });

  it("rejects JSON numbers, decimals, exponents, padding, whitespace and other currencies", () => {
    for (const amount of [12345, "12.5", "1e3", "0123", " 1", "1 ", "", "+5", "--1", "0x10", "١٢٣"]) {
      expect(MoneySchema.safeParse({ amount, currency: "EGP" }).success, String(amount)).toBe(false);
    }
    expect(MoneySchema.safeParse({ amount: "1", currency: "USD" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount: "1", currency: "EGP", extra: 1 }).success).toBe(false);
  });

  it("round-trips any bigint without precision loss (beyond 2^53)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 29n), max: 10n ** 29n }), (n) => {
        const wire = moneyToWire({ amount: n, currency: "EGP" });
        expect(MoneySchema.parse(wire).amount).toBe(n);
      }),
    );
  });

  it("non-negative variant rejects negatives and keeps zero", () => {
    expect(NonNegativeMoneySchema.safeParse({ amount: "-1", currency: "EGP" }).success).toBe(false);
    expect(NonNegativeMoneySchema.parse({ amount: "0", currency: "EGP" }).amount).toBe(0n);
  });
});

describe("UUIDv7", () => {
  it("accepts well formed v7 and normalises case", () => {
    const id = "0192F3A4-5B6C-7D8E-9F01-23456789ABCD";
    expect(UuidV7Schema.parse(id)).toBe(id.toLowerCase());
    expect(IdempotencyKeySchema.safeParse(id).success).toBe(true);
  });

  it("rejects v4, wrong variant and junk", () => {
    expect(UuidV7Schema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(false);
    expect(UuidV7Schema.safeParse("0192f3a4-5b6c-7d8e-cf01-23456789abcd").success).toBe(false);
    expect(UuidV7Schema.safeParse("not-a-uuid").success).toBe(false);
    expect(UuidV7Schema.safeParse("").success).toBe(false);
  });

  it("formatUuidV7 always produces a valid v7 that sorts by time", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 48 - 1 }),
        fc.uint8Array({ minLength: 10, maxLength: 16 }),
        (t, r) => {
          expect(UuidV7Schema.safeParse(formatUuidV7(t, r)).success).toBe(true);
        },
      ),
    );
    const zero = new Uint8Array(10);
    expect(formatUuidV7(1000, zero) < formatUuidV7(1001, zero)).toBe(true);
    expect(formatUuidV7(0, zero)).toBe("00000000-0000-7000-8000-000000000000");
  });

  it("formatUuidV7 rejects bad time and short entropy", () => {
    expect(() => formatUuidV7(-1, new Uint8Array(10))).toThrow(RangeError);
    expect(() => formatUuidV7(1.5, new Uint8Array(10))).toThrow(RangeError);
    expect(() => formatUuidV7(0, new Uint8Array(9))).toThrow(RangeError);
  });
});

describe("phone", () => {
  it("validates E.164 and the Egypt allow-list", () => {
    expect(E164Schema.safeParse("+201001234567").success).toBe(true);
    expect(E164Schema.safeParse("01001234567").success).toBe(false);
    expect(E164Schema.safeParse("+0123456789").success).toBe(false);
    expect(E164Schema.safeParse("+201001234567 ").success).toBe(false);
    expect(EgyptE164Schema.safeParse("+201001234567").success).toBe(true);
    expect(EgyptE164Schema.safeParse("+14155550100").success).toBe(false);
    expect(EgyptE164Schema.safeParse("+20100123456").success).toBe(false);
  });

  it("masks all but the last three digits", () => {
    expect(maskPhone("+201001234567")).toBe("**********567");
    expect(() => maskPhone("garbage")).toThrow();
  });
});

describe("locale and pagination", () => {
  it("locale is ar-EG or en and maps to language", () => {
    expect(LocaleSchema.safeParse("ar-EG").success).toBe(true);
    expect(LocaleSchema.safeParse("fr").success).toBe(false);
    expect(toLanguage("ar-EG")).toBe("ar");
    expect(toLanguage("en")).toBe("en");
  });

  it("pagination defaults to 20, coerces strings and caps at 50", () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(PaginationQuerySchema.parse({ limit: "50" }).limit).toBe(50);
    expect(PaginationQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ limit: "1.5" }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it("cursor is opaque url-safe base64 bounded to 512", () => {
    expect(CursorSchema.safeParse("eyJhIjoxfQ").success).toBe(true);
    expect(CursorSchema.safeParse("a b").success).toBe(false);
    expect(CursorSchema.safeParse("a".repeat(513)).success).toBe(false);
    expect(CursorSchema.safeParse("").success).toBe(false);
  });
});

describe("violations", () => {
  it("emits JSON pointers and codes but never the offending value", () => {
    const schema = z.object({ a: z.object({ "b/c": z.string() }) });
    const r = schema.safeParse({ a: { "b/c": "secret-value-123456" } as unknown as { "b/c": string } });
    expect(r.success).toBe(true);
    const bad = schema.safeParse({ a: { "b/c": 5 } });
    if (bad.success) throw new Error("expected failure");
    const v = toViolations(bad.error, "/body");
    expect(v).toEqual([{ pointer: "/body/a/b~1c", code: "invalid_type" }]);
    expect(JSON.stringify(v)).not.toContain("5");
  });
});
