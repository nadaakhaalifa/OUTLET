import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GuardRejectedError, InvalidTransitionError } from "../state-machine/errors";
import {
  DELETION_EVENTS,
  EXPORT_EVENTS,
  BREACH_EVENTS,
  MAX_EXPORT_ATTEMPTS,
  beginErasure,
  breachMachine,
  cancelDeletion,
  closeBreach,
  completeErasure,
  completeExport,
  deletionMachine,
  exportMachine,
  expireExport,
  failExport,
  holdDeletion,
  isDownloadable,
  isExportOverdue,
  newExportRequest,
  notifyPdpc,
  notifySubjects,
  recordBreach,
  startDeletion,
  startExport,
  triageBreach,
  type DeletionRequest,
  type DeletionSnapshot,
  type ExportRequest,
  NotYetExpirableError,
  EXPORT_ARTIFACT_RETENTION_MS,
  EXPORT_READY_TARGET_MS,
} from "./index";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const clean: DeletionSnapshot = { openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 0n };

describe("machine analysis", () => {
  it.each([
    ["export", exportMachine],
    ["deletion", deletionMachine],
    ["breach", breachMachine],
  ] as const)("%s machine has no unreachable state, dead end or terminal with outgoing edges", (_n, m) => {
    expect(m.analyze().ok).toBe(true);
  });
});

describe("export request", () => {
  const fresh = (): ExportRequest => newExportRequest({ id: "e1", userId: "u1", locale: "ar" }, T0);

  it("targets readiness within 72 hours", () => {
    const r = fresh();
    expect(r.readyTargetAtMs - r.requestedAtMs).toBe(EXPORT_READY_TARGET_MS);
    expect(isExportOverdue(r, T0 + EXPORT_READY_TARGET_MS)).toBe(false);
    expect(isExportOverdue(r, T0 + EXPORT_READY_TARGET_MS + 1)).toBe(true);
  });

  it("happy path to ready then expired after retention", () => {
    let r = startExport(fresh(), T0 + 1);
    r = completeExport(r, "exports/e1.zip", T0 + 2);
    expect(r.status).toBe("ready");
    expect(isDownloadable(r, T0 + 3)).toBe(true);
    expect(isDownloadable(r, T0 + 2 + EXPORT_ARTIFACT_RETENTION_MS)).toBe(false);
    expect(() => expireExport(r, T0 + 10)).toThrow(NotYetExpirableError);
    const e = expireExport(r, T0 + 2 + EXPORT_ARTIFACT_RETENTION_MS);
    expect(e.status).toBe("expired");
    expect(e.objectRef).toBeNull();
  });

  it("retries until attempts are exhausted, then fails terminally", () => {
    let r = fresh();
    for (let i = 1; i < MAX_EXPORT_ATTEMPTS; i++) {
      r = failExport(startExport(r, T0 + i), "exporter_error", T0 + i);
      expect(r.status).toBe("requested");
      expect(r.attempts).toBe(i);
    }
    r = failExport(startExport(r, T0 + 9), "exporter_error", T0 + 9);
    expect(r.status).toBe("failed");
    expect(() => startExport(r, T0 + 10)).toThrow(InvalidTransitionError);
  });

  it("rejects illegal transitions and abandoning with attempts left", () => {
    const r = fresh();
    expect(() => completeExport(r, "x", T0)).toThrow(InvalidTransitionError);
    expect(() => exportMachine.transition("collecting", "abandon", { attempts: 1 })).toThrow(GuardRejectedError);
  });

  it("property: any event sequence either throws a typed error or keeps invariants", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...EXPORT_EVENTS), { maxLength: 25 }), (events) => {
        let r = fresh();
        let t = T0;
        for (const ev of events) {
          t += 1;
          const before = r;
          try {
            if (ev === "start") r = startExport(r, t);
            else if (ev === "complete") r = completeExport(r, "k", t);
            else if (ev === "retry" || ev === "abandon") r = failExport(r, "c", t);
            else r = expireExport(r, t + EXPORT_ARTIFACT_RETENTION_MS);
          } catch (e) {
            expect(e).toBeInstanceOf(Error);
            expect(r).toBe(before);
            continue;
          }
          expect(r.version).toBe(before.version + 1);
          expect(exportMachine.isState(r.status)).toBe(true);
          expect(r.attempts).toBeLessThanOrEqual(MAX_EXPORT_ATTEMPTS);
          if (r.status === "ready") expect(r.objectRef).not.toBeNull();
          if (before.status === "failed" || before.status === "expired") expect(r).toBe(before);
        }
      }),
    );
  });
});

