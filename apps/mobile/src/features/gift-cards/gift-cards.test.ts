import { describe, expect, it } from "vitest";
import { resources } from "../../../../../packages/i18n/src/index";
import {
  FIXTURE_GIFTS, InMemoryGiftCardsPort, buildPurchaseRequest, cairoDateKey, canSubmitRedeem, canVoid, codeProblem, expiryTerm,
  giftVisibility, normaliseCode, parseAmountEgp, potProgressPct, redeemStateFrom, validateContribution, validatePot, validatePurchase,
  type PurchaseDraft,
} from "./model";

const NOW = Date.UTC(2026, 5, 15, 10, 0, 0);
const draft = (o: Partial<PurchaseDraft> = {}): PurchaseDraft => ({
  design: "eid", amountText: "500", message: "Eid Mubarak", channel: "inApp", recipientContact: "", scheduleDate: "", ...o,
});

describe("amount parsing", () => {
  it("reads whole EGP in Western and Eastern digits", () => {
    expect(parseAmountEgp("1,000")).toBe(100_000n);
    expect(parseAmountEgp("١٥٠٠")).toBe(150_000n);
    expect(parseAmountEgp("12.5")).toBeNull();
    expect(parseAmountEgp("abc")).toBeNull();
    expect(parseAmountEgp("0")).toBeNull();
  });
});

describe("purchase validation", () => {
  const snap = { purchaserAdult: true };
  it("accepts 100 to 10,000 EGP and rejects outside", () => {
    expect(validatePurchase(draft({ amountText: "100" }), snap, NOW)).toEqual([]);
    expect(validatePurchase(draft({ amountText: "10000" }), snap, NOW)).toEqual([]);
    expect(validatePurchase(draft({ amountText: "99" }), snap, NOW)).toContain("amountTooLow");
    expect(validatePurchase(draft({ amountText: "10001" }), snap, NOW)).toContain("amountTooHigh");
  });
  it("needs a 21+ purchaser above 5,000 EGP", () => {
    const young = { purchaserAdult: false };
    expect(validatePurchase(draft({ amountText: "5000" }), young, NOW)).toEqual([]);
    expect(validatePurchase(draft({ amountText: "5001" }), young, NOW)).toContain("needsAdult");
  });
  it("requires a valid recipient for outside channels", () => {
    expect(validatePurchase(draft({ channel: "email" }), snap, NOW)).toContain("contactRequired");
    expect(validatePurchase(draft({ channel: "email", recipientContact: "a@b" }), snap, NOW)).toContain("contactInvalid");
    expect(validatePurchase(draft({ channel: "whatsapp", recipientContact: "+201001234567" }), snap, NOW)).toEqual([]);
  });
  it("checks the message length and the schedule window in Cairo time", () => {
    expect(validatePurchase(draft({ message: "x".repeat(201) }), snap, NOW)).toContain("messageTooLong");
    expect(validatePurchase(draft({ scheduleDate: "2026-06-14" }), snap, NOW)).toContain("schedulePast");
    expect(validatePurchase(draft({ scheduleDate: "2026-06-15" }), snap, NOW)).toEqual([]);
    expect(validatePurchase(draft({ scheduleDate: "2028-01-01" }), snap, NOW)).toContain("scheduleTooFar");
    expect(validatePurchase(draft({ scheduleDate: "2026-02-31" }), snap, NOW)).toContain("scheduleInvalid");
  });
  it("builds a request with integer piastres and no contact for in-app", () => {
    const r = buildPurchaseRequest(draft({ amountText: "1,250" }));
    expect(r.amount).toBe(125_000n);
    expect(r.recipientContact).toBeNull();
    expect(r.scheduledDate).toBeNull();
  });
  it("derives the Cairo date across the midnight boundary", () => {
    expect(cairoDateKey(Date.UTC(2026, 0, 31, 22, 30))).toBe("2026-02-01");
  });
  it("shows expiry as whole years when possible", () => {
    expect(expiryTerm(36)).toEqual({ unit: "years", count: 3 });
    expect(expiryTerm(18)).toEqual({ unit: "months", count: 18 });
  });
});

