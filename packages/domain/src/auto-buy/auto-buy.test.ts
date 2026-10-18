import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { priceDropAutoBuyMachine } from "../state-machine";
import {
  ATTEMPT_STATES,
  OPEN_ATTEMPT_STATES,
  AUTO_BUY_LIMITS,
  MANDATE_TEMPLATES,
  canCancelAttempt,
  decideCharge,
  evaluateTrigger,
  formatPiastres,
  idempotencyKeyFor,
  mandateTemplate,
  nextAttemptState,
  renderMandateText,
  reservationTtlMs,
  validateMandateTerms,
  type ChargeFacts,
  type MandateView,
  type PriceSignal,
} from "./index";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const mandate = (o: Partial<MandateView> = {}): MandateView => ({
  status: "ARMED",
  skuId: "sku-1",
  targetPrice: 64_900n,
  maxPrice: 70_000n,
  expiresAtMs: NOW + 30 * DAY,
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
  occurredAtMs: NOW,
  ...o,
});
const facts = (o: Partial<ChargeFacts> = {}): ChargeFacts => ({
  nowMs: NOW,
  mandateExpiresAtMs: NOW + DAY,
  mandateArmed: true,
  maxPrice: 70_000n,
  triggerPrice: 64_000n,
  price: 64_000n,
  priceVerified: true,
  priceAnomaly: false,
  listed: true,
  sizeInStock: true,
  deliverable: true,
  budget: "within",
  risk: "allow",
  token: "valid",
  plusActive: true,
  ageOk: true,
  units: 1,
  ...o,
});

describe("validateMandateTerms", () => {
  const ok = { currentPrice: 80_000n, targetPrice: 64_900n, maxPrice: 70_000n, expiresAtMs: NOW + 10 * DAY, nowMs: NOW, sizeLabel: "M" };
  it("accepts valid terms", () => expect(validateMandateTerms(ok)).toEqual([]));
  it("target must be strictly below the current price", () => {
    expect(validateMandateTerms({ ...ok, targetPrice: 80_000n })).toContain("target_not_below_current");
    expect(validateMandateTerms({ ...ok, targetPrice: 79_999n })).not.toContain("target_not_below_current");
  });
  it("max must be at least the target (equal is allowed)", () => {
    expect(validateMandateTerms({ ...ok, maxPrice: 64_899n })).toContain("max_below_target");
    expect(validateMandateTerms({ ...ok, maxPrice: 64_900n })).toEqual([]);
  });
  it("target must be positive", () => {
    expect(validateMandateTerms({ ...ok, targetPrice: 0n, maxPrice: 0n })).toContain("target_not_positive");
    expect(validateMandateTerms({ ...ok, targetPrice: -1n })).toContain("target_not_positive");
  });
  it("expiry: in the future and at most 90 days", () => {
    expect(validateMandateTerms({ ...ok, expiresAtMs: NOW })).toContain("expiry_not_in_future");
    expect(validateMandateTerms({ ...ok, expiresAtMs: NaN })).toContain("expiry_not_in_future");
    expect(validateMandateTerms({ ...ok, expiresAtMs: NOW + 90 * DAY })).toEqual([]);
    expect(validateMandateTerms({ ...ok, expiresAtMs: NOW + 90 * DAY + 1 })).toContain("expiry_too_far");
  });
  it("size label is required and bounded", () => {
    expect(validateMandateTerms({ ...ok, sizeLabel: "  " })).toContain("size_invalid");
    expect(validateMandateTerms({ ...ok, sizeLabel: "x".repeat(33) })).toContain("size_invalid");
    expect(validateMandateTerms({ ...ok, sizeLabel: "x".repeat(32) })).toEqual([]);
  });
});

describe("evaluateTrigger", () => {
  it("acceptance: verified 640 against target 649 triggers and is unattended-eligible", () => {
    expect(evaluateTrigger(mandate({ targetPrice: 64_900n }), signal({ price: 64_000n }), NOW)).toEqual({ kind: "trigger", unattendedEligible: true });
  });
  it("price exactly at target triggers; one piastre above does not", () => {
    expect(evaluateTrigger(mandate(), signal({ price: 64_900n }), NOW).kind).toBe("trigger");
    expect(evaluateTrigger(mandate(), signal({ price: 64_901n }), NOW)).toEqual({ kind: "ignore", reason: "price_above_target" });
  });
  it("an unverified or anomalous drop notifies but is never charge-eligible", () => {
    expect(evaluateTrigger(mandate(), signal({ verified: false }), NOW)).toEqual({ kind: "trigger", unattendedEligible: false });
    expect(evaluateTrigger(mandate(), signal({ anomaly: true }), NOW)).toEqual({ kind: "trigger", unattendedEligible: false });
  });
  it("ignores closed, expired and foreign-sku rules", () => {
    expect(evaluateTrigger(mandate({ status: "DISARMED" }), signal(), NOW)).toEqual({ kind: "ignore", reason: "mandate_not_armed" });
    expect(evaluateTrigger(mandate({ expiresAtMs: NOW }), signal(), NOW)).toEqual({ kind: "ignore", reason: "mandate_expired" });
    expect(evaluateTrigger(mandate(), signal({ skuId: "other" }), NOW)).toEqual({ kind: "ignore", reason: "sku_mismatch" });
  });
  it("B-1: an open or unresolved attempt blocks any new attempt for the rule", () => {
    expect(evaluateTrigger(mandate({ hasOpenAttempt: true }), signal(), NOW)).toEqual({ kind: "ignore", reason: "attempt_in_flight" });
  });
  it("24h cool-down between attempts", () => {
    const edge = AUTO_BUY_LIMITS.cooldownMs;
    expect(evaluateTrigger(mandate({ lastAttemptAtMs: NOW - edge + 1 }), signal(), NOW)).toEqual({ kind: "ignore", reason: "cooldown" });
    expect(evaluateTrigger(mandate({ lastAttemptAtMs: NOW - edge }), signal(), NOW).kind).toBe("trigger");
  });
});

