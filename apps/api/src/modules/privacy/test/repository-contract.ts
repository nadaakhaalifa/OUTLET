import { beforeEach, describe, expect, it } from "vitest";
import type { ConsentRecord } from "@outlet/privacy";
import {
  beginErasure,
  cancelDeletion,
  completeExport,
  ERASURE_PARKED_CODE,
  MAX_ERASURE_ATTEMPTS,
  recordErasureFailure,
  failExport,
  holdDeletion,
  newExportRequest,
  notifyPdpc,
  recordBreach,
  startDeletion,
  startExport,
  triageBreach,
  type BreachEntry,
  type DeletionRequest,
  type ExportRequest,
} from "../domain/bridge";
import type { BreachRepository, ConsentRepository, OutboxDraft, PrivacyRequestRepository } from "../domain/ports";

export interface PrivacyRepoContext {
  readonly requests: PrivacyRequestRepository;
  readonly breaches: BreachRepository;
  readonly consents: ConsentRepository;
  /** Makes the user exist where the store enforces the FK; no-op in memory. */
  ensureUser(userId: string): Promise<void>;
  /** Event ids written so far, in insertion order. */
  eventTypes(): Promise<readonly string[]>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const E = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
export const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

const ev = (n: number, type: string, aggregateId: string): OutboxDraft => ({
  id: E(n),
  type,
  aggregateType: "dsar_request",
  aggregateId,
  occurredAtMs: T0,
  payload: { n },
});

const exportReq = (n: number, userId: string, over: Partial<ExportRequest> = {}): ExportRequest => ({
  ...newExportRequest({ id: U(100 + n), userId, locale: "ar" }, T0 + n),
  ...over,
});

const deletion = (n: number, userId: string, credit = 0n): DeletionRequest => {
  const r = startDeletion(
    { id: U(200 + n), userId, acknowledgedForfeiture: true },
    { openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: credit },
    T0 + n,
  );
  if (r.kind !== "ok") throw new Error("expected ok");
  return r.request;
};

const consent = (userId: string, purpose: ConsentRecord["purpose"], granted: boolean, atMs: number): ConsentRecord => ({
  userId,
  purpose,
  version: 1,
  granted,
  method: "settings_toggle",
  at: new Date(atMs).toISOString(),
  ipHash: "ab".repeat(16),
});

export function describePrivacyRepositoryContract(name: string, make: () => Promise<PrivacyRepoContext>): void {
  describe(`privacy repositories: ${name}`, () => {
    let c: PrivacyRepoContext;
    beforeEach(async () => {
      c = await make();
      for (const n of [1, 2, 3]) await c.ensureUser(U(n));
    });

    describe("requests", () => {
      it("creates an export once per open request and returns the open one afterwards", async () => {
        const a = await c.requests.insertExport(exportReq(1, U(1)), [ev(1, "privacy.export_requested", U(101))]);
        expect(a.kind).toBe("created");
        const b = await c.requests.insertExport(exportReq(2, U(1)), [ev(2, "privacy.export_requested", U(102))]);
        expect(b.kind).toBe("existing");
        expect(b.request.id).toBe(U(101));
        expect(await c.eventTypes()).toEqual(["privacy.export_requested"]);
        const other = await c.requests.insertExport(exportReq(3, U(2)), []);
        expect(other.kind).toBe("created");
      });

      it("keeps one open deletion per user, independent of exports, and allows a new one after cancel", async () => {
        const d1 = deletion(1, U(1));
        expect((await c.requests.insertDeletion(d1, [])).kind).toBe("created");
        expect((await c.requests.insertExport(exportReq(1, U(1)), [])).kind).toBe("created");
        expect((await c.requests.insertDeletion(deletion(2, U(1)), [])).kind).toBe("existing");
        expect(await c.requests.update(cancelDeletion(d1, T0 + 1000), [])).toBe("ok");
        expect((await c.requests.insertDeletion(deletion(3, U(1)), [])).kind).toBe("created");
      });

      it("round-trips every field of an export, including the artifact", async () => {
        const r = exportReq(1, U(1));
        await c.requests.insertExport(r, []);
        const started = startExport(r, T0 + 10);
        expect(await c.requests.update(started, [])).toBe("ok");
        const done = completeExport(started, "exports/u1/r1.zip", T0 + 20);
        expect(await c.requests.update(done, [])).toBe("ok");
        expect(await c.requests.get(r.id)).toEqual(done);
      });

      it("round-trips a deletion with credit and blockers (bigint, jsonb)", async () => {
        const d = deletion(1, U(1), 9_007_199_254_740_993n);
        await c.requests.insertDeletion(d, []);
        const held = holdDeletion(d, [{ kind: "open_orders", count: 2 }], d.coolingEndsAtMs);
        expect(await c.requests.update(held, [])).toBe("ok");
        expect(await c.requests.get(d.id)).toEqual(held);
      });

      it("returns null for unknown and malformed ids", async () => {
        expect(await c.requests.get(U(999))).toBeNull();
        expect(await c.requests.get("not-a-uuid")).toBeNull();
      });

      it("update is compare-and-set: a replay conflicts and writes no events", async () => {
        const r = exportReq(1, U(1));
        await c.requests.insertExport(r, []);
        const started = startExport(r, T0 + 10);
        expect(await c.requests.update(started, [ev(10, "privacy.export_started", r.id)])).toBe("ok");
        expect(await c.requests.update(started, [ev(11, "privacy.export_started", r.id)])).toBe("conflict");
        expect(await c.requests.update({ ...started, id: U(998), version: 1 }, [])).toBe("not_found");
        expect(await c.eventTypes()).toEqual(["privacy.export_started"]);
      });

      it("rolls the state change back when its outbox event cannot be written (same transaction)", async () => {
        const r = exportReq(1, U(1));
        await c.requests.insertExport(r, [ev(1, "privacy.export_requested", r.id)]);
        const started = startExport(r, T0 + 10);
        await expect(c.requests.update(started, [ev(1, "privacy.export_started", r.id)])).rejects.toThrow();
        expect((await c.requests.get(r.id))?.status).toBe("requested");
        expect(await c.eventTypes()).toEqual(["privacy.export_requested"]);
      });

      it("findLatest prefers the open request, then the most recent", async () => {
        expect(await c.requests.findLatest(U(1), "delete")).toBeNull();
        const d1 = deletion(1, U(1));
        await c.requests.insertDeletion(d1, []);
        await c.requests.update(cancelDeletion(d1, T0 + 5), []);
        expect((await c.requests.findLatest(U(1), "delete"))?.status).toBe("cancelled");
        const d2 = deletion(2, U(1));
        await c.requests.insertDeletion(d2, []);
        expect((await c.requests.findLatest(U(1), "delete"))?.id).toBe(d2.id);
        expect(await c.requests.findLatest(U(2), "delete")).toBeNull();
      });

      it("worklists select exactly the actionable requests", async () => {
        const pending = exportReq(1, U(1));
        const ready = exportReq(2, U(2));
        await c.requests.insertExport(pending, []);
        await c.requests.insertExport(ready, []);
        const r1 = startExport(ready, T0 + 10);
        await c.requests.update(r1, []);
        const r2 = completeExport(r1, "k", T0 + 20);
        await c.requests.update(r2, []);
        const failedOnce = failExport(startExport(pending, T0 + 30), "x", T0 + 31);
        expect(failedOnce.status).toBe("requested");
        expect((await c.requests.listPendingExports(10)).map((r) => r.id).sort()).toEqual([pending.id]);
        expect(await c.requests.listExpiredExports(T0 + 20 + 7 * DAY - 1, 10)).toEqual([]);
        expect((await c.requests.listExpiredExports(T0 + 20 + 7 * DAY, 10)).map((r) => r.id)).toEqual([ready.id]);

        const d = deletion(1, U(3));
        await c.requests.insertDeletion(d, []);
        expect(await c.requests.listDueDeletions(d.coolingEndsAtMs - 1, 10)).toEqual([]);
        expect((await c.requests.listDueDeletions(d.coolingEndsAtMs, 10)).map((r) => r.id)).toEqual([d.id]);
        const erasing = beginErasure(d, d.coolingEndsAtMs);
        await c.requests.update(erasing, []);
        expect((await c.requests.listDueDeletions(0, 10)).map((r) => r.id)).toEqual([d.id]);
      });

      it("queue lists OPEN requests only, oldest first, with the filter applied before the limit", async () => {
        await c.requests.insertExport(exportReq(1, U(1)), []);
        const d = deletion(2, U(2));
        await c.requests.insertDeletion(d, []);
        const cancelled = deletion(3, U(3));
        await c.requests.insertDeletion(cancelled, []);
        await c.requests.update(cancelDeletion(cancelled, T0 + 5), []);
        expect((await c.requests.listForQueue(10)).map((r) => r.id)).toEqual([U(101), U(202)]);
        expect((await c.requests.listForQueue(1)).map((r) => r.id)).toEqual([U(101)]);
        expect((await c.requests.listRecentClosed(10)).map((r) => r.id)).toEqual([U(203)]);
      });

      it("lists every export of a user and keeps parked deletions out of the due worklist", async () => {
        await c.requests.insertExport(exportReq(1, U(1)), []);
        await c.requests.insertExport(exportReq(2, U(2)), []);
        expect((await c.requests.listExportsForUser(U(1))).map((r) => r.id)).toEqual([U(101)]);
        const d = deletion(4, U(3));
        await c.requests.insertDeletion(d, []);
        const erasing = beginErasure(d, d.coolingEndsAtMs);
        await c.requests.update(erasing, []);
        let cur = erasing;
        for (let i = 0; i < MAX_ERASURE_ATTEMPTS; i += 1) {
          cur = recordErasureFailure(cur, T0 + 100 + i);
          expect(await c.requests.update(cur, [])).toBe("ok");
        }
        expect(cur.status).toBe("on_hold");
        const stored = await c.requests.get(d.id);
        expect(stored).toMatchObject({ attempts: MAX_ERASURE_ATTEMPTS, failureCode: ERASURE_PARKED_CODE });
        expect(await c.requests.listDueDeletions(d.coolingEndsAtMs + DAY, 10)).toEqual([]);
      });
    });

    describe("breach register", () => {
      const entry = (n: number, over: Partial<BreachEntry> = {}): BreachEntry => ({
        ...recordBreach(
          { id: U(300 + n), detectedAtMs: T0 - n * 1000, severity: "high", summary: `incident ${n}`, affectedCount: n },
          T0,
        ),
        ...over,
      });

      it("inserts, reads, and lists newest detection first", async () => {
        await c.breaches.insert(entry(1), [ev(20, "privacy.breach_recorded", U(301))]);
        await c.breaches.insert(entry(2), []);
        expect((await c.breaches.get(U(301)))?.summary).toBe("incident 1");
        expect((await c.breaches.list(10)).map((b) => b.id)).toEqual([U(301), U(302)]);
        expect(await c.breaches.get(U(399))).toBeNull();
        expect(await c.eventTypes()).toEqual(["privacy.breach_recorded"]);
      });

      it("advances with compare-and-set and persists the legal timestamps", async () => {
        const b = entry(1);
        await c.breaches.insert(b, []);
        const t = triageBreach(b, "notify", T0 + 1000);
        expect(await c.breaches.update(t, [])).toBe("ok");
        const p = notifyPdpc(t, T0 + 2000);
        expect(await c.breaches.update(p, [])).toBe("ok");
        expect(await c.breaches.update(p, [])).toBe("conflict");
        expect(await c.breaches.get(b.id)).toEqual(p);
      });
    });

    describe("consent records", () => {
      it("appends in order, reads back per user and writes consent.changed atomically", async () => {
        await c.consents.append(
          [consent(U(1), "analytics", true, T0), consent(U(1), "analytics", false, T0 + 1000)],
          [ev(30, "consent.changed", U(1))],
        );
        await c.consents.append([consent(U(2), "marketing_push", true, T0)], []);
        const h = await c.consents.history(U(1));
        expect(h.map((r) => [r.purpose, r.granted])).toEqual([
          ["analytics", true],
          ["analytics", false],
        ]);
        expect(h[0]?.at).toBe(new Date(T0).toISOString());
        expect(await c.consents.history(U(3))).toEqual([]);
        expect(await c.eventTypes()).toEqual(["consent.changed"]);
      });
    });
  });
}
