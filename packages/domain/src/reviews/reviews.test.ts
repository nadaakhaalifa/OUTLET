import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_CONFIG as C,
  InvalidModerationTransitionError,
  MODERATION_STATUSES,
  MODERATION_TABLE,
  checkReviewEligibility,
  containsContactInfo,
  decideAutoModeration,
  decodeCursor,
  encodeCursor,
  isQaOverdue,
  qaSlaDueAt,
  reviewRewardIntent,
  reviewerInitial,
  summarizeRatings,
  toAsciiDigits,
  transitionModeration,
  validateReviewDraft,
  validateShortText,
  type DeliveredLine,
  type ModerationStatus,
} from "./index";

const line: DeliveredLine = {
  orderLineId: "00000000-0000-4000-8000-000000000001",
  userId: "u1",
  storeId: "s1",
  productId: "p1",
  sizeLabel: "M",
  deliveredAtMs: 1_000_000,
};

describe("moderation state machine", () => {
  it("publishes only through AUTO_CHECKED or a human", () => {
    expect(transitionModeration("SUBMITTED", "checks_done")).toBe("AUTO_CHECKED");
    expect(transitionModeration("AUTO_CHECKED", "auto_publish")).toBe("PUBLISHED");
    expect(transitionModeration("AUTO_CHECKED", "auto_hold")).toBe("HELD");
    expect(transitionModeration("AUTO_CHECKED", "auto_reject")).toBe("REJECTED");
    expect(() => transitionModeration("SUBMITTED", "auto_publish")).toThrow(InvalidModerationTransitionError);
    expect(() => transitionModeration("REJECTED", "moderator_publish")).toThrow(InvalidModerationTransitionError);
    expect(() => transitionModeration("PUBLISHED", "moderator_publish")).toThrow(InvalidModerationTransitionError);
  });

  it("every status is reachable from SUBMITTED and nothing publishes without a check or a human", () => {
    const seen = new Set<ModerationStatus>(["SUBMITTED"]);
    const stack: ModerationStatus[] = ["SUBMITTED"];
    while (stack.length > 0) {
      const s = stack.pop() as ModerationStatus;
      for (const to of Object.values(MODERATION_TABLE[s])) {
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
    expect([...seen].sort()).toEqual([...MODERATION_STATUSES].sort());
    for (const s of MODERATION_STATUSES) {
      for (const [ev, to] of Object.entries(MODERATION_TABLE[s])) {
        if (to === "PUBLISHED") expect(["auto_publish", "moderator_publish"]).toContain(ev);
      }
    }
  });

  it("auto moderation: reject beats hold beats publish, outage fails closed", () => {
    expect(decideAutoModeration({ toxicity: 10, images: [], hasContactInfo: false }).event).toBe("auto_publish");
    expect(decideAutoModeration({ toxicity: 50, images: [], hasContactInfo: false })).toEqual({ event: "auto_hold", reason: "toxicity" });
    expect(decideAutoModeration({ toxicity: 90, images: [], hasContactInfo: false })).toEqual({ event: "auto_reject", reason: "toxicity" });
    expect(decideAutoModeration({ toxicity: "unavailable", images: [], hasContactInfo: false })).toEqual({
      event: "auto_hold",
      reason: "classifier_unavailable",
    });
    expect(decideAutoModeration({ toxicity: 0, images: ["unavailable"], hasContactInfo: false }).event).toBe("auto_hold");
    expect(decideAutoModeration({ toxicity: 0, images: [{ nsfw: 95, violence: 0 }], hasContactInfo: false })).toEqual({
      event: "auto_reject",
      reason: "image_flagged",
    });
    expect(decideAutoModeration({ toxicity: 0, images: [{ nsfw: 0, violence: 60 }], hasContactInfo: false }).event).toBe("auto_hold");
    expect(decideAutoModeration({ toxicity: 0, images: [], hasContactInfo: true })).toEqual({ event: "auto_hold", reason: "contact_info" });
    // a flagged image rejects even when the classifier is down for another image
    expect(decideAutoModeration({ toxicity: 0, images: ["unavailable", { nsfw: 99, violence: 0 }], hasContactInfo: false }).event).toBe("auto_reject");
  });
});

describe("eligibility", () => {
  it("accepts the buyer of a delivered line inside the window", () => {
    expect(checkReviewEligibility({ line, reviewerUserId: "u1", reviewerStoreIds: [], nowMs: 2_000_000 })).toEqual({ ok: true });
  });
  it("refuses another user, the seller's own staff and an elapsed window", () => {
    expect(checkReviewEligibility({ line, reviewerUserId: "u2", reviewerStoreIds: [], nowMs: 2_000_000 })).toEqual({ ok: false, reason: "not_buyer" });
    expect(checkReviewEligibility({ line, reviewerUserId: "u1", reviewerStoreIds: ["s1"], nowMs: 2_000_000 })).toEqual({ ok: false, reason: "self_review" });
    expect(
      checkReviewEligibility({ line, reviewerUserId: "u1", reviewerStoreIds: [], nowMs: line.deliveredAtMs + C.reviewWindowMs + 1 }),
    ).toEqual({ ok: false, reason: "window_elapsed" });
    expect(
      checkReviewEligibility({ line, reviewerUserId: "u1", reviewerStoreIds: [], nowMs: line.deliveredAtMs + C.reviewWindowMs }).ok,
    ).toBe(true);
  });
});

describe("validation", () => {
  const ok = { rating: 4, body: "Fits well and the fabric is soft." };
  it("accepts a minimal review and normalises text", () => {
    const r = validateReviewDraft({ ...ok, body: "  Fits well, fabric is soft.  " });
    expect(r).toEqual({
      ok: true,
      value: { rating: 4, title: null, body: "Fits well, fabric is soft.", fit: null, fitArea: null, photoIds: [] },
    });
  });
  it("accepts Arabic text and counts code points", () => {
    expect(validateReviewDraft({ rating: 5, body: "المقاس مظبوط والخامة ممتازة جدا" }).ok).toBe(true);
  });
  it("rejects bad rating, short body, fit area without fit, bad photos", () => {
    const bad = validateReviewDraft({ rating: 0, body: "short", fitArea: "waist", photoIds: ["x", "x"] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const codes = bad.errors.map((e) => `${e.field}:${e.code}`);
      expect(codes).toContain("rating:out_of_range");
      expect(codes).toContain("body:too_short");
      expect(codes).toContain("fit_area:requires_fit");
      expect(codes).toContain("photo_ids:invalid");
    }
    expect(validateReviewDraft({ ...ok, rating: 4.5 }).ok).toBe(false);
    expect(validateReviewDraft({ ...ok, body: "x".repeat(2001) }).ok).toBe(false);
    const six = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    expect(validateReviewDraft({ ...ok, photoIds: six }).ok).toBe(false);
  });
  it("validates replies, questions and answers", () => {
    expect(validateShortText("body", "  ", "reply").ok).toBe(false);
    expect(validateShortText("body", "Thanks!", "reply").ok).toBe(true);
    expect(validateShortText("body", "hi", "question").ok).toBe(false);
    expect(validateShortText("body", "ok", "answer").ok).toBe(true);
  });
});

describe("reward intent", () => {
  it("has no dependence on the rating (type level and value level)", () => {
    const a = reviewRewardIntent({ orderLineId: line.orderLineId, photoCount: 1, fit: "ok" });
    const b = reviewRewardIntent({ orderLineId: line.orderLineId, photoCount: 1, fit: "ok" });
    expect(a).toEqual(b);
    expect(a).toEqual({ kind: "review_coins", orderLineId: line.orderLineId, hasPhoto: true, hasFitInfo: true });
    expect(reviewRewardIntent({ orderLineId: "x", photoCount: 0, fit: null })).toMatchObject({ hasPhoto: false, hasFitInfo: false });
  });
});

describe("summary", () => {
  it("shows nothing below the minimum count, never a stub", () => {
    expect(summarizeRatings({ byStar: [0, 0, 0, 0, 0] })).toBeNull();
    expect(summarizeRatings({ byStar: [0, 0, 0, 0, 4] })).toBeNull();
    expect(summarizeRatings({ byStar: [0, 0, 0, 0, 5] })).toEqual({ count: 5, averageTenths: 50, distribution: [0, 0, 0, 0, 5] });
  });
  it("rounds half up in integer tenths", () => {
    // 1,1,1,1,2 sum 6 over 5 = 1.2
    expect(summarizeRatings({ byStar: [4, 1, 0, 0, 0] })?.averageTenths).toBe(12);
    // 1x5 + 1x4 + ... sum 41 over 10 = 4.1
    expect(summarizeRatings({ byStar: [0, 0, 0, 9, 1] })?.averageTenths).toBe(41);
    // 7 ratings: 5,5,5,5,5,5,4 = 34/7 = 4.857 -> 4.9
    expect(summarizeRatings({ byStar: [0, 0, 0, 1, 6] })?.averageTenths).toBe(49);
  });
  it("property: average is between min and max star present and count is the total", () => {
    fc.assert(
      fc.property(fc.tuple(...Array.from({ length: 5 }, () => fc.integer({ min: 0, max: 200 }))), (t) => {
        const by = t as unknown as readonly [number, number, number, number, number];
        const total = t.reduce((a, b) => a + b, 0);
        const s = summarizeRatings({ byStar: by });
        if (total < C.minAggregateCount) return s === null;
        if (s === null) return false;
        const present = by.map((n, i) => (n > 0 ? i + 1 : 0)).filter((x) => x > 0);
        return (
          s.count === total &&
          s.averageTenths >= Math.min(...present) * 10 &&
          s.averageTenths <= Math.max(...present) * 10
        );
      }),
    );
  });
});

describe("helpers", () => {
  it("reviewer initial only", () => {
    expect(reviewerInitial("sara")).toBe("S");
    expect(reviewerInitial("  منى")).toBe("م");
    expect(reviewerInitial("")).toBeNull();
    expect(reviewerInitial("1234")).toBeNull();
    expect(reviewerInitial(null)).toBeNull();
  });
  it("detects contact info incl. Arabic digits", () => {
    expect(containsContactInfo("call me 01001234567")).toBe(true);
    expect(containsContactInfo("كلموني ٠١٠٠١٢٣٤٥٦٧")).toBe(true);
    expect(containsContactInfo("see www.shop.com")).toBe(true);
    expect(containsContactInfo("me@mail.com")).toBe(true);
    expect(containsContactInfo("Size M, 2 washes, 100% cotton")).toBe(false);
    expect(toAsciiDigits("٠١٢۳")).toBe("0123");
  });
  it("sla window is 48h from publication", () => {
    const due = qaSlaDueAt(1000);
    expect(due).toBe(1000 + 48 * 3_600_000);
    expect(isQaOverdue({ slaDueAtMs: due, answeredAtMs: null }, due - 1)).toBe(false);
    expect(isQaOverdue({ slaDueAtMs: due, answeredAtMs: null }, due)).toBe(true);
    expect(isQaOverdue({ slaDueAtMs: due, answeredAtMs: 5 }, due + 10)).toBe(false);
    expect(isQaOverdue({ slaDueAtMs: null, answeredAtMs: null }, due + 10)).toBe(false);
  });
  it("cursor round trips and rejects junk", () => {
    const p = { ms: 1_800_000_000_000, id: "00000000-0000-4000-8000-000000000001" };
    expect(decodeCursor(encodeCursor(p))).toEqual(p);
    expect(decodeCursor("garbage")).toBeNull();
    expect(decodeCursor("zz.not-a-uuid")).toBeNull();
  });
});