describe("decideCharge", () => {
  it("charges the price at charge time", () => {
    expect(decideCharge(facts())).toEqual({ kind: "charge", amount: 64_000n });
  });
  it("acceptance: price 720 against max 700 never charges", () => {
    expect(decideCharge(facts({ price: 72_000n, triggerPrice: 72_000n }))).toEqual({ kind: "skip", reason: "price_above_max" });
    expect(decideCharge(facts({ price: 70_000n, triggerPrice: 70_000n }))).toEqual({ kind: "charge", amount: 70_000n });
    expect(decideCharge(facts({ price: 70_001n }))).toEqual({ kind: "skip", reason: "price_above_max" });
    expect(decideCharge(facts({ price: 0n }))).toEqual({ kind: "skip", reason: "price_above_max" });
  });
  it("B-2: a flap above the notified price skips, even under the max (never charge above the trigger)", () => {
    // target 649, max 700, notified at 640, price flapped to 699 at the claim.
    expect(decideCharge(facts({ triggerPrice: 64_000n, price: 69_900n, maxPrice: 70_000n }))).toEqual({
      kind: "skip",
      reason: "price_above_notified",
    });
    expect(decideCharge(facts({ triggerPrice: 64_000n, price: 64_000n }))).toEqual({ kind: "charge", amount: 64_000n });
    expect(decideCharge(facts({ triggerPrice: 64_000n, price: 63_000n }))).toEqual({ kind: "charge", amount: 63_000n });
  });
  const cases: [string, Partial<ChargeFacts>, string][] = [
    ["disarmed", { mandateArmed: false }, "mandate_not_armed"],
    ["expired at the instant", { mandateExpiresAtMs: NOW }, "mandate_expired"],
    ["two units", { units: 2 }, "units_exceeded"],
    ["plus lapsed", { plusActive: false }, "plus_lapsed"],
    ["under age", { ageOk: false }, "age_restricted"],
    ["token expired", { token: "expired" }, "token_invalid"],
    ["token missing", { token: "not_found" }, "token_invalid"],
    ["token is not a card (BNPL or COD)", { token: "not_card" }, "token_invalid"],
    ["unlisted", { listed: false }, "sku_unlisted"],
    ["unverified price", { priceVerified: false }, "price_not_verified"],
    ["anomaly", { priceAnomaly: true }, "price_anomaly"],
    ["size out of stock", { sizeInStock: false }, "out_of_stock"],
    ["not deliverable", { deliverable: false }, "not_deliverable"],
    ["hard cap", { budget: "hard_cap_exceeded" }, "budget_cap"],
    ["soft cap", { budget: "soft_cap_exceeded" }, "budget_cap"],
    ["risk require_otp", { risk: "require_otp" }, "risk_not_allowed"],
    ["risk block", { risk: "block" }, "risk_not_allowed"],
  ];
  it.each(cases)("skips: %s", (_n, over, reason) => {
    expect(decideCharge(facts(over))).toEqual({ kind: "skip", reason });
  });
  it("property: a charge is only ever for 0 < amount <= max and requires every check", () => {
    fc.assert(
      fc.property(
        fc.record({
          price: fc.bigInt({ min: -10n, max: 200_000n }),
          triggerPrice: fc.bigInt({ min: 1n, max: 150_000n }),
          maxPrice: fc.bigInt({ min: 1n, max: 150_000n }),
          priceVerified: fc.boolean(),
          priceAnomaly: fc.boolean(),
          listed: fc.boolean(),
          sizeInStock: fc.boolean(),
          deliverable: fc.boolean(),
          budget: fc.constantFrom("within", "soft_cap_exceeded", "hard_cap_exceeded"),
          risk: fc.constantFrom("allow", "require_otp", "require_prepayment", "prepaid_only", "limit_value", "block"),
          token: fc.constantFrom("valid", "expired", "not_found", "not_card"),
          plusActive: fc.boolean(),
          ageOk: fc.boolean(),
          mandateArmed: fc.boolean(),
        }),
        (o) => {
          const d = decideCharge(facts(o));
          if (d.kind === "charge") {
            expect(d.amount).toBeGreaterThan(0n);
            expect(d.amount).toBeLessThanOrEqual(o.maxPrice);
            expect(d.amount).toBeLessThanOrEqual(o.triggerPrice);
            expect(o.priceVerified && !o.priceAnomaly && o.listed && o.sizeInStock && o.deliverable).toBe(true);
            expect(o.budget === "within" && o.risk === "allow" && o.token === "valid" && o.plusActive && o.ageOk && o.mandateArmed).toBe(true);
          }
        },
      ),
    );
  });
});

