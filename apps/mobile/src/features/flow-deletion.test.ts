import { describe, expect, it } from "vitest";
import { ONBOARDING_STEPS, analyticsStepFor, isSkippable, nextStep, stepProgress } from "./flow";
import { canConfirmDeletion, deletionView } from "./deletion";
import { formatPiastres } from "./format";

describe("onboarding flow", () => {
  it("only the steps after identity (language, consents) are skippable", () => {
    for (const s of ["dob", "phone", "otp"] as const) expect(isSkippable(s)).toBe(false);
    for (const s of ["language", "consents"] as const) expect(isSkippable(s)).toBe(true);
  });
  it("advances in order and stops at done", () => {
    expect(nextStep("dob")).toBe("phone");
    expect(nextStep("phone")).toBe("otp");
    expect(nextStep("otp")).toBe("language");
    expect(nextStep("consents")).toBe("done");
    expect(nextStep("done")).toBe("done");
    expect(stepProgress("dob")).toEqual({ current: 1, total: 5 });
    expect(stepProgress("otp")).toEqual({ current: 3, total: 5 });
  });
  it("asks for the date of birth before the phone number (spec 1)", () => {
    expect(ONBOARDING_STEPS.indexOf("dob")).toBeLessThan(ONBOARDING_STEPS.indexOf("phone"));
    expect(ONBOARDING_STEPS.indexOf("dob")).toBe(0);
  });
  it("maps steps to catalog step names", () => {
    expect(analyticsStepFor("otp")).toBe("auth");
    expect(analyticsStepFor("dob")).toBe("age_attestation");
    expect(analyticsStepFor("done")).toBeNull();
  });
});

describe("deletion view", () => {
  const zero = { openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 0n };
  it("blocks with open orders and never allows confirmation", () => {
    const v = deletionView({ ...zero, openOrders: 2 });
    expect(v.state).toBe("blocked");
    expect(canConfirmDeletion(v, true)).toBe(false);
  });
  it("requires acknowledgement only when credit is forfeited", () => {
    const none = deletionView(zero);
    expect(canConfirmDeletion(none, false)).toBe(true);
    const some = deletionView({ ...zero, storeCreditMinor: 12_550n });
    expect(some).toMatchObject({ state: "eligible", forfeitureMinor: 12_550n, coolingDays: 14 });
    expect(canConfirmDeletion(some, false)).toBe(false);
    expect(canConfirmDeletion(some, true)).toBe(true);
  });
  it("formats piastres without floating point", () => {
    expect(formatPiastres(12_550n)).toBe("125.50");
    expect(formatPiastres(5n)).toBe("0.05");
    expect(formatPiastres(0n)).toBe("0.00");
  });
});