describe("deletion request", () => {
  const open = (): DeletionRequest => {
    const r = startDeletion({ id: "d1", userId: "u1", acknowledgedForfeiture: false }, clean, T0);
    if (r.kind !== "ok") throw new Error("expected ok");
    return r.request;
  };

  it("blocks with exact reasons and counts", () => {
    const r = startDeletion(
      { id: "d", userId: "u", acknowledgedForfeiture: true },
      { ...clean, openOrders: 2, openDisputes: 1 },
      T0,
    );
    expect(r).toEqual({
      kind: "blocked",
      blockers: [
        { kind: "open_orders", count: 2 },
        { kind: "open_disputes", count: 1 },
      ],
    });
  });

  it("requires explicit acknowledgement of store-credit forfeiture", () => {
    const snap = { ...clean, storeCreditMinor: 12_500n };
    expect(startDeletion({ id: "d", userId: "u", acknowledgedForfeiture: false }, snap, T0)).toEqual({
      kind: "forfeiture_ack_required",
      balanceMinor: 12_500n,
    });
    const ok = startDeletion({ id: "d", userId: "u", acknowledgedForfeiture: true }, snap, T0);
    expect(ok.kind === "ok" && ok.request.forfeitedCreditMinor).toBe(12_500n);
  });

  it("cooling is exactly 14 days; cancel only while cooling", () => {
    const r = open();
    expect(r.coolingEndsAtMs - r.requestedAtMs).toBe(14 * DAY);
    expect(cancelDeletion(r, r.coolingEndsAtMs - 1).status).toBe("cancelled");
    expect(() => cancelDeletion(r, r.coolingEndsAtMs)).toThrow(GuardRejectedError);
  });

  it("cannot erase before cooling ends; erases and completes after", () => {
    const r = open();
    expect(() => beginErasure(r, r.coolingEndsAtMs - 1)).toThrow(GuardRejectedError);
    const e = beginErasure(r, r.coolingEndsAtMs);
    expect(completeErasure(e, r.coolingEndsAtMs + 5).status).toBe("completed");
  });

  it("parks on hold when a blocker appears and can be cancelled from hold", () => {
    const r = open();
    const h = holdDeletion(r, [{ kind: "open_orders", count: 1 }], r.coolingEndsAtMs);
    expect(h.status).toBe("on_hold");
    expect(cancelDeletion(h, r.coolingEndsAtMs + 10).status).toBe("cancelled");
    expect(beginErasure(h, r.coolingEndsAtMs + 10).status).toBe("erasing");
  });

  it("property: event sequences never leave the declared state space or move out of terminal states", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...DELETION_EVENTS), fc.integer({ min: 0, max: 20 })), { maxLength: 20 }),
        (steps) => {
          let r = open();
          for (const [ev, days] of steps) {
            const now = T0 + days * DAY;
            const before = r;
            try {
              if (ev === "hold") r = holdDeletion(r, [{ kind: "open_returns", count: 1 }], now);
              else if (ev === "cancel") r = cancelDeletion(r, now);
              else if (ev === "begin_erasure") r = beginErasure(r, now);
              else r = completeErasure(r, now);
            } catch {
              expect(r).toBe(before);
              continue;
            }
            expect(deletionMachine.isState(r.status)).toBe(true);
            if (before.status === "cancelled" || before.status === "completed") expect.fail("left a terminal state");
            if (r.status === "erasing") expect(now).toBeGreaterThanOrEqual(r.coolingEndsAtMs);
          }
        },
      ),
    );
  });
});

describe("breach machine", () => {
  const b0 = () =>
    recordBreach({ id: "b1", detectedAtMs: T0, severity: "high", summary: "s3 bucket misconfig", affectedCount: 10 }, T0 + 1);

  it("walks detect, triage, PDPC, subjects, close", () => {
    let b = triageBreach(b0(), "notify", T0 + 10);
    b = notifyPdpc(b, T0 + 20);
    b = notifySubjects(b, T0 + 30);
    expect(closeBreach(b, T0 + 40).status).toBe("closed");
  });

  it("closes without notices only when the DPO decided none are required", () => {
    const n = triageBreach(b0(), "notify", T0 + 10);
    expect(() => closeBreach(n, T0 + 11)).toThrow(GuardRejectedError);
    const none = triageBreach(b0(), "no_notification_required", T0 + 10);
    expect(() => notifyPdpc(none, T0 + 11)).toThrow(GuardRejectedError);
    expect(closeBreach(none, T0 + 12).status).toBe("closed");
  });

  it("property: events never skip the DPO decision", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...BREACH_EVENTS), { maxLength: 12 }), (events) => {
        let b = b0();
        for (const ev of events) {
          try {
            if (ev === "triage") b = triageBreach(b, "notify", T0 + 5);
            else if (ev === "notify_pdpc") b = notifyPdpc(b, T0 + 6);
            else if (ev === "notify_subjects") b = notifySubjects(b, T0 + 7);
            else b = closeBreach(b, T0 + 8);
          } catch {
            continue;
          }
          if (b.pdpcNotifiedAtMs !== null) expect(b.dpoDecision).toBe("notify");
          if (b.subjectsNotifiedAtMs !== null) expect(b.pdpcNotifiedAtMs).not.toBeNull();
        }
      }),
    );
  });
});
