import { describe, expect, it } from "vitest";
import {
  DeletionBlockedError,
  ERASURE_PARKED_CODE,
  ForfeitureNotAcknowledgedError,
  InvalidPrivacyInputError,
  MAX_ERASURE_ATTEMPTS,
  beginErasure,
  completeExport,
  erasureBackoffMs,
  expireExportForErasure,
  isDeletionActive,
  isErasureParked,
  newExportRequest,
  recordBreach,
  recordErasureFailure,
  startDeletion,
  startExport,
  type DeletionRequest,
} from "./index";

const T0 = 1_800_000_000_000;
const clean = { openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 0n };

const erasing = (): DeletionRequest => {
  const r = startDeletion({ id: "d1", userId: "u1", acknowledgedForfeiture: false }, clean, T0);
  if (r.kind !== "ok") throw new Error("expected ok");
  return beginErasure(r.request, r.request.coolingEndsAtMs);
};

describe("privacy errors", () => {
  it("DeletionBlockedError lists blockers and ForfeitureNotAcknowledgedError has a message", () => {
    const e = new DeletionBlockedError([
      { kind: "open_orders", count: 2 },
      { kind: "open_returns", count: 1 },
    ]);
    expect(e.message).toBe("deletion blocked by: open_orders=2, open_returns=1");
    expect(e.blockers).toHaveLength(2);
    expect(new ForfeitureNotAcknowledgedError().message).toContain("forfeiture");
  });
});

describe("erasure retry and parking", () => {
  it("backoff doubles from 5 minutes and is capped at 6 hours; no wait before a failure", () => {
    expect(erasureBackoffMs(0)).toBe(0);
    expect(erasureBackoffMs(1)).toBe(5 * 60_000);
    expect(erasureBackoffMs(2)).toBe(10 * 60_000);
    expect(erasureBackoffMs(20)).toBe(6 * 3_600_000);
  });

  it("stays erasing and resumable until the attempt cap, then parks on hold for the DPO", () => {
    let r = erasing();
    for (let i = 1; i < MAX_ERASURE_ATTEMPTS; i++) {
      r = recordErasureFailure(r, T0 + i);
      expect(r.status).toBe("erasing");
      expect(r.failureCode).toBe("erasure_failed");
      expect(isErasureParked(r)).toBe(false);
      expect(isDeletionActive(r)).toBe(true);
    }
    r = recordErasureFailure(r, T0 + 99);
    expect(r.status).toBe("on_hold");
    expect(r.failureCode).toBe(ERASURE_PARKED_CODE);
    expect(r.attempts).toBe(MAX_ERASURE_ATTEMPTS);
    expect(isErasureParked(r)).toBe(true);
  });

  it("validates start input", () => {
    expect(() => startDeletion({ id: "d", userId: "u", acknowledgedForfeiture: false }, clean, T0, -1)).toThrow(
      InvalidPrivacyInputError,
    );
    expect(() => startDeletion({ id: "", userId: "u", acknowledgedForfeiture: false }, clean, T0)).toThrow(
      InvalidPrivacyInputError,
    );
    const r = startDeletion({ id: "d", userId: "u", acknowledgedForfeiture: false }, clean, T0, 0);
    expect(r.kind === "ok" && r.request.coolingEndsAtMs).toBe(T0);
  });
});

describe("export erased with the subject", () => {
  it("ends a ready export and drops the object reference regardless of the retention clock", () => {
    let r = newExportRequest({ id: "e1", userId: "u1", locale: "en" }, T0);
    r = completeExport(startExport(r, T0 + 1), "exports/e1.zip", T0 + 2);
    const e = expireExportForErasure(r, T0 + 3);
    expect(e.status).toBe("expired");
    expect(e.objectRef).toBeNull();
  });

  it("rejects bad export input", () => {
    expect(() => newExportRequest({ id: "", userId: "u", locale: "ar" }, T0)).toThrow(InvalidPrivacyInputError);
    expect(() => newExportRequest({ id: "e", userId: "u", locale: "fr" as "ar" }, T0)).toThrow(InvalidPrivacyInputError);
    const r = startExport(newExportRequest({ id: "e", userId: "u", locale: "ar" }, T0), T0);
    expect(() => completeExport(r, "", T0)).toThrow(InvalidPrivacyInputError);
  });
});

describe("breach input validation", () => {
  const ok = { id: "b1", detectedAtMs: T0, severity: "high" as const, summary: "s", affectedCount: 1 };
  it("rejects a missing id, blank summary, bad count and future detection", () => {
    expect(() => recordBreach({ ...ok, id: "" }, T0)).toThrow(InvalidPrivacyInputError);
    expect(() => recordBreach({ ...ok, summary: "  " }, T0)).toThrow(InvalidPrivacyInputError);
    expect(() => recordBreach({ ...ok, affectedCount: -1 }, T0)).toThrow(InvalidPrivacyInputError);
    expect(() => recordBreach({ ...ok, affectedCount: 1.5 }, T0)).toThrow(InvalidPrivacyInputError);
    expect(() => recordBreach({ ...ok, detectedAtMs: T0 + 1 }, T0)).toThrow(InvalidPrivacyInputError);
  });
});
