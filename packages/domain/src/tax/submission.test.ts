import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { backoffDelayMs, submissionMachine } from "./submission";
import { cairoDateOf, cairoDayWindow, reconcileDay, type ReconSubmission } from "./reconciliation";

const ctx = (attempts: number) => ({ attempts, maxAttempts: 3 });

describe("submission machine", () => {
  it("has no unreachable states or dead ends", () => {
    expect(submissionMachine.analyze().ok).toBe(true);
  });
  it("follows the happy and retry paths", () => {
    expect(submissionMachine.transition("QUEUED", "SUBMIT", ctx(1))).toBe("SUBMITTED");
    expect(submissionMachine.transition("SUBMITTED", "ACCEPT", ctx(1))).toBe("ACCEPTED");
    expect(submissionMachine.transition("SUBMITTED", "REJECT", ctx(1))).toBe("REJECTED");
    expect(submissionMachine.transition("SUBMITTED", "FAIL", ctx(2))).toBe("RETRY");
    expect(submissionMachine.transition("RETRY", "SUBMIT", ctx(3))).toBe("SUBMITTED");
    expect(submissionMachine.transition("SUBMITTED", "EXHAUST", ctx(3))).toBe("DEAD_LETTER");
    expect(submissionMachine.transition("DEAD_LETTER", "REQUEUE", ctx(3))).toBe("QUEUED");
  });
  it("guards the attempt budget and final states", () => {
    expect(() => submissionMachine.transition("SUBMITTED", "FAIL", ctx(3))).toThrow();
    expect(() => submissionMachine.transition("SUBMITTED", "EXHAUST", ctx(1))).toThrow();
    expect(() => submissionMachine.transition("ACCEPTED", "SUBMIT", ctx(1))).toThrow();
    expect(() => submissionMachine.transition("REJECTED", "REQUEUE", ctx(1))).toThrow();
  });
});

describe("backoffDelayMs", () => {
  it("is exact at the jitter edges and capped", () => {
    expect(backoffDelayMs(1, 0)).toBe(15_000);
    expect(backoffDelayMs(1, 0.999999)).toBe(30_000);
    expect(backoffDelayMs(2, 0)).toBe(30_000);
    expect(backoffDelayMs(50, 0.999999)).toBeLessThanOrEqual(3_600_000);
    expect(backoffDelayMs(50, 0)).toBe(1_800_000);
  });
  it("property: within [exp/2, exp] and non decreasing in the lower bound", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (a, r) => {
        const exp = Math.min(3_600_000, 30_000 * 2 ** (a - 1));
        const d = backoffDelayMs(a, r);
        expect(d).toBeGreaterThanOrEqual(Math.floor(exp / 2));
        expect(d).toBeLessThanOrEqual(exp);
      }),
    );
  });
  it("rejects bad input", () => {
    expect(() => backoffDelayMs(0, 0.5)).toThrow();
    expect(() => backoffDelayMs(1, 1)).toThrow();
  });
});

const sub = (id: string, state: ReconSubmission["state"], o: Partial<ReconSubmission> = {}): ReconSubmission => ({
  internalId: id,
  state,
  gross: 100n,
  etaUuid: state === "ACCEPTED" ? `uuid-${id}` : null,
  signedDocumentRef: state === "ACCEPTED" ? `ref-${id}` : null,
  lastSubmittedAtMs: 1_000,
  ...o,
});

describe("reconcileDay", () => {
  it("counts submitted vs accepted vs rejected and flags problems", () => {
    const r = reconcileDay({
      date: "2026-10-10",
      nowMs: 1_000 + 7 * 3_600_000,
      submissions: [
        sub("a", "ACCEPTED"),
        sub("b", "ACCEPTED", { signedDocumentRef: null }),
        sub("c", "REJECTED"),
        sub("d", "SUBMITTED"),
        sub("e", "QUEUED"),
        sub("f", "DEAD_LETTER"),
      ],
      etaReport: [
        { internalId: "a", status: "ACCEPTED" },
        { internalId: "b", status: "REJECTED" },
        { internalId: "z", status: "ACCEPTED" },
      ],
    });
    expect(r.documents).toBe(6);
    expect(r.submitted).toBe(5);
    expect([r.accepted, r.rejected]).toEqual([2, 1]);
    expect(r.acceptanceRateBps).toBe(6666);
    const kinds = r.discrepancies.map((d) => `${d.internalId}:${d.kind}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "b:accepted_without_signed_document",
        "b:status_mismatch",
        "c:rejected",
        "c:missing_at_eta",
        "d:stale_submitted",
        "d:missing_at_eta",
        "f:dead_letter",
        "z:unknown_at_eta",
      ]),
    );
    expect(r.reconciled).toBe(false);
    expect(r.grossByState.ACCEPTED).toBe(200n);
  });
  it("is reconciled when everything is accepted and matches", () => {
    const r = reconcileDay({
      date: "2026-10-10",
      nowMs: 5_000,
      submissions: [sub("a", "ACCEPTED")],
      etaReport: [{ internalId: "a", status: "ACCEPTED" }],
    });
    expect(r.reconciled).toBe(true);
    expect(r.acceptanceRateBps).toBe(10_000);
  });
  it("skips ETA comparison when the report is unavailable and handles empty days", () => {
    const r = reconcileDay({ date: "2026-10-10", nowMs: 0, submissions: [], etaReport: null });
    expect(r.acceptanceRateBps).toBeNull();
    expect(r.reconciled).toBe(true);
    expect(() => reconcileDay({ date: "10/10/2026", nowMs: 0, submissions: [], etaReport: null })).toThrow();
  });
});

describe("cairoDayWindow", () => {
  it("covers a 24h day in winter (UTC+2) and summer (UTC+3)", () => {
    const w = cairoDayWindow("2026-01-15");
    expect(w.startMs).toBe(Date.UTC(2026, 0, 14, 22));
    expect(w.endMs - w.startMs).toBe(86_400_000);
    const s = cairoDayWindow("2026-07-15");
    expect(s.startMs).toBe(Date.UTC(2026, 6, 14, 21));
    expect(cairoDateOf(s.startMs)).toBe("2026-07-15");
    expect(cairoDateOf(s.endMs - 1)).toBe("2026-07-15");
  });
  it("rejects invalid dates", () => {
    expect(() => cairoDayWindow("2026-02-30")).toThrow();
    expect(() => cairoDayWindow("x")).toThrow();
  });
});
