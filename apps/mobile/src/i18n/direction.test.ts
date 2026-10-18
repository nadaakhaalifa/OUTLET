import { describe, expect, it } from "vitest";
import { decideReload, directionMismatch, isRtlLanguage, parseReloadGuard } from "./direction";

describe("direction resolver", () => {
  it("derives RTL from the language", () => {
    expect(isRtlLanguage("ar")).toBe(true);
    expect(isRtlLanguage("en")).toBe(false);
  });
  it("detects a mismatch between language and native direction", () => {
    expect(directionMismatch("ar", false)).toBe(true);
    expect(directionMismatch("en", true)).toBe(true);
    expect(directionMismatch("ar", true)).toBe(false);
    expect(directionMismatch("en", false)).toBe(false);
  });
  it("reloads once on a mismatch and records the guard", () => {
    expect(decideReload("en", true, null)).toEqual({ action: "reload", nextGuard: "en" });
    expect(decideReload("ar", false, "en")).toEqual({ action: "reload", nextGuard: "ar" });
  });
  it("gives up instead of looping when the reload for that language already happened", () => {
    expect(decideReload("en", true, "en")).toEqual({ action: "give_up", nextGuard: null });
  });
  it("clears the guard once direction agrees", () => {
    expect(decideReload("en", false, "en")).toEqual({ action: "none", nextGuard: null });
    expect(decideReload("ar", true, null)).toEqual({ action: "none", nextGuard: null });
  });
  it("parses only known guard values", () => {
    expect(parseReloadGuard("ar")).toBe("ar");
    expect(parseReloadGuard("fr")).toBeNull();
    expect(parseReloadGuard(null)).toBeNull();
  });
});
