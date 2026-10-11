import { describe, expect, it } from "vitest";
import { parseTrigger } from "./adapters/triggers";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("outbox trigger parsing", () => {
  it("parses the review reward intent the reviews module emits today", () => {
    const r = parseTrigger("review.reward_intent", {
      review_id: U(1),
      user_id: U(2),
      order_line_id: U(3),
      kind: "review_coins",
      has_photo: true,
      has_fit_info: false,
      idempotency_key: "review:abc",
    });
    expect(r).toEqual({ kind: "ok", trigger: { type: "review.reward_intent", userId: U(2), reviewId: U(1), hasPhoto: true, hasFitInfo: false } });
  });

  it("a payload carrying a rating is invalid (strict): the rating can never reach the reward code", () => {
    const r = parseTrigger("review.reward_intent", {
      review_id: U(1),
      user_id: U(2),
      order_line_id: U(3),
      kind: "review_coins",
      has_photo: true,
      has_fit_info: true,
      idempotency_key: "k",
      rating: 5,
    });
    expect(r.kind).toBe("invalid");
  });

  it("parses the referral reward the referrals module emits today", () => {
    const r = parseTrigger("referral.reward_earned", {
      referral_id: "r1",
      beneficiary_user_id: U(2),
      amount: "10000",
      currency: "EGP",
      kind: "referral_credit",
      idempotency_key: "referral:r1",
    });
    expect(r).toEqual({
      kind: "ok",
      trigger: { type: "referral.reward_earned", userId: U(2), referralId: "r1", amountPiastres: 10_000n, idempotencyKey: "referral:r1" },
    });
  });

  it("parses order closed and refunded, rejects non integer money and unknown fields", () => {
    expect(parseTrigger("order.closed", { user_id: U(1), order_ref: "o1", net_merchandise: "150000", delivered_at_ms: 1 }).kind).toBe("ok");
    expect(parseTrigger("order.closed", { user_id: U(1), order_ref: "o1", net_merchandise: "1.5", delivered_at_ms: 1 }).kind).toBe("invalid");
    expect(parseTrigger("order.closed", { user_id: U(1), order_ref: "o1", net_merchandise: "-5", delivered_at_ms: 1 }).kind).toBe("invalid");
    expect(parseTrigger("order.closed", { user_id: U(1), order_ref: "o1", net_merchandise: "5", delivered_at_ms: 1, x: 1 }).kind).toBe("invalid");
    expect(
      parseTrigger("order.refunded", {
        user_id: U(1),
        order_ref: "o1",
        refund_ref: "rf1",
        order_net_merchandise: "100",
        refunded_net_merchandise: "40",
        cumulative_refunded: "40",
      }).kind,
    ).toBe("ok");
  });

  it("ignores events it does not consume", () => {
    expect(parseTrigger("order.placed", {})).toEqual({ kind: "ignored" });
  });
});
