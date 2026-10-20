import { describe, expect, it } from "vitest";
import { EMPTY_PREFS, nextPrefStep, parseMonthlyBudget, parsePrefs, toggle } from "./model";

describe("onboarding extras", () => {
  it("starts with nothing selected", () => {
    expect(EMPTY_PREFS.vibes).toEqual([]);
    expect(EMPTY_PREFS.budgetEgp).toBeNull();
    expect(EMPTY_PREFS.notifications).toBeNull();
  });
  it("toggles", () => expect(toggle(toggle([], "a"), "a")).toEqual([]));
  it("orders steps and ends", () => {
    expect(nextPrefStep("vibes")).toBe("sizes");
    expect(nextPrefStep("notifications")).toBeNull();
  });
  it("parses budget", () => {
    expect(parseMonthlyBudget("")).toEqual({ ok: true, value: null });
    expect(parseMonthlyBudget("٢٠٠٠")).toEqual({ ok: true, value: 2000 });
    expect(parseMonthlyBudget("0").ok).toBe(false);
    expect(parseMonthlyBudget("12a").ok).toBe(false);
  });
  it("survives corrupt storage", () => {
    expect(parsePrefs("{bad")).toEqual(EMPTY_PREFS);
    expect(parsePrefs(JSON.stringify({ vibes: ["x", 3], budgetEgp: -1 })).vibes).toEqual(["x"]);
  });
});
