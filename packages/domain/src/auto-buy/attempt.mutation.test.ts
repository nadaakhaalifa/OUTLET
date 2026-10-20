// Targeted tests for the auto-buy attempt wrapper and the trigger cooldown. Written to kill Stryker
// survivors (ADR-0019).
import { describe, expect, it } from "vitest";
import {
  ATTEMPT_STATES,
  AUTO_BUY_LIMITS,
  OPEN_ATTEMPT_STATES,
  canCancelAttempt,
  evaluateTrigger,
  isAttemptState,
  nextAttemptState,
  type MandateView,
  type PriceSignal,
} from "./index";

const mandate = (o: Partial<MandateView> = {}): MandateView => ({
  status: "ARMED",
  skuId: "sku-1",
  targetPrice: 64_900n,
  maxPrice: 70_000n,
  expiresAtMs: 10 * AUTO_BUY_LIMITS.cooldownMs,
  lastAttemptAtMs: null,
  hasOpenAttempt: false,
  ...o,
});
const signal = (o: Partial<PriceSignal> = {}): PriceSignal => ({
  eventId: "pe-1",
  skuId: "sku-1",
  price: 64_000n,
  verified: true,
  anomaly: false,
  occurredAtMs: 0,
  ...o,
});

describe("attempt states", () => {
  it("lists are exact", () => {
    expect([...ATTEMPT_STATES]).toEqual([
      "TRIGGERED",
      "SKIPPED",
      "NOTIFIED",
      "CHARGING",
      "REQUIRES_USER_ACTION",
      "MANUAL_REVIEW",
      "PURCHASED",
      "CANCELLED_BY_USER",
      "FAILED",
      "DISARMED",
    ]);
    expect([...OPEN_ATTEMPT_STATES]).toEqual(["TRIGGERED", "NOTIFIED", "CHARGING", "REQUIRES_USER_ACTION", "MANUAL_REVIEW"]);
    for (const s of ATTEMPT_STATES) expect(isAttemptState(s)).toBe(true);
    expect(isAttemptState("ARMED")).toBe(false);
    expect(isAttemptState("EXPIRED")).toBe(false);
    expect(isAttemptState("")).toBe(false);
  });
  it("only a notified attempt can be cancelled by the user", () => {
    for (const s of ATTEMPT_STATES) expect(canCancelAttempt(s), s).toBe(s === "NOTIFIED");
  });
});

describe("nextAttemptState defaults", () => {
  it("the cancel window has not elapsed unless the caller says so", () => {
    expect(() => nextAttemptState("NOTIFIED", "CANCEL_WINDOW_ELAPSED")).toThrow();
    expect(nextAttemptState("NOTIFIED", "CANCEL_WINDOW_ELAPSED", { cancelWindowElapsed: true })).toBe("CHARGING");
  });
  it("checks default to passing", () => {
    expect(nextAttemptState("TRIGGERED", "CHECKS_PASSED")).toBe("NOTIFIED");
    expect(() => nextAttemptState("TRIGGERED", "CHECKS_FAILED")).toThrow();
    expect(nextAttemptState("TRIGGERED", "CHECKS_FAILED", { withinBudget: false })).toBe("SKIPPED");
    expect(() => nextAttemptState("TRIGGERED", "CHECKS_PASSED", { plusActive: false })).toThrow();
    expect(() => nextAttemptState("TRIGGERED", "CHECKS_PASSED", { eligiblePaymentMethod: false })).toThrow();
  });
  it("the price is at target unless the caller says otherwise, and non-attempt states are refused", () => {
    // ARMED is the mandate's state, not an attempt's: it is reachable only through the cast
    expect(nextAttemptState("ARMED" as never, "PRICE_AT_TARGET")).toBe("TRIGGERED");
    expect(() => nextAttemptState("ARMED" as never, "PRICE_AT_TARGET", { verifiedPriceAtOrBelowTarget: false })).toThrow();
    expect(() => nextAttemptState("ARMED" as never, "OPT_IN_EXPIRED")).toThrow("attempt reached non-attempt state EXPIRED");
  });
});

describe("evaluateTrigger cooldown", () => {
  const day = AUTO_BUY_LIMITS.cooldownMs;
  it("no earlier attempt means no cooldown, even at a tiny clock value", () => {
    expect(evaluateTrigger(mandate({ lastAttemptAtMs: null }), signal(), 1_000)).toEqual({ kind: "trigger", unattendedEligible: true });
  });
  it("cooldown ends exactly 24 hours after the last attempt", () => {
    const last = 5 * day;
    expect(evaluateTrigger(mandate({ lastAttemptAtMs: last }), signal(), last + day - 1)).toEqual({ kind: "ignore", reason: "cooldown" });
    expect(evaluateTrigger(mandate({ lastAttemptAtMs: last }), signal(), last + day)).toEqual({ kind: "trigger", unattendedEligible: true });
  });
  it("check order", () => {
    const all = mandate({ status: "DISARMED", skuId: "other", hasOpenAttempt: true, lastAttemptAtMs: 0 });
    expect(evaluateTrigger(all, signal({ price: 99_999n }), 1)).toEqual({ kind: "ignore", reason: "mandate_not_armed" });
    expect(evaluateTrigger({ ...all, status: "ARMED" }, signal({ price: 99_999n }), 10 * day)).toEqual({ kind: "ignore", reason: "mandate_expired" });
    expect(evaluateTrigger({ ...all, status: "ARMED" }, signal({ price: 99_999n }), 1)).toEqual({ kind: "ignore", reason: "sku_mismatch" });
    expect(evaluateTrigger({ ...all, status: "ARMED", skuId: "sku-1" }, signal({ price: 99_999n }), 1)).toEqual({ kind: "ignore", reason: "price_above_target" });
    expect(evaluateTrigger({ ...all, status: "ARMED", skuId: "sku-1" }, signal(), 1)).toEqual({ kind: "ignore", reason: "attempt_in_flight" });
    expect(evaluateTrigger(mandate({ targetPrice: 64_000n }), signal({ price: 64_000n }), 1)).toMatchObject({ kind: "trigger" });
    expect(evaluateTrigger(mandate({ targetPrice: 64_000n }), signal({ price: 64_001n }), 1)).toMatchObject({ reason: "price_above_target" });
    expect(evaluateTrigger(mandate({ expiresAtMs: 100 }), signal(), 99)).toMatchObject({ kind: "trigger" });
    expect(evaluateTrigger(mandate({ expiresAtMs: 100 }), signal(), 100)).toMatchObject({ reason: "mandate_expired" });
  });
  it("unattended charging needs a verified, non-anomalous price", () => {
    expect(evaluateTrigger(mandate(), signal({ verified: false }), 1)).toEqual({ kind: "trigger", unattendedEligible: false });
    expect(evaluateTrigger(mandate(), signal({ anomaly: true }), 1)).toEqual({ kind: "trigger", unattendedEligible: false });
  });
});
