import { describe, expect, it } from "vitest";
import {
  FIXTURE_COVERAGE, FIXTURE_QUOTE, FakePaymentLauncher, InMemoryCheckoutPort, applyOrderStatus, applyPlaceFailure, applyPlaceResult,
  beginSubmit, buildPlaceRequest, computeTotals, initialSelection, installmentLine, needsReconfirmation, placeBlockers,
  requestFingerprint, setGovernorate, uuidv7, validateAddress, visiblePaymentMethods,
  type AddressDraft, type CheckoutQuote, type CheckoutSelection, type Submission,
} from "./model";

const goodAddress: AddressDraft = {
  governorateId: "cairo", cityId: "nasr", street: "Abbas", building: "5", floor: "2", apartment: "4", landmark: "Mosque", pin: { lat: 30, lng: 31 },
};
const withAddr = (s: CheckoutSelection, a: AddressDraft = goodAddress): CheckoutSelection => ({ ...s, address: a, paymentMethodId: "card" });
const noDelta: CheckoutQuote = {
  ...FIXTURE_QUOTE,
  shipments: FIXTURE_QUOTE.shipments.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, confirmedUnitPrice: l.unitPrice })) })),
};

describe("address", () => {
  it("requires governorate, a city inside it, street and building", () => {
    expect(validateAddress({ ...goodAddress, governorateId: null }, FIXTURE_COVERAGE, false)).toContain("governorate");
    expect(validateAddress({ ...goodAddress, cityId: "dokki" }, FIXTURE_COVERAGE, false)).toContain("city");
    expect(validateAddress({ ...goodAddress, street: " ", building: "" }, FIXTURE_COVERAGE, false)).toEqual(["street", "building"]);
    expect(validateAddress(goodAddress, FIXTURE_COVERAGE, false)).toEqual([]);
  });
  it("needs landmark and pin only for COD", () => {
    const a = { ...goodAddress, landmark: "", pin: null };
    expect(validateAddress(a, FIXTURE_COVERAGE, false)).toEqual([]);
    expect(validateAddress(a, FIXTURE_COVERAGE, true)).toEqual(["landmark", "pin"]);
  });
  it("clears a city that does not belong to the new governorate", () => {
    expect(setGovernorate(goodAddress, FIXTURE_COVERAGE, "giza").cityId).toBeNull();
    expect(setGovernorate(goodAddress, FIXTURE_COVERAGE, "cairo").cityId).toBe("nasr");
  });
});

describe("payment methods", () => {
  it("hides kill-switched methods and keeps unavailable COD with its reason", () => {
    const ids = visiblePaymentMethods(FIXTURE_QUOTE).map((m) => m.id);
    expect(ids).not.toContain("fawry");
    const cod = visiblePaymentMethods(FIXTURE_QUOTE).find((m) => m.id === "cod");
    expect(cod?.available).toBe(false);
    expect(cod?.unavailableReason?.ar.length).toBeGreaterThan(0);
    expect(cod?.unavailableReason?.en.length).toBeGreaterThan(0);
  });
  it("shows an installment line only from the provider quote, flagged as an estimate", () => {
    const valu = FIXTURE_QUOTE.paymentMethods.find((m) => m.id === "valu")!;
    expect(installmentLine(valu)).toMatchObject({ providerName: "valU", monthly: 41_000n, estimatedFromProvider: true });
    const card = FIXTURE_QUOTE.paymentMethods.find((m) => m.id === "card")!;
    expect(installmentLine(card)).toBeNull();
  });
});

