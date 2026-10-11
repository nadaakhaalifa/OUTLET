import { describe, expect, it } from "vitest";
import { newElevation, openSuspensionReview, requestApproval, DEFAULT_APPROVAL_CONFIG, DEFAULT_ELEVATION_CONFIG, type ApprovalRecord, type ElevationRecord, type KycState } from "../domain/bridge";
import type { AdminAuditPort, AdminStore, SellerKycPort } from "../domain/ports";

export const NOW = 1_800_000_000_000;
export const U = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const S = (n: number): string => `0192f3a4-5b6c-7d8e-9f02-${String(n).padStart(12, "0")}`;

export interface AdminContractContext {
  readonly store: AdminStore;
  readonly kyc: SellerKycPort;
  readonly audit: AdminAuditPort;
  seedUser(id: string): Promise<void>;
  seedSeller(id: string, state: KycState, storeName: string): Promise<void>;
  auditRows(): Promise<readonly { action: string; reasonCode: string | null; actorId: string | null }[]>;
}

export const approval = (n: number, over: Partial<ApprovalRecord> = {}): ApprovalRecord => {
  const r = requestApproval(
    {
      id: U(1000 + n),
      kind: "plan_price_change",
      subjectType: "plan",
      subjectId: `plan-${n}`,
      amountMinor: null,
      reasonCode: "finance_reconciliation",
      requesterId: U(1),
      requesterRoles: ["finance"],
      nowMs: NOW + n,
    },
    DEFAULT_APPROVAL_CONFIG,
  );
  if (r.kind !== "created") throw new Error("setup");
  return { ...r.record, ...over };
};

export const elevation = (n: number, approvalId: string): ElevationRecord => {
  const r = newElevation(
    { id: U(2000 + n), userId: U(1), role: "finance", reasonCode: "incident_response", approvalId, ttlMs: 1_800_000, heldRoles: ["ops"], nowMs: NOW },
    DEFAULT_ELEVATION_CONFIG,
  );
  if (r.kind !== "ok") throw new Error("setup");
  return r.record;
};