describe("redeem", () => {
  const code = "0123-4567-89AB-CDEFG";
  it("normalises Crockford ambiguity and separators", () => {
    expect(normaliseCode("o1l-i")).toBe("0111");
    expect(normaliseCode(code)).toBe("0123456789ABCDEFG");
  });
  it("checks format locally, so malformed codes never reach the server", () => {
    expect(codeProblem("")).toBe("empty");
    expect(codeProblem("ABC")).toBe("tooShort");
    expect(codeProblem("U".repeat(20))).toBe("badCharacters");
    expect(codeProblem(code)).toBeNull();
  });
  it("counts down attempts, answers wrong and unknown the same, then 429s", async () => {
    const port = new InMemoryGiftCardsPort();
    const outcomes = [];
    for (let i = 0; i < 6; i += 1) outcomes.push(await port.redeem("ZZZZZZZZZZZZZZZZ"));
    expect(outcomes.slice(0, 5).map((o) => (o.kind === "invalid" ? o.remainingAttempts : -1))).toEqual([4, 3, 2, 1, 0]);
    expect(outcomes[5]).toEqual({ kind: "rateLimited", retryAfterSeconds: 3600 });
    const state = redeemStateFrom(outcomes[5]!);
    expect(state.kind).toBe("locked");
    expect(canSubmitRedeem(state, code)).toBe(false);
  });
  it("allows the form again when idle or after an invalid answer", () => {
    expect(canSubmitRedeem({ kind: "idle" }, "0123456789ABCDEFG")).toBe(true);
    expect(canSubmitRedeem({ kind: "invalid", remainingAttempts: 2 }, "0123456789ABCDEFG")).toBe(true);
    expect(canSubmitRedeem({ kind: "disabled" }, "0123456789ABCDEFG")).toBe(false);
  });
  it("redeems a valid code to a credit amount", async () => {
    const out = await new InMemoryGiftCardsPort().redeem("0123456789ABCDEFG");
    expect(redeemStateFrom(out)).toEqual({ kind: "success", amount: 25_000n });
  });
});

describe("kill switches", () => {
  it("hides the feature entirely when both capabilities are off or unknown", () => {
    expect(giftVisibility(null)).toEqual({ visible: false });
    expect(giftVisibility({ sales: false, redemption: false })).toEqual({ visible: false });
    expect(giftVisibility({ sales: true, redemption: false })).toEqual({ visible: true, purchase: true, redeem: false });
    expect(giftVisibility({ sales: false, redemption: true })).toEqual({ visible: true, purchase: false, redeem: true });
  });
  it("the fake port refuses when its switch is off and replays purchases by key", async () => {
    const port = new InMemoryGiftCardsPort(FIXTURE_GIFTS);
    const req = buildPurchaseRequest(draft());
    const a = await port.purchase(req, "k");
    expect(await port.purchase(req, "k")).toEqual(a);
    port.setCapabilities({ sales: false, redemption: false });
    expect(await port.purchase(req, "k2")).toEqual({ kind: "disabled" });
    expect(await port.redeem("0123456789ABCDEFG")).toEqual({ kind: "disabled" });
  });
});

describe("cards and pots", () => {
  it("allows voiding only before delivery", () => {
    const c = FIXTURE_GIFTS.cards[0]!;
    expect(canVoid({ ...c, status: "ISSUED" })).toBe(true);
    expect(canVoid({ ...c, status: "DELIVERED" })).toBe(false);
    expect(canVoid({ ...c, status: "REDEEMED_PARTIAL" })).toBe(false);
  });
  it("computes honest pot progress from piastres", () => {
    expect(potProgressPct({ raised: 50_000n, target: 200_000n })).toBe(25);
    expect(potProgressPct({ raised: 300_000n, target: 200_000n })).toBe(100);
    expect(potProgressPct({ raised: 1n, target: 0n })).toBe(0);
  });
  it("enforces the 50 EGP contribution minimum and pot rules", () => {
    expect(validateContribution("49")).toBe("tooLow");
    expect(validateContribution("50")).toBeNull();
    expect(validateContribution("x")).toBe("invalid");
    expect(validatePot("1000", "2026-07-01", "Trip", NOW)).toEqual([]);
    expect(validatePot("50", "2026-06-15", "", NOW)).toEqual(["targetTooLow", "titleRequired", "closesPast"]);
  });
  it("contributions raise the pot in the fake", async () => {
    const port = new InMemoryGiftCardsPort();
    await port.contribute("p1", 10_000n);
    expect((await port.load()).pots[0]?.raised).toBe(60_000n);
  });
});

describe("gift card copy", () => {
  it("has no hard-coded numeric claims in marketing-style strings", () => {
    for (const lang of ["en", "ar"] as const) {
      const g = resources[lang].giftCards;
      for (const s of [g.closedLoopNote, g.purchase.heading, g.redeem.heading, g.pots.note]) {
        expect(/[0-9٠-٩]/.test(s.replace(/\{\{[^}]+\}\}/g, "")), s).toBe(false);
      }
    }
  });
});
