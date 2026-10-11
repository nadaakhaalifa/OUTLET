import { describe, expect, it } from "vitest";
import {
  RETURN_POLICY,
  evaluateReturnRequest,
  inspectionDueAtMs,
  isInspectionOverdue,
  isSellerFault,
  shippingPayerFor,
  windowClassOf,
  windowEndsAtMs,
  type ReturnRequestFacts,
} from "./policy";
import { MS_PER_DAY, RETURN_REASONS } from "./types";

const T0 = 1_800_000_000_000;
const base: ReturnRequestFacts = {
  reason: "changed_mind",
  resolution: "refund",
  qty: 1,
  openQty: 1,
  returnClass: "standard",
  deliveredAtMs: T0,
  nowMs: T0 + MS_PER_DAY,
  photoCount: 0,
  hasExchangeSku: false,
  plusMember: false,
  freeReturnsRemoved: false,
  firstExchangeForLine: true,
};
const at = (days: number, over: Partial<ReturnRequestFacts> = {}) =>
  evaluateReturnRequest({ ...base, nowMs: T0 + days * MS_PER_DAY, ...over });

describe("windows count from courier-confirmed delivered_at", () => {
  it("day 15 change of mind is refused with Arabic and English reasons", () => {
    const r = at(15);
    expect(r.eligible).toBe(false);
    if (r.eligible) return;
    expect(r.code).toBe("window_elapsed");
    expect(r.reason.ar).toMatch(/[؀-ۿ]/);
    expect(r.reason.en.length).toBeGreaterThan(10);
    expect(r.windowEndsAtMs).toBe(T0 + 14 * MS_PER_DAY);
  });

  it("day 29 defect with a photo is accepted, day 31 is refused", () => {
    const ok = at(29, { reason: "defective", photoCount: 1 });
    expect(ok.eligible).toBe(true);
    expect(at(31, { reason: "defective", photoCount: 1 }).eligible).toBe(false);
  });

  it("the end instant is inclusive and one millisecond later is refused", () => {
    expect(evaluateReturnRequest({ ...base, nowMs: T0 + 14 * MS_PER_DAY }).eligible).toBe(true);
    expect(evaluateReturnRequest({ ...base, nowMs: T0 + 14 * MS_PER_DAY + 1 }).eligible).toBe(false);
  });

  it("an undelivered or future-dated delivery is not returnable", () => {
    for (const deliveredAtMs of [null, T0 + MS_PER_DAY * 5]) {
      const r = evaluateReturnRequest({ ...base, deliveredAtMs });
      expect(r.eligible).toBe(false);
      if (!r.eligible) expect(r.code).toBe("not_delivered");
    }
  });

  it("window classes and lengths follow spec 22", () => {
    expect(RETURN_REASONS.map((r) => [r, windowClassOf(r)])).toEqual([
      ["too_small", "size_exchange"],
      ["too_large", "size_exchange"],
      ["not_as_described", "defect"],
      ["defective", "defect"],
      ["changed_mind", "change_of_mind"],
      ["late", "change_of_mind"],
      ["wrong_item", "defect"],
    ]);
    expect(windowEndsAtMs(T0, "defect") - T0).toBe(30 * MS_PER_DAY);
    expect(windowEndsAtMs(T0, "size_exchange") - T0).toBe(14 * MS_PER_DAY);
  });
});

describe("classes, photos, quantity, exchange", () => {
  it("hygiene is refused for change of mind but accepted when defective", () => {
    const a = at(2, { returnClass: "hygiene" });
    expect(a.eligible).toBe(false);
    if (!a.eligible) expect(a.code).toBe("non_returnable_class");
    expect(at(2, { returnClass: "hygiene", reason: "defective", photoCount: 1 }).eligible).toBe(true);
    expect(at(2, { returnClass: "personalized", reason: "wrong_item" }).eligible).toBe(true);
  });

  it("defective and not_as_described need a photo", () => {
    for (const reason of ["defective", "not_as_described"] as const) {
      const r = at(2, { reason, photoCount: 0 });
      expect(r.eligible).toBe(false);
      if (!r.eligible) expect(r.code).toBe("photos_required");
    }
    expect(at(2, { reason: "wrong_item", photoCount: 0 }).eligible).toBe(true);
  });

  it("quantity must be within the open quantity", () => {
    for (const qty of [0, 2, -1, 1.5]) {
      const r = at(2, { qty, openQty: 1 });
      expect(r.eligible).toBe(false);
      if (!r.eligible) expect(r.code).toBe("qty_exceeds_returnable");
    }
  });

  it("an exchange needs a replacement SKU", () => {
    const r = at(2, { reason: "too_small", resolution: "exchange", hasExchangeSku: false });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.code).toBe("exchange_sku_required");
    expect(at(2, { reason: "too_small", resolution: "exchange", hasExchangeSku: true }).eligible).toBe(true);
  });
});

describe("who pays return shipping", () => {
  const p = (o: Partial<Parameters<typeof shippingPayerFor>[0]>) =>
    shippingPayerFor({
      reason: "changed_mind",
      resolution: "refund",
      plusMember: false,
      freeReturnsRemoved: false,
      firstExchangeForLine: true,
      ...o,
    });
  it("seller pays for non-conformance, even for a serial returner", () => {
    expect(p({ reason: "defective" })).toBe("seller");
    expect(p({ reason: "wrong_item", freeReturnsRemoved: true })).toBe("seller");
    expect(isSellerFault("late")).toBe(false);
  });
  it("shopper pays for change of mind, Plus is free", () => {
    expect(p({})).toBe("shopper");
    expect(p({ plusMember: true })).toBe("platform_free");
  });
  it("first size exchange is free, later ones are not, and removal of free returns wins", () => {
    expect(p({ reason: "too_small", resolution: "exchange" })).toBe("platform_free");
    expect(p({ reason: "too_small", resolution: "exchange", firstExchangeForLine: false })).toBe("shopper");
    expect(p({ reason: "too_small", resolution: "exchange", plusMember: true, freeReturnsRemoved: true })).toBe("shopper");
    expect(p({ reason: "too_large", resolution: "refund" })).toBe("shopper");
  });
  it("late delivery is free for the shopper", () => {
    expect(p({ reason: "late" })).toBe("platform_free");
  });
});

describe("inspection deadline", () => {
  it("is 48 hours and the boundary counts as elapsed", () => {
    expect(RETURN_POLICY.inspectionHours).toBe(48);
    const due = inspectionDueAtMs(T0);
    expect(due - T0).toBe(48 * 3_600_000);
    expect(isInspectionOverdue(due, due - 1)).toBe(false);
    expect(isInspectionOverdue(due, due)).toBe(true);
  });
});