describe("totals", () => {
  const sel = initialSelection(noDelta);
  it("sums merchandise, per-shipment delivery and every fee", () => {
    const q: CheckoutQuote = { ...noDelta, fees: [{ id: "f", name: { ar: "x", en: "x" }, amount: 1_000n }] };
    const t = computeTotals(q, { ...sel, delivery: { sh1: "fast", sh2: "std" } });
    expect(t.merchandise).toBe(119_000n + 76_000n + 18_000n);
    expect(t.delivery).toBe(6_000n + 4_500n);
    expect(t.otherFees).toBe(1_000n);
    expect(t.totalBeforeCredit).toBe(213_000n + 10_500n + 1_000n);
  });
  it("defaults to the cheapest option per shipment", () => {
    expect(sel.delivery).toEqual({ sh1: "std", sh2: "std" });
  });
  it("splits tender: store credit first, remainder external, never negative", () => {
    const t = computeTotals(noDelta, { ...sel, useStoreCredit: true, voucherCodes: ["WELCOME"] });
    expect(t.voucherDiscount).toBe(5_000n);
    expect(t.storeCreditApplied).toBe(15_000n);
    expect(t.payable).toBe(t.totalBeforeCredit - 15_000n);
    const rich: CheckoutQuote = { ...noDelta, storeCreditBalance: 10_000_000n };
    const t2 = computeTotals(rich, { ...sel, useStoreCredit: true });
    expect(t2.payable).toBe(0n);
    expect(t2.storeCreditApplied).toBe(t2.totalBeforeCredit);
  });
  it("counts only verified savings (VRP present and above price)", () => {
    expect(computeTotals(noDelta, sel).verifiedSavings).toBe(30_000n);
    const none: CheckoutQuote = { ...noDelta, shipments: noDelta.shipments.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, verifiedReferencePrice: null })) })) };
    expect(computeTotals(none, sel).verifiedSavings).toBe(0n);
  });
  it("reports the price delta against what the shopper confirmed", () => {
    expect(computeTotals(FIXTURE_QUOTE, initialSelection(FIXTURE_QUOTE)).priceDelta).toBe(6_000n);
  });
});

describe("place blockers and reconfirmation", () => {
  it("blocks until address, delivery and a method are complete", () => {
    const s = initialSelection(noDelta);
    expect(placeBlockers(noDelta, s, null)).toEqual(["address", "paymentMethod"]);
    expect(placeBlockers(noDelta, withAddr(s), null)).toEqual([]);
  });
  it("blocks an unavailable method (COD over cap)", () => {
    const s = { ...withAddr(initialSelection(noDelta)), paymentMethodId: "cod" };
    expect(placeBlockers(noDelta, s, null)).toContain("methodUnavailable");
  });
  it("requires re-confirmation of the exact delta and asks again if it moves", () => {
    const s = withAddr(initialSelection(FIXTURE_QUOTE));
    expect(placeBlockers(FIXTURE_QUOTE, s, null)).toEqual(["reconfirm"]);
    expect(placeBlockers(FIXTURE_QUOTE, s, 6_000n)).toEqual([]);
    expect(placeBlockers(FIXTURE_QUOTE, s, 5_000n)).toEqual(["reconfirm"]);
    expect(needsReconfirmation(computeTotals(FIXTURE_QUOTE, s), 6_000n)).toBe(false);
  });
  it("needs no external method when credit covers everything", () => {
    const rich: CheckoutQuote = { ...noDelta, storeCreditBalance: 10_000_000n };
    const s = { ...withAddr(initialSelection(rich)), paymentMethodId: null, useStoreCredit: true };
    expect(placeBlockers(rich, s, null)).toEqual([]);
    expect(buildPlaceRequest(rich, s, computeTotals(rich, s)).paymentMethodId).toBeNull();
  });
});

describe("uuidv7", () => {
  it("has version 7, RFC variant and an embedded sortable timestamp", () => {
    const id = uuidv7(1_760_000_000_000, new Uint8Array(10).fill(255));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const a = uuidv7(1_000, new Uint8Array(10));
    const b = uuidv7(2_000, new Uint8Array(10));
    expect(a < b).toBe(true);
  });
  it("rejects too little randomness", () => {
    expect(() => uuidv7(1, new Uint8Array(3))).toThrow();
  });
});

