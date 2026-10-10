import { describe, expect, it } from "vitest";
import { maskPhone, normalizeEgyptianPhone, toAsciiDigits } from "./phone";
import { isCompleteOtp, resendExhausted, resendRemainingSeconds, sanitizeOtp } from "./otp";
import { assessAge, parseDobFields } from "./dob";
import { sha256Hex } from "../workspace";

const clock = { now: () => new Date("2026-10-10T12:00:00Z") };
const deps = { hasher: sha256Hex, clock };

describe("phone", () => {
  it("normalizes national, international and Arabic-Indic input", () => {
    expect(normalizeEgyptianPhone("01012345678")).toEqual({ ok: true, e164: "+201012345678" });
    expect(normalizeEgyptianPhone("+20 101 234 5678")).toEqual({ ok: true, e164: "+201012345678" });
    expect(normalizeEgyptianPhone("00201012345678")).toEqual({ ok: true, e164: "+201012345678" });
    expect(normalizeEgyptianPhone("٠١٠١٢٣٤٥٦٧٨")).toEqual({ ok: true, e164: "+201012345678" });
    expect(toAsciiDigits("۰۱٢")).toBe("012");
  });
  it("rejects empty, malformed and other countries", () => {
    expect(normalizeEgyptianPhone("  ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeEgyptianPhone("abc")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeEgyptianPhone("0101234")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeEgyptianPhone("+14155550123")).toEqual({ ok: false, reason: "country_not_supported" });
    expect(normalizeEgyptianPhone("01312345678")).toEqual({ ok: false, reason: "invalid" });
  });
  it("masks the middle of the number", () => {
    const m = maskPhone("+201012345678");
    expect(m).not.toContain("12345");
    expect(m.endsWith("78")).toBe(true);
  });
});

describe("otp", () => {
  it("sanitizes to six ASCII digits", () => {
    expect(sanitizeOtp("١٢٣ 456789")).toBe("123456");
    expect(isCompleteOtp("123456")).toBe(true);
    expect(isCompleteOtp("12345")).toBe(false);
  });
  it("counts the resend delay down from the policy", () => {
    expect(resendRemainingSeconds(1, 0, 0)).toBe(30);
    expect(resendRemainingSeconds(1, 0, 10_000)).toBe(20);
    expect(resendRemainingSeconds(1, 0, 31_000)).toBe(0);
    expect(resendRemainingSeconds(2, 0, 0)).toBe(60);
    expect(resendExhausted(2)).toBe(false);
    expect(resendExhausted(3)).toBe(true);
  });
});

describe("age gate", () => {
  const ok = { day: "10", month: "10", year: "2000" };
  it("parses fields and rejects impossible dates", () => {
    expect(parseDobFields({ day: "", month: "1", year: "2000" })).toEqual({ ok: false, reason: "incomplete" });
    expect(parseDobFields({ day: "31", month: "2", year: "2000" })).toEqual({ ok: false, reason: "invalid" });
    expect(parseDobFields({ day: "1", month: "1", year: "99" })).toEqual({ ok: false, reason: "invalid" });
    expect(parseDobFields({ day: "١", month: "١", year: "٢٠٠٠" }).ok).toBe(true);
  });
  it("accepts an adult who attests, flags 18-20 as limited capacity", () => {
    const adult = assessAge(ok, true, "dev1", undefined, deps);
    expect(adult).toMatchObject({ kind: "accepted", limitedCapacity: false });
    const young = assessAge({ day: "10", month: "10", year: "2007" }, true, "dev1", undefined, deps);
    expect(young).toMatchObject({ kind: "accepted", limitedCapacity: true });
  });
  it("requires the attestation checkbox", () => {
    expect(assessAge(ok, false, "dev1", undefined, deps)).toEqual({ kind: "needs_attestation" });
  });
  it("blocks under 18 and returns only a hashed device block, nothing about the DOB", () => {
    const r = assessAge({ day: "11", month: "10", year: "2008" }, true, "dev1", undefined, deps);
    expect(r.kind).toBe("blocked_under_18");
    if (r.kind !== "blocked_under_18") return;
    expect(Object.keys(r).sort()).toEqual(["block", "kind"]);
    expect(Object.keys(r.block).sort()).toEqual(["blockedUntil", "deviceHash"]);
    expect(JSON.stringify(r)).not.toContain("2008");
    expect(JSON.stringify(r)).not.toContain("dev1");
  });
  it("exactly 18 today is accepted", () => {
    expect(assessAge({ day: "10", month: "10", year: "2008" }, true, "d", undefined, deps).kind).toBe("accepted");
  });
  it("a blocked device stays blocked even with an adult DOB", () => {
    const under = assessAge({ day: "1", month: "1", year: "2015" }, true, "dev1", undefined, deps);
    if (under.kind !== "blocked_under_18") throw new Error("expected block");
    expect(assessAge(ok, true, "dev1", under.block, deps)).toEqual({ kind: "blocked_device" });
    expect(assessAge(ok, true, "other", under.block, deps).kind).toBe("accepted");
  });
  it("treats a future DOB as invalid, never accepted", () => {
    expect(assessAge({ day: "1", month: "1", year: "2030" }, true, "d", undefined, deps)).toEqual({ kind: "invalid_date" });
  });
});
