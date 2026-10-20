import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inspectProperties, isPiiSafe, MAX_STRING_LENGTH } from "./pii";

const codes = (v: unknown): string[] => inspectProperties(v).map((x) => x.code);

describe("PII property policy", () => {
  it("accepts a flat bag of benign scalars", () => {
    expect(isPiiSafe({ product_id: "prod_fixture_001", quantity: 2, is_gift: false, tags: ["a", "b"], note_code: null })).toBe(
      false,
    ); // note_code contains forbidden token "note"
    expect(isPiiSafe({ product_id: "prod_fixture_001", quantity: 2, is_gift: false, tags: ["a", "b"] })).toBe(true);
  });

  it("accepts UUIDs and ULIDs despite their digit runs", () => {
    expect(isPiiSafe({ id: "0190a1b2-3c4d-7e5f-8a9b-0123456789ab" })).toBe(true);
    expect(isPiiSafe({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toBe(true);
  });

  it.each([
    ["email", { contact_ref: "a@b.co" }, "email_like_value"],
    ["Egyptian mobile", { contact_ref: "01012345678" }, "phone_like_value"],
    ["Arabic-Indic phone", { contact_ref: "٠١٠١٢٣٤٥٦٧٨" }, "phone_like_value"],
    ["spaced phone", { contact_ref: "+20 100 123 4567" }, "phone_like_value"],
    ["ipv4", { contact_ref: "192.168.1.20" }, "ip_like_value"],
    ["coordinates", { contact_ref: "30.0444, 31.2357" }, "coordinate_like_value"],
    ["jwt", { contact_ref: "eyJhbGciOi.eyJzdWIiOi.sig" }, "token_like_value"],
    ["bearer", { contact_ref: "Bearer abc123" }, "token_like_value"],
    ["long string", { contact_ref: "x".repeat(MAX_STRING_LENGTH + 1) }, "string_too_long"],
    ["huge integer", { contact_ref: 201012345678 }, "phone_like_value"],
  ])("rejects %s", (_label, bag, code) => {
    expect(codes(bag)).toContain(code);
  });

  it.each([
    ["email key", { email: "x" }],
    ["phone key", { phone: "x" }],
    ["address key", { delivery_address: "x" }],
    ["measurement key", { height_cm: 170 }],
    ["camelCase key", { productId: "x" }],
  ])("rejects forbidden keys: %s", (_l, bag) => {
    expect(isPiiSafe(bag)).toBe(false);
  });

  it("rejects nested objects, non-finite numbers, functions and non-objects", () => {
    expect(codes({ a: { b: 1 } })).toContain("nested_value");
    expect(codes({ a: [{ b: 1 }] })).toContain("nested_value");
    expect(codes({ a: Number.NaN })).toContain("unsupported_value_type");
    expect(codes({ a: () => 1 })).toContain("unsupported_value_type");
    expect(codes([1, 2])).toEqual(["not_an_object"]);
    expect(codes("x")).toEqual(["not_an_object"]);
    expect(codes(null)).toEqual(["not_an_object"]);
  });

  it("rejects oversize bags and arrays", () => {
    const big = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k_${i}`, 1]));
    expect(codes(big)).toContain("too_many_properties");
    expect(codes({ a: Array.from({ length: 51 }, () => 1) })).toContain("array_too_long");
  });

  it("property: any email-shaped string value is rejected wherever it sits", () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        fc.pre(email.length <= MAX_STRING_LENGTH);
        expect(isPiiSafe({ ref_value: email })).toBe(false);
        expect(isPiiSafe({ ref_value: [email] })).toBe(false);
      }),
    );
  });

  it("property: any run of 10+ ASCII digits is rejected", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{10,20}$/), (digits) => {
        expect(isPiiSafe({ ref_value: digits })).toBe(false);
      }),
    );
  });
});