describe("attempt state machine", () => {
  it("happy path: TRIGGERED -> NOTIFIED -> CHARGING -> PURCHASED", () => {
    const n = nextAttemptState("TRIGGERED", "CHECKS_PASSED");
    expect(n).toBe("NOTIFIED");
    const c = nextAttemptState(n, "CANCEL_WINDOW_ELAPSED", { cancelWindowElapsed: true });
    expect(c).toBe("CHARGING");
    expect(nextAttemptState(c, "CHARGE_SUCCEEDED")).toBe("PURCHASED");
  });
  it("the charge claim is refused while the window is open (no charge before the 15 minutes end)", () => {
    expect(() => nextAttemptState("NOTIFIED", "CANCEL_WINDOW_ELAPSED", { cancelWindowElapsed: false })).toThrow();
  });
  it("cancel is possible only before the charge claim", () => {
    expect(canCancelAttempt("NOTIFIED")).toBe(true);
    expect(canCancelAttempt("CHARGING")).toBe(false);
    expect(canCancelAttempt("PURCHASED")).toBe(false);
    expect(nextAttemptState("NOTIFIED", "USER_CANCELLED")).toBe("CANCELLED_BY_USER");
    expect(() => nextAttemptState("CHARGING", "USER_CANCELLED")).toThrow();
  });
  it("failed checks skip instead of notifying", () => {
    expect(nextAttemptState("TRIGGERED", "CHECKS_FAILED", { plusActive: false })).toBe("SKIPPED");
    expect(() => nextAttemptState("TRIGGERED", "CHECKS_PASSED", { plusActive: false })).toThrow();
    expect(() => nextAttemptState("TRIGGERED", "CHECKS_PASSED", { withinBudget: false })).toThrow();
    expect(() => nextAttemptState("TRIGGERED", "CHECKS_PASSED", { eligiblePaymentMethod: false })).toThrow();
  });
  it("B-1: an unresolved charge parks in MANUAL_REVIEW, never FAILED, and only evidence resolves it", () => {
    expect(nextAttemptState("CHARGING", "CHARGE_UNRESOLVED")).toBe("MANUAL_REVIEW");
    expect(nextAttemptState("REQUIRES_USER_ACTION", "CHARGE_UNRESOLVED")).toBe("MANUAL_REVIEW");
    expect(nextAttemptState("MANUAL_REVIEW", "CHARGE_SUCCEEDED")).toBe("PURCHASED");
    expect(nextAttemptState("MANUAL_REVIEW", "CHARGE_FAILED")).toBe("FAILED");
    expect(OPEN_ATTEMPT_STATES).toContain("MANUAL_REVIEW");
    expect(canCancelAttempt("MANUAL_REVIEW")).toBe(false);
  });
  it("every persisted state exists in the machine and terminal states have no exits", () => {
    for (const s of ATTEMPT_STATES) {
      expect(priceDropAutoBuyMachine.isState(s)).toBe(true);
      if (priceDropAutoBuyMachine.isTerminal(s)) expect(priceDropAutoBuyMachine.availableEvents(s)).toEqual([]);
    }
  });
});

describe("mandate text and keys", () => {
  it("renders the exact terms into both locales", () => {
    for (const locale of ["ar", "en"] as const) {
      const t = mandateTemplate(1, locale);
      expect(t).not.toBeNull();
      const out = renderMandateText(t ?? "", { item: "Linen dress", size: "M", target: "649.00", max: "700.00", expires: "2026-12-01" });
      expect(out).not.toMatch(/\{\{/);
      expect(out).toContain("649.00");
      expect(out).toContain("700.00");
      expect(out).toContain("2026-12-01");
      expect(out).toContain("15");
    }
    expect(mandateTemplate(2, "en")).toBeNull();
    expect(Object.keys(MANDATE_TEMPLATES)).toEqual(["1"]);
  });
  it("formats piastres with integer math", () => {
    expect(formatPiastres(64_900n)).toBe("649.00");
    expect(formatPiastres(5n)).toBe("0.05");
    expect(formatPiastres(100n)).toBe("1.00");
    expect(formatPiastres(-250n)).toBe("-2.50");
  });
  it("idempotency key follows the ADR format and the reservation covers window plus payment", () => {
    expect(idempotencyKeyFor("m1", "e1")).toBe("auto_buy:m1:e1");
    expect(reservationTtlMs()).toBe(25 * 60_000);
  });
});
