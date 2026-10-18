import { describe, expect, it } from "vitest";
import { ONBOARDING_STEPS, analyticsStepFor, isSkippable, nextStep, stepProgress } from "./flow";
import { canConfirmDeletion, deletionView } from "./deletion";
import { formatPiastres } from "./format";

describe("onboarding flow", () => {
  it("only consents is skippable; the account and code steps are identity", () => {
    for (const s of ["account", "otp"] as const) expect(isSkippable(s)).toBe(false);
    expect(isSkippable("consents")).toBe(true);
  });
  it("advances in order and stops at done", () => {
    expect(nextStep("account")).toBe("otp");
    expect(nextStep("otp")).toBe("consents");
    expect(nextStep("consents")).toBe("done");
    expect(nextStep("done")).toBe("done");
    expect(stepProgress("account")).toEqual({ current: 1, total: 3 });
    expect(stepProgress("otp")).toEqual({ current: 2, total: 3 });
  });
  it("starts at the single account screen, which holds the age gate before the phone number (spec 1)", () => {
    expect(ONBOARDING_STEPS[0]).toBe("account");
    expect(ONBOARDING_STEPS).not.toContain("phone");
  });
  it("maps steps to catalog step names", () => {
    expect(analyticsStepFor("otp")).toBe("auth");
    expect(analyticsStepFor("account")).toBe("age_attestation");
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
