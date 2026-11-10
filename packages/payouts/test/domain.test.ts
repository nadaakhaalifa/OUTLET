import { readFileSync } from "node:fs";
import { transition, can, reachable } from "@outlet/orders";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DAY_MS, ESCALATION_AGE_MS, PAYOUT, PAYOUT_EVENTS, PAYOUT_STATES, PRE_SEND_STATES, PayoutsError, cairoDate, eligibleAt, ibanNameMatches, isEligible, matchSettlementLine,
  normalizeHolderName, parseSettlement, parseSettlementCsv, parseSettlementJson, planPayout, shouldEscalate, weeklyCycle,
} from "../src/index.js";

describe("payout state machine", () => {
  it("every state is reachable from SCHEDULED and terminal states have no exits", () => {
    expect([...reachable(PAYOUT)].sort()).toEqual([...PAYOUT_STATES].sort());
    for (const s of PAYOUT.terminal) expect(Object.keys(PAYOUT.table[s])).toEqual([]);
  });

  it("rejects every transition not in the table with a typed error", () => {
    for (const s of PAYOUT_STATES) {
      for (const e of PAYOUT_EVENTS) {
        if (can(PAYOUT, s, e)) expect(PAYOUT_STATES).toContain(transition(PAYOUT, s, e));
        else expect(() => transition(PAYOUT, s, e)).toThrow(/cannot/);
      }
    }
  });

  it("a payout can only be sent from APPROVED and settled from SENT (money moves nowhere else)", () => {
    const sendFrom = PAYOUT_STATES.filter((s) => can(PAYOUT, s, "send"));
    const settleFrom = PAYOUT_STATES.filter((s) => can(PAYOUT, s, "settle"));
    expect(sendFrom).toEqual(["APPROVED"]);
    expect(settleFrom).toEqual(["SENT"]);
    expect(PRE_SEND_STATES).not.toContain("SENT");
  });

  it("property: random event sequences stay inside the declared states and never leave a terminal state", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...PAYOUT_EVENTS), { maxLength: 25 }), (events) => {
        let s: (typeof PAYOUT_STATES)[number] = PAYOUT.initial;
        for (const e of events) {
          if (!can(PAYOUT, s, e)) continue;
          const wasTerminal = PAYOUT.terminal.includes(s);
          s = transition(PAYOUT, s, e);
          expect(wasTerminal).toBe(false);
          expect(PAYOUT_STATES).toContain(s);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("the SQL CHECK in migration 0018 lists exactly the machine states", () => {
    const sql = readFileSync(new URL("../../db/migrations/0018_payouts_reconciliation.sql", import.meta.url), "utf8");
    const block = /CREATE TABLE payouts \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
    const list = /status\s+text NOT NULL CHECK \(status IN \(([^)]*)\)\)/.exec(block)?.[1] ?? "";
    const states = [...list.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(states.sort()).toEqual([...PAYOUT_STATES].sort());
  });
});

describe("eligibility (closed + 3 days, no dispute)", () => {
  const closed = new Date("2030-01-01T10:00:00.000Z");
  const base = { status: "AVAILABLE" as const, sellerOrderId: "so1", eligibleAt: eligibleAt(closed), holds: [] };

  it("eligible_at is closed_at + 3 days by default and the boundary is inclusive", () => {
    expect(eligibleAt(closed).toISOString()).toBe("2030-01-04T10:00:00.000Z");
    expect(eligibleAt(closed, 0).toISOString()).toBe(closed.toISOString());
    expect(isEligible({ ...base, now: new Date(closed.getTime() + 3 * DAY_MS - 1) })).toBe(false);
    expect(isEligible({ ...base, now: new Date(closed.getTime() + 3 * DAY_MS) })).toBe(true);
    expect(isEligible({ ...base, now: new Date(closed.getTime() + 3 * DAY_MS + 1) })).toBe(true);
  });

  it("only AVAILABLE accruals with an eligible_at qualify", () => {
    const now = new Date(closed.getTime() + 10 * DAY_MS);
    for (const status of ["PENDING", "SCHEDULED", "SENT", "PAID"] as const) expect(isEligible({ ...base, status, now })).toBe(false);
    expect(isEligible({ ...base, eligibleAt: null, now })).toBe(false);
  });

  it("a store-wide hold or a hold on that seller order blocks; a hold on another order does not", () => {
    const now = new Date(closed.getTime() + 10 * DAY_MS);
    expect(isEligible({ ...base, now, holds: [{ sellerOrderId: null }] })).toBe(false);
    expect(isEligible({ ...base, now, holds: [{ sellerOrderId: "so1" }] })).toBe(false);
    expect(isEligible({ ...base, now, holds: [{ sellerOrderId: "other" }] })).toBe(true);
  });

  it("rejects an absurd grace period", () => {
    expect(() => eligibleAt(closed, -1)).toThrow(RangeError);
    expect(() => eligibleAt(closed, 61)).toThrow(RangeError);
    expect(() => eligibleAt(closed, 1.5)).toThrow(RangeError);
  });
});

describe("netting (chart 4.11)", () => {
  it("worked example: 49,699 eligible, 16,580 clawed back after an earlier payout => pays 33,119", () => {
    const plan = planPayout([{ id: "a", amountMinor: 49_699n, eligible: true }], 33_119n);
    expect(plan).toEqual({
      kind: "payout", grossMinor: 49_699n, adjustmentsMinor: -16_580n, netMinor: 33_119n,
      lines: [{ kind: "order", accrualId: "a", amountMinor: 49_699n }, { kind: "adjustment", accrualId: null, amountMinor: -16_580n }],
    });
  });

  it("closed-but-not-yet-eligible money is not paid even though it sits in seller_available", () => {
    const plan = planPayout([{ id: "a", amountMinor: 1000n, eligible: true }, { id: "b", amountMinor: 5000n, eligible: false }], 6000n);
    expect(plan).toMatchObject({ kind: "payout", netMinor: 1000n, adjustmentsMinor: 0n });
  });

  it("a debt larger than the eligible money pays nothing and carries forward", () => {
    expect(planPayout([{ id: "a", amountMinor: 1000n, eligible: true }], -500n)).toEqual({ kind: "none", reason: "no_balance" });
    expect(planPayout([{ id: "a", amountMinor: 1000n, eligible: true }], 0n)).toEqual({ kind: "none", reason: "no_balance" });
    expect(planPayout([{ id: "b", amountMinor: 1000n, eligible: false }], 1000n)).toEqual({ kind: "none", reason: "nothing_eligible" });
    expect(planPayout([], 0n)).toEqual({ kind: "none", reason: "nothing_eligible" });
  });

  it("rejects a non-positive accrual", () => {
    expect(() => planPayout([{ id: "a", amountMinor: 0n, eligible: true }], 10n)).toThrow(RangeError);
  });

  it("property: net <= available (I12), lines sum to net, net = gross + adjustments, blocked money is never paid", () => {
    const accrual = fc.record({ id: fc.uuid(), amountMinor: fc.bigInt({ min: 1n, max: 10_000_000n }), eligible: fc.boolean() });
    fc.assert(
      fc.property(fc.array(accrual, { maxLength: 12 }), fc.bigInt({ min: -5_000_000n, max: 60_000_000n }), (accruals, available) => {
        const plan = planPayout(accruals, available);
        if (plan.kind === "none") return;
        const blocked = accruals.filter((a) => !a.eligible).reduce((s, a) => s + a.amountMinor, 0n);
        expect(plan.netMinor).toBeGreaterThan(0n);
        expect(plan.netMinor).toBeLessThanOrEqual(available);
        expect(plan.netMinor).toBe(available - blocked);
        expect(plan.netMinor).toBe(plan.grossMinor + plan.adjustmentsMinor);
        expect(plan.lines.reduce((s, l) => s + l.amountMinor, 0n)).toBe(plan.netMinor);
        expect(plan.lines.every((l) => l.amountMinor !== 0n)).toBe(true);
        const paidIds = new Set(plan.lines.flatMap((l) => (l.accrualId === null ? [] : [l.accrualId])));
        for (const a of accruals) expect(paidIds.has(a.id)).toBe(a.eligible);
      }),
      { numRuns: 500 },
    );
  });
});

describe("weekly cycle in Africa/Cairo", () => {
  it("every day of one Cairo week yields the previous Monday to Sunday", () => {
    for (const d of ["2030-01-07", "2030-01-08", "2030-01-09", "2030-01-10", "2030-01-11", "2030-01-12", "2030-01-13"]) {
      expect(weeklyCycle(new Date(`${d}T12:00:00Z`))).toEqual({ start: "2029-12-31", end: "2030-01-06" });
    }
    expect(weeklyCycle(new Date("2030-01-14T12:00:00Z"))).toEqual({ start: "2030-01-07", end: "2030-01-13" });
  });

  it("uses the Cairo calendar date, not UTC (Sunday 22:30 UTC is already Monday in Cairo)", () => {
    expect(cairoDate(new Date("2030-01-06T22:30:00Z"))).toBe("2030-01-07");
    expect(weeklyCycle(new Date("2030-01-06T22:30:00Z"))).toEqual({ start: "2029-12-31", end: "2030-01-06" });
    expect(weeklyCycle(new Date("2030-01-06T21:30:00Z"))).toEqual({ start: "2029-12-24", end: "2029-12-30" });
  });

  it("follows Egypt's daylight saving time (UTC+3 in summer)", () => {
    expect(cairoDate(new Date("2030-07-14T21:30:00Z"))).toBe("2030-07-15");
    expect(cairoDate(new Date("2030-01-14T21:30:00Z"))).toBe("2030-01-14");
  });

  it("rejects an invalid date", () => {
    expect(() => cairoDate(new Date("nope"))).toThrow(RangeError);
  });
});

describe("IBAN holder name match", () => {
  it("matches across case, diacritics, legal-form words and word order", () => {
    expect(ibanNameMatches("Nile Fashion LLC", "NILE  fashion")).toBe(true);
    expect(ibanNameMatches("Fashion Nile Co.", "Nile Fashion")).toBe(true);
    expect(ibanNameMatches("Société Élégante", "Societe Elegante")).toBe(true);
  });
  it("folds Arabic letter variants and drops tashkeel", () => {
    expect(ibanNameMatches("شركة أزياء النيل", "ازياء النيل")).toBe(true);
    expect(ibanNameMatches("مَتْجَر الهُدى", "متجر الهدى")).toBe(true);
    expect(normalizeHolderName("المنصورة")).toEqual(["المنصوره"]);
  });
  it("fails closed on a different holder, a partial overlap and empty names", () => {
    expect(ibanNameMatches("Nile Fashion", "Delta Fashion")).toBe(false);
    expect(ibanNameMatches("Nile Fashion Trading", "Nile Fashion")).toBe(false);
    expect(ibanNameMatches("", "")).toBe(false);
    expect(ibanNameMatches("LLC", "Ltd")).toBe(false);
  });
});

describe("settlement file parsing", () => {
  const csv = "provider_ref,kind,amount_minor,fee_minor,currency,value_date\nref-1,capture,10000,250,EGP,2030-01-05\nref-2,refund,500,0,EGP,2030-01-05\n";
  it("parses CSV and JSON to the same lines", () => {
    const fromCsv = parseSettlementCsv(csv);
    expect(fromCsv).toEqual([
      { providerRef: "ref-1", kind: "capture", amountMinor: 10_000n, feeMinor: 250n, currency: "EGP", valueDate: "2030-01-05" },
      { providerRef: "ref-2", kind: "refund", amountMinor: 500n, feeMinor: 0n, currency: "EGP", valueDate: "2030-01-05" },
    ]);
    const json = JSON.stringify([
      { provider_ref: "ref-1", kind: "capture", amount_minor: "10000", fee_minor: "250", currency: "EGP", value_date: "2030-01-05" },
      { provider_ref: "ref-2", kind: "refund", amount_minor: "500", currency: "EGP", value_date: "2030-01-05" },
    ]);
    expect(parseSettlementJson(json)).toEqual(fromCsv);
    expect(parseSettlement("csv", csv)).toEqual(fromCsv);
    expect(parseSettlement("json", json)).toEqual(fromCsv);
  });

  it("rejects bad headers, cells, amounts (floats, negatives), dates and non-arrays", () => {
    const bad = (f: () => unknown): void => { expect(f).toThrow(PayoutsError); };
    bad(() => parseSettlementCsv("a,b\n1,2"));
    bad(() => parseSettlementCsv("provider_ref,kind,amount_minor,fee_minor,currency,value_date\nref,capture,1"));
    bad(() => parseSettlementCsv("provider_ref,kind,amount_minor,fee_minor,currency,value_date\nref,capture,12.5,0,EGP,2030-01-05"));
    bad(() => parseSettlementCsv("provider_ref,kind,amount_minor,fee_minor,currency,value_date\nref,capture,-5,0,EGP,2030-01-05"));
    bad(() => parseSettlementCsv("provider_ref,kind,amount_minor,fee_minor,currency,value_date\nref,capture,5,0,EGP,2030-13-45"));
    bad(() => parseSettlementCsv("provider_ref,kind,amount_minor,fee_minor,currency,value_date\nref,teleport,5,0,EGP,2030-01-05"));
    bad(() => parseSettlementJson("{"));
    bad(() => parseSettlementJson("{}"));
    bad(() => parseSettlementJson('[{"provider_ref":"x"}]'));
  });
});

describe("settlement line matching", () => {
  const intent = { id: "i1", provider: "paymob", amountMinor: 10_000n, currency: "EGP", status: "CAPTURED" };
  const cap = { kind: "capture" as const, amountMinor: 10_000n, currency: "EGP" };

  it("capture: exact amount on a captured intent matches", () => {
    expect(matchSettlementLine(cap, intent)).toEqual({ status: "matched", detail: null });
    expect(matchSettlementLine(cap, { ...intent, status: "PARTIALLY_REFUNDED" }).status).toBe("matched");
  });
  it("capture: every discrepancy is classified", () => {
    expect(matchSettlementLine(cap, undefined)).toEqual({ status: "unmatched", detail: "no_payment_intent" });
    expect(matchSettlementLine({ ...cap, amountMinor: 9_999n }, intent)).toEqual({ status: "mismatch", detail: "amount_differs" });
    expect(matchSettlementLine({ ...cap, currency: "USD" }, intent)).toEqual({ status: "mismatch", detail: "currency_differs" });
    expect(matchSettlementLine(cap, { ...intent, status: "CREATED" })).toEqual({ status: "mismatch", detail: "intent_not_captured" });
  });
  it("refund: needs a refunded intent and cannot exceed the capture", () => {
    const refund = { kind: "refund" as const, amountMinor: 4_000n, currency: "EGP" };
    expect(matchSettlementLine(refund, { ...intent, status: "PARTIALLY_REFUNDED" }).status).toBe("matched");
    expect(matchSettlementLine(refund, intent)).toEqual({ status: "mismatch", detail: "intent_not_refunded" });
    expect(matchSettlementLine({ ...refund, amountMinor: 10_001n }, { ...intent, status: "REFUNDED" })).toEqual({ status: "mismatch", detail: "refund_exceeds_capture" });
    expect(matchSettlementLine(refund, undefined).status).toBe("unmatched");
  });
  it("fees match on their own; chargebacks and payouts always go to manual review", () => {
    expect(matchSettlementLine({ kind: "fee", amountMinor: 100n, currency: "EGP" }, undefined).status).toBe("matched");
    expect(matchSettlementLine({ kind: "chargeback", amountMinor: 100n, currency: "EGP" }, intent)).toEqual({ status: "unmatched", detail: "manual_review" });
    expect(matchSettlementLine({ kind: "payout", amountMinor: 100n, currency: "EGP" }, intent).detail).toBe("manual_review");
  });
});

describe("escalation age", () => {
  const seen = new Date("2030-01-01T00:00:00Z");
  it("escalates only when strictly older than 3 days", () => {
    expect(ESCALATION_AGE_MS).toBe(3 * DAY_MS);
    expect(shouldEscalate(seen, new Date(seen.getTime() + 3 * DAY_MS))).toBe(false);
    expect(shouldEscalate(seen, new Date(seen.getTime() + 3 * DAY_MS + 1))).toBe(true);
    expect(shouldEscalate(seen, seen)).toBe(false);
  });
});