describe("duplicate-tap protection", () => {
  const sel = withAddr(initialSelection(noDelta));
  const req = buildPlaceRequest(noDelta, sel, computeTotals(noDelta, sel));
  const fp = requestFingerprint(req);
  let n = 0;
  const mk = () => `key-${++n}`;

  it("generates one key per attempt and ignores taps while in flight", () => {
    n = 0;
    const first = beginSubmit({ status: "idle" }, fp, mk);
    expect(first).toMatchObject({ start: true, key: "key-1" });
    const second = beginSubmit(first.submission, fp, mk);
    expect(second.start).toBe(false);
    expect(n).toBe(1);
  });
  it("reuses the key when retrying the same request after a network drop", () => {
    n = 0;
    const s = beginSubmit({ status: "idle" }, fp, mk);
    if (!s.start || s.submission.status !== "submitting") throw new Error("expected submitting");
    const failed = applyPlaceFailure(s.submission);
    const retry = beginSubmit(failed, fp, mk);
    expect(retry).toMatchObject({ start: true, key: "key-1" });
    expect(n).toBe(1);
  });
  it("uses a new key when the request body changed", () => {
    n = 0;
    const failed: Submission = { status: "failed", key: "old", fingerprint: "other", reason: null, retryable: true };
    expect(beginSubmit(failed, fp, mk)).toMatchObject({ start: true, key: "key-1" });
    const hard: Submission = { status: "failed", key: "old", fingerprint: fp, reason: null, retryable: false };
    expect(beginSubmit(hard, fp, mk)).toMatchObject({ start: true, key: "key-2" });
  });
  it("fingerprint changes with the payment method", () => {
    const other = buildPlaceRequest(noDelta, { ...sel, paymentMethodId: "valu" }, computeTotals(noDelta, sel));
    expect(requestFingerprint(other)).not.toBe(fp);
  });
});

describe("placing and resuming", () => {
  const sel = withAddr(initialSelection(noDelta));
  const req = buildPlaceRequest(noDelta, sel, computeTotals(noDelta, sel));
  const submitting = { status: "submitting", key: "k", fingerprint: "f" } as const;

  it("maps each server result to a submission state", () => {
    expect(applyPlaceResult(submitting, { kind: "placed", orderGroupId: "og" }, true).submission).toEqual({ status: "done", orderGroupId: "og", cod: true });
    expect(applyPlaceResult(submitting, { kind: "requires_action", orderGroupId: "og", action: { type: "redirect", url: "https://x" } }, false).submission.status).toBe("awaitingPayment");
    const changed = applyPlaceResult(submitting, { kind: "price_changed", quote: FIXTURE_QUOTE }, false);
    expect(changed.submission.status).toBe("idle");
    expect(changed.quote).toBe(FIXTURE_QUOTE);
    const rej = applyPlaceResult(submitting, { kind: "rejected", reason: { ar: "ا", en: "x" }, retryable: false }, false).submission;
    expect(rej).toMatchObject({ status: "failed", retryable: false });
  });
  it("server status is the source of truth after the redirect or a resume", () => {
    const aw = { status: "awaitingPayment", key: "k", fingerprint: "f", orderGroupId: "og" } as const;
    expect(applyOrderStatus(aw, "pending_payment")).toBe(aw);
    expect(applyOrderStatus(aw, "paid")).toMatchObject({ status: "done", cod: false });
    expect(applyOrderStatus(aw, "failed")).toMatchObject({ status: "failed", retryable: false });
  });
  it("fake port replays the stored response for a repeated key (no double order)", async () => {
    const port = new InMemoryCheckoutPort(noDelta);
    port.setPlaceResult({ kind: "requires_action", orderGroupId: "og-9", action: { type: "none" } });
    const a = await port.place(req, "same");
    port.setPlaceResult({ kind: "placed", orderGroupId: "different" });
    const b = await port.place(req, "same");
    expect(b).toEqual(a);
  });
  it("fake launcher records the client action without any card data", async () => {
    const l = new FakePaymentLauncher("succeeded");
    expect(await l.launch({ type: "sdk_sheet", sessionToken: "tok" })).toBe("succeeded");
    expect(l.launched).toHaveLength(1);
  });
});
