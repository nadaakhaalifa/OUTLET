import { describe, expect, it } from "vitest";
import { maskPhone, normalizeCode, normalizeEgPhone, toWesternDigits } from "../src/lib/phone";
import { uuidv7 } from "../src/lib/uuid7";

describe("normalizeEgPhone", () => {
  it.each([["01012345678", "+201012345678"], ["+201112345678", "+201112345678"], ["00201212345678", "+201212345678"], ["٠١٠١٢٣٤٥٦٧٨", "+201012345678"], ["010 1234-5678", "+201012345678"], ["201512345678", "+201512345678"]])("%s", (input, out) => {
    expect(normalizeEgPhone(input)).toBe(out);
  });
  it.each(["", "0101234567", "01312345678", "+971501234567", "abc", "0101234567890"])("rejects %s", (input) => {
    expect(normalizeEgPhone(input)).toBeNull();
  });
});
describe("codes and helpers", () => {
  it("accepts Eastern digits in the OTP and rejects other lengths", () => {
    expect(normalizeCode("١٢٣٤٥٦")).toBe("123456");
    expect(normalizeCode("12345")).toBeNull();
    expect(toWesternDigits("۰۱٢a")).toBe("012a");
  });
  it("masks the middle of a number", () => { expect(maskPhone("+201012345678")).toBe("+201••••••678"); expect(maskPhone("+2010")).toBe("+2010"); });
  it("uuidv7 has version 7, variant 10 and sorts by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_001_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
