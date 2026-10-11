import { describe, expect, it } from "vitest";
import { AWB_RETRY_POLICY, awbBackoffMs, awbRetryDecision, withinWebhookTolerance } from "./awb-queue";
import { matchCodLine } from "./cod";
import { money } from "../money";

describe("awbBackoffMs", () => {
  it("doubles per failure with half fixed and half jittered", () => {
    expect(awbBackoffMs(1, 0)).toBe(15_000);
    expect(awbBackoffMs(1, 1)).toBe(30_000);
    expect(awbBackoffMs(2, 0)).toBe(30_000);
    expect(awbBackoffMs(3, 1)).toBe(120_000);
  });
  it("caps at 15 minutes", () => {
    expect(awbBackoffMs(20, 1)).toBe(AWB_RETRY_POLICY.capDelayMs);
    expect(awbBackoffMs(20, 0)).toBe(AWB_RETRY_POLICY.capDelayMs / 2);
  });
  it("clamps jitter and attempt inputs", () => {
    expect(awbBackoffMs(0, -5)).toBe(15_000);
    expect(awbBackoffMs(1, 9)).toBe(30_000);
  });
  it("is monotone in the failure count for fixed jitter", () => {
    let prev = 0;
    for (let n = 1; n <= 12; n += 1) {
      const d = awbBackoffMs(n, 0.5);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe("awbRetryDecision", () => {
  it("dead-letters at the eighth failure", () => {
    expect(awbRetryDecision(7)).toBe("retry");
    expect(awbRetryDecision(8)).toBe("dead_letter");
  });
});

describe("withinWebhookTolerance", () => {
  it("accepts +/- 5 minutes inclusive", () => {
    expect(withinWebhookTolerance(1_000_000, 1_300_000)).toBe(true);
    expect(withinWebhookTolerance(1_000_000, 700_000)).toBe(true);
    expect(withinWebhookTolerance(1_000_000, 1_300_001)).toBe(false);
    expect(withinWebhookTolerance(1_000_000, 699_999)).toBe(false);
  });
});

describe("matchCodLine", () => {
  it("classifies lines", () => {
    expect(matchCodLine(null, money(100n))).toBe("UNKNOWN_AWB");
    expect(matchCodLine({ expected: null }, money(100n))).toBe("NOT_COD");
    expect(matchCodLine({ expected: money(100n) }, money(100n))).toBe("MATCHED");
    expect(matchCodLine({ expected: money(100n) }, money(99n))).toBe("AMOUNT_DIFF");
  });
});
