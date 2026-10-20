import { describe, expect, it } from "vitest";
import {
  CROSS_CHANNEL_FIX_MS,
  decideEnforcement,
  priceTrustScore,
  trustBand,
  type EnforcementInput,
} from "./index";

const base: EnforcementInput = { kind: "insufficient_evidence", violationsInWindow: 1, crossChannelOpenSinceMs: null, nowMs: 1_000_000_000 };

describe("decideEnforcement", () => {
  it("insufficient evidence hides the discount", () => {
    expect(decideEnforcement(base)).toEqual([{ kind: "hide_discount" }]);
  });
  it("claim above VRP is auto-corrected", () => {
    expect(decideEnforcement({ ...base, kind: "claim_exceeds_vrp" })).toEqual([{ kind: "auto_correct_display" }]);
  });
  it("pre-drop inflation removes the badge for 30 days with a ranking penalty", () => {
    expect(decideEnforcement({ ...base, kind: "pre_drop_inflation" })).toEqual([{ kind: "remove_badge", days: 30, rankingPenalty: true }]);
  });
  it("cross-channel: demote with a 48h deadline, then auto-pause", () => {
    const open = base.nowMs - 1;
    expect(decideEnforcement({ ...base, kind: "cross_channel_cheaper", crossChannelOpenSinceMs: open })).toEqual([
      { kind: "demote", fixDeadlineMs: open + CROSS_CHANNEL_FIX_MS },
    ]);
    const old = base.nowMs - CROSS_CHANNEL_FIX_MS;
    expect(decideEnforcement({ ...base, kind: "cross_channel_cheaper", crossChannelOpenSinceMs: old })).toEqual([
      { kind: "demote", fixDeadlineMs: old + CROSS_CHANNEL_FIX_MS },
      { kind: "auto_pause_sku" },
    ]);
    expect(decideEnforcement({ ...base, kind: "cross_channel_cheaper" })).toEqual([
      { kind: "demote", fixDeadlineMs: base.nowMs + CROSS_CHANNEL_FIX_MS },
    ]);
  });
  it("three violations in 90 days also strip the verified badge", () => {
    expect(decideEnforcement({ ...base, violationsInWindow: 2 })).toHaveLength(1);
    expect(decideEnforcement({ ...base, violationsInWindow: 3 })).toEqual([
      { kind: "hide_discount" },
      { kind: "strip_verified_badge", commissionSurcharge: true, dropsBlockedDays: 30 },
    ]);
  });
  it("severe or repeat suspends with payouts held and a 5 business day human review", () => {
    expect(decideEnforcement({ ...base, kind: "severe_or_repeat", violationsInWindow: 9 })).toEqual([
      { kind: "suspend_store", holdPayouts: true, humanReviewBusinessDays: 5 },
    ]);
  });
});

describe("priceTrustScore", () => {
  it("is 100 for a clean store", () => {
    expect(priceTrustScore({ violationsInWindow: 0, openCrossChannelFindings: 0, claimsEvaluated: 0, claimsAutoCorrected: 0 })).toBe(100);
  });
  it("penalises strikes, open findings and corrections, clamped to 0..100", () => {
    expect(priceTrustScore({ violationsInWindow: 2, openCrossChannelFindings: 1, claimsEvaluated: 20, claimsAutoCorrected: 4 })).toBe(100 - 20 - 5 - 4);
    expect(priceTrustScore({ violationsInWindow: 99, openCrossChannelFindings: 99, claimsEvaluated: 1, claimsAutoCorrected: 99 })).toBe(0);
    expect(priceTrustScore({ violationsInWindow: -3, openCrossChannelFindings: -1, claimsEvaluated: 0, claimsAutoCorrected: 5 })).toBe(100);
  });
  it("bands", () => {
    expect(trustBand(95)).toBe("excellent");
    expect(trustBand(90)).toBe("excellent");
    expect(trustBand(89)).toBe("good");
    expect(trustBand(70)).toBe("good");
    expect(trustBand(69)).toBe("at_risk");
    expect(trustBand(40)).toBe("at_risk");
    expect(trustBand(39)).toBe("restricted");
  });
});