export function describeAdminContract(name: string, fresh: () => Promise<AdminContractContext>): void {
  describe(`admin store contract: ${name}`, () => {
    it("approvals: insert, get, CAS decision, list filters", async () => {
      const c = await fresh();
      await c.seedUser(U(1));
      await c.seedUser(U(2));
      const a = approval(1);
      const b = approval(2, { kind: "refund", subjectType: "refund", amountMinor: 700_000n });
      await c.store.insertApproval(a);
      await c.store.insertApproval(b);
      expect(await c.store.getApproval(a.id)).toEqual(a);
      expect((await c.store.getApproval(b.id))?.amountMinor).toBe(700_000n);
      expect(await c.store.getApproval(U(9999))).toBeNull();

      const decided: ApprovalRecord = {
        ...a,
        state: "APPROVED",
        approverId: U(2),
        decidedAtMs: NOW + 5,
        decisionNote: "ok",
      };
      expect(await c.store.saveApprovalDecision(decided)).toBe(true);
      expect(await c.store.saveApprovalDecision({ ...decided, state: "REJECTED" })).toBe(false); // lost the race
      expect((await c.store.getApproval(a.id))?.state).toBe("APPROVED");

      expect((await c.store.listApprovals({ states: ["REQUESTED"], limit: 10 })).map((x) => x.id)).toEqual([b.id]);
      expect((await c.store.listApprovals({ kinds: ["plan_price_change"], limit: 10 })).map((x) => x.id)).toEqual([a.id]);
      expect(await c.store.listApprovals({ requesterId: U(2), limit: 10 })).toEqual([]);
      expect((await c.store.listApprovals({ limit: 1 }))).toHaveLength(1);
    });

    it("listApprovals applies visibility before the limit", async () => {
      const c = await fresh();
      await c.seedUser(U(1));
      await c.seedUser(U(2));
      await c.seedUser(U(3));
      const refund = approval(10, { kind: "refund", requesterId: U(2), requestedAtMs: NOW });
      await c.store.insertApproval(refund);
      for (let i = 0; i < 4; i += 1) {
        await c.store.insertApproval(approval(20 + i, { kind: "data_export", requesterId: U(3), requestedAtMs: NOW + 1000 + i }));
      }
      const rows = await c.store.listApprovals({ visibleTo: { actorId: U(1), kinds: ["refund"] }, limit: 2 });
      expect(rows.map((r) => r.id)).toEqual([refund.id]);
      const own = await c.store.listApprovals({ visibleTo: { actorId: U(3), kinds: [] }, limit: 10 });
      expect(own).toHaveLength(4);
    });

    it("elevations: atomic create with approval, activate CAS, live window is exclusive", async () => {
      const c = await fresh();
      await c.seedUser(U(1));
      await c.seedUser(U(2));
      const a = approval(3, { kind: "role_elevation", subjectType: "elevation", subjectId: U(2001) });
      const e = elevation(1, a.id);
      await c.store.createElevationWithApproval(a, e);
      expect(await c.store.getElevation(e.id)).toEqual(e);
      expect(await c.store.getApproval(a.id)).toEqual(a);
      expect(await c.store.liveElevations(U(1), NOW)).toEqual([]);

      const active: ElevationRecord = { ...e, state: "ACTIVE", activatedAtMs: NOW + 10, expiresAtMs: NOW + 10 + 1_800_000 };
      expect(await c.store.saveElevation(active, "PENDING_APPROVAL")).toBe(true);
      expect(await c.store.saveElevation(active, "PENDING_APPROVAL")).toBe(false);
      expect((await c.store.liveElevations(U(1), NOW + 11)).map((x) => x.id)).toEqual([e.id]);
      expect(await c.store.liveElevations(U(1), active.expiresAtMs ?? 0)).toEqual([]);
      expect(await c.store.liveElevations(U(2), NOW + 11)).toEqual([]);
      expect((await c.store.listElevations({ userId: U(1), limit: 10 })).map((x) => x.id)).toEqual([e.id]);
      expect((await c.store.listElevations({ activeAtMs: NOW + 11, limit: 10 })).map((x) => x.id)).toEqual([e.id]);
      expect(await c.store.listElevations({ activeAtMs: NOW + 99_999_999, limit: 10 })).toEqual([]);
    });

    it("elevation creation is all-or-nothing", async () => {
      const c = await fresh();
      await c.seedUser(U(1));
      const a = approval(4, { kind: "role_elevation", subjectType: "elevation", subjectId: U(2002) });
      const e = elevation(2, a.id);
      await c.store.createElevationWithApproval(a, e);
      const a2 = approval(5, { kind: "role_elevation", subjectType: "elevation", subjectId: U(2002) });
      await expect(c.store.createElevationWithApproval(a2, e)).rejects.toThrow(); // duplicate elevation id
      expect(await c.store.getApproval(a2.id)).toBeNull();
    });

    it("suspension reviews: one open per seller, CAS save, ordered by due date", async () => {
      const c = await fresh();
      await c.seedUser(U(1));
      await c.seedUser(U(2));
      const r1 = openSuspensionReview({ id: U(3001), sellerId: S(1), suspendedBy: U(1), reasonCode: "fraud_investigation", nowMs: NOW });
      const r2 = openSuspensionReview({ id: U(3002), sellerId: S(2), suspendedBy: null, reasonCode: "fraud_investigation", nowMs: NOW - 3 * 86_400_000 });
      expect(await c.store.insertReview(r1)).toBe(true);
      expect(await c.store.insertReview({ ...r1, id: U(3003) })).toBe(false);
      expect(await c.store.insertReview(r2)).toBe(true);
      expect((await c.store.findOpenReviewBySeller(S(1)))?.id).toBe(r1.id);
      expect((await c.store.listReviews({ state: "OPEN", limit: 10 })).map((r) => r.id)).toEqual([r2.id, r1.id]);
      const done = { ...r1, state: "REINSTATED" as const, reviewedBy: U(2), reviewedAtMs: NOW + 5 };
      expect(await c.store.saveReview(done)).toBe(true);
      expect(await c.store.saveReview({ ...done, state: "UPHELD" })).toBe(false);
      expect(await c.store.findOpenReviewBySeller(S(1))).toBeNull();
      expect(await c.store.getReview(r1.id)).toEqual(done);
      // a new suspension can open once the previous review is closed
      expect(await c.store.insertReview({ ...r1, id: U(3004), state: "OPEN", reviewedBy: null, reviewedAtMs: null })).toBe(true);
    });

    it("seller KYC read model: list, filter, compare-and-set", async () => {
      const c = await fresh();
      await c.seedSeller(S(1), "APPROVED", "A");
      await c.seedSeller(S(2), "SUBMITTED", "B");
      expect((await c.kyc.list({ limit: 10 })).map((x) => x.sellerId).sort()).toEqual([S(1), S(2)]);
      expect((await c.kyc.list({ states: ["SUBMITTED"], limit: 10 })).map((x) => x.sellerId)).toEqual([S(2)]);
      expect((await c.kyc.get(S(1)))?.state).toBe("APPROVED");
      expect((await c.kyc.get(S(1)))?.storeNames).toEqual(["A"]);
      expect(await c.kyc.get(S(77))).toBeNull();
      expect(await c.kyc.setState(S(1), "SUBMITTED", "SUSPENDED", NOW)).toBe(false);
      expect(await c.kyc.setState(S(1), "APPROVED", "SUSPENDED", NOW)).toBe(true);
      expect((await c.kyc.get(S(1)))?.state).toBe("SUSPENDED");
      expect(await c.kyc.setState(S(1), "APPROVED", "SUSPENDED", NOW)).toBe(false);
    });

    it("audit port appends rows with the reason code and no values", async () => {
      const c = await fresh();
      await c.seedUser(U(1));
      await c.audit.append({
        action: "pii_view.read",
        actorId: U(1),
        targetType: "user",
        targetId: U(2),
        reasonCode: "kyc_review",
        diff: { fields: "phone" },
        requestId: "req-1",
        atMs: NOW,
      });
      await c.audit.append({
        action: "kyc.suspended",
        actorId: null,
        targetType: "seller",
        targetId: S(1),
        reasonCode: "fraud_investigation",
        diff: { automatic: true },
        requestId: null,
        atMs: NOW + 1,
      });
      const rows = await c.auditRows();
      expect(rows).toEqual([
        { action: "pii_view.read", reasonCode: "kyc_review", actorId: U(1) },
        { action: "kyc.suspended", reasonCode: "fraud_investigation", actorId: null },
      ]);
    });
  });
}
