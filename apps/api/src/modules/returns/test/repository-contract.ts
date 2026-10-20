import { beforeEach, describe, expect, it } from "vitest";
import { money } from "../domain/bridge";
import type { ReturnRecord, ReturnRepository } from "../domain/ports";

export interface ReturnsRepoContext {
  readonly repo: ReturnRepository;
  /** Makes the user exist where the store enforces the FK (Postgres); no-op in memory. */
  ensureUser(userId: string): Promise<void>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const STORE_A = "00000000-0000-4000-a000-000000000001";
const STORE_B = "00000000-0000-4000-a000-000000000002";

export const record = (n: number, over: Partial<ReturnRecord> = {}): ReturnRecord => ({
  id: U(1000 + n),
  userId: U(1),
  orderLineId: U(2000),
  sellerOrderId: U(3000),
  storeId: STORE_A,
  qty: 1,
  priorQty: 0,
  reason: "changed_mind",
  resolution: "refund",
  exchangeSkuId: null,
  refundPreference: "original_method",
  method: "pickup",
  state: "REQUESTED",
  shippingPayer: "shopper",
  deliveredAtMs: T0 - DAY,
  windowEndsAtMs: T0 + 13 * DAY,
  note: null,
  receivedAtMs: null,
  inspectionDueAtMs: null,
  inspectedAtMs: null,
  inspectionNote: null,
  inspectionResult: null,
  rejectionReason: null,
  disputeWindowEndsAtMs: null,
  deliveryFeeRefundable: false,
  lineSnapshot: {
    qtyOrdered: 3,
    unitPrice: money(9_007_199_254_740_993n),
    discountAlloc: money(1_000n),
    deliveryFeeAlloc: money(2_500n),
  },
  refundIntent: null,
  intentPublishedAtMs: null,
  idempotencyKey: `key-${n}`,
  version: 0,
  createdAtMs: T0 + n * 1000,
  evidence: [],
  dispute: null,
  ...over,
});

/** Behaviour every ReturnRepository must have. Run against in-memory and Kysely/PGlite. */
export function describeReturnRepositoryContract(name: string, make: () => Promise<ReturnsRepoContext>): void {
  describe(`ReturnRepository contract: ${name}`, () => {
    let c: ReturnsRepoContext;
    beforeEach(async () => {
      c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
    });

    it("creates once, round-trips exact bigint amounts and finds by id and idempotency key", async () => {
      const r = record(1, { evidence: [{ uploadId: U(7001), kind: "shopper_photo", uploadedByType: "shopper", uploadedById: U(1), uploadedAtMs: T0 }] });
      const out = await c.repo.createIfCapacity(r, 3);
      expect(out.kind).toBe("created");
      const back = await c.repo.findById(r.id);
      expect(back?.lineSnapshot.unitPrice.amount).toBe(9_007_199_254_740_993n);
      expect(back?.evidence.map((e) => e.uploadId)).toEqual([U(7001)]);
      expect(back?.state).toBe("REQUESTED");
      expect((await c.repo.findByIdempotencyKey(U(1), "key-1"))?.id).toBe(r.id);
      expect(await c.repo.findByIdempotencyKey(U(2), "key-1")).toBeNull();
      expect(await c.repo.findById(U(9999))).toBeNull();
    });

    it("a repeated (user, idempotency key) returns the first record", async () => {
      await c.repo.createIfCapacity(record(1), 3);
      const again = await c.repo.createIfCapacity(record(2, { idempotencyKey: "key-1" }), 3);
      expect(again.kind).toBe("duplicate");
      if (again.kind === "duplicate") expect(again.record.id).toBe(U(1001));
    });

    it("never lets a line exceed its quantity and reports a stale prior quantity", async () => {
      expect((await c.repo.createIfCapacity(record(1, { qty: 2 }), 3)).kind).toBe("created");
      expect((await c.repo.createIfCapacity(record(2, { qty: 2, priorQty: 2 }), 3)).kind).toBe("over_capacity");
      expect((await c.repo.createIfCapacity(record(3, { qty: 1, priorQty: 0 }), 3)).kind).toBe("conflict");
      expect((await c.repo.createIfCapacity(record(4, { qty: 1, priorQty: 2 }), 3)).kind).toBe("created");
      expect(await c.repo.committedQty(U(2000))).toBe(3);
    });

    it("counts exchanges and ignores cancelled returns", async () => {
      await c.repo.createIfCapacity(
        record(1, { resolution: "exchange", exchangeSkuId: U(8000), reason: "too_small" }),
        3,
      );
      expect(await c.repo.exchangeCount(U(2000))).toBe(1);
      const cur = await c.repo.findById(U(1001));
      if (cur === null) throw new Error("missing");
      expect(await c.repo.save({ ...cur, state: "CANCELLED", version: 1 }, 0)).toBe(true);
      expect(await c.repo.committedQty(U(2000))).toBe(0);
      expect(await c.repo.exchangeCount(U(2000))).toBe(0);
    });

    it("save is compare-and-set, stores the refund intent exactly and writes the dispute", async () => {
      await c.repo.createIfCapacity(record(1), 3);
      const cur = await c.repo.findById(U(1001));
      if (cur === null) throw new Error("missing");
      const intent = {
        currency: "EGP" as const,
        lines: [
          {
            orderLineId: U(2000),
            qty: 1,
            itemAmount: money(9_007_199_254_740_993n),
            voucherShare: money(333n),
            deliveryFeeShare: money(0n),
            netAmount: money(9_007_199_254_740_660n),
          },
        ],
        itemTotal: money(9_007_199_254_740_993n),
        voucherTotal: money(333n),
        deliveryFeeTotal: money(0n),
        netTotal: money(9_007_199_254_740_660n),
      };
      const next: ReturnRecord = {
        ...cur,
        state: "DISPUTED",
        version: 1,
        refundIntent: intent,
        inspectionResult: "rejected",
        rejectionReason: "used",
        disputeWindowEndsAtMs: T0 + 7 * DAY,
        dispute: { id: U(4000), returnId: cur.id, status: "OPEN", statement: "unused", reviewDueAtMs: T0 + 5 * DAY, decidedAtMs: null, createdAtMs: T0 },
      };
      expect(await c.repo.save(next, 0)).toBe(true);
      expect(await c.repo.save({ ...next, state: "CLOSED", version: 1 }, 0)).toBe(false);
      const back = await c.repo.findById(cur.id);
      expect(back?.version).toBe(1);
      expect(back?.state).toBe("DISPUTED");
      expect(back?.refundIntent?.netTotal.amount).toBe(9_007_199_254_740_660n);
      expect(back?.dispute?.statement).toBe("unused");
      expect(back?.dispute?.reviewDueAtMs).toBe(T0 + 5 * DAY);
    });

    it("lists newest first with a keyset cursor, scoped to the user or stores", async () => {
      for (let i = 1; i <= 5; i += 1) {
        await c.repo.createIfCapacity(
          record(i, { orderLineId: U(2100 + i), storeId: i % 2 === 0 ? STORE_B : STORE_A }),
          1,
        );
      }
      await c.repo.createIfCapacity(record(6, { userId: U(2), orderLineId: U(2200) }), 1);
      const p1 = await c.repo.listForUser(U(1), null, 2);
      expect(p1.items.map((r) => r.id)).toEqual([U(1005), U(1004)]);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = await c.repo.listForUser(U(1), p1.nextCursor, 2);
      expect(p2.items.map((r) => r.id)).toEqual([U(1003), U(1002)]);
      const p3 = await c.repo.listForUser(U(1), p2.nextCursor, 2);
      expect(p3.items.map((r) => r.id)).toEqual([U(1001)]);
      expect(p3.nextCursor).toBeNull();
      const a = await c.repo.listForStores([STORE_A], null, 50);
      expect(a.items.map((r) => r.id).sort()).toEqual([U(1001), U(1003), U(1005), U(1006)].sort());
      expect((await c.repo.listForStores([], null, 50)).items).toEqual([]);
    });

    it("finds overdue inspections, elapsed dispute windows and unpublished intents", async () => {
      await c.repo.createIfCapacity(record(1, { orderLineId: U(2101) }), 1);
      await c.repo.createIfCapacity(record(2, { orderLineId: U(2102) }), 1);
      await c.repo.createIfCapacity(record(3, { orderLineId: U(2103) }), 1);
      const must = async (id: string): Promise<ReturnRecord> => {
        const r = await c.repo.findById(id);
        if (r === null) throw new Error("missing");
        return r;
      };
      const a = await must(U(1001));
      const b = await must(U(1002));
      const d = await must(U(1003));
      await c.repo.save({ ...a, state: "RECEIVED", receivedAtMs: T0, inspectionDueAtMs: T0 + 2 * DAY, version: 1 }, 0);
      await c.repo.save({ ...b, state: "REJECTED", disputeWindowEndsAtMs: T0 + 7 * DAY, version: 1 }, 0);
      await c.repo.save({ ...d, state: "APPROVED", version: 1 }, 0);
      expect((await c.repo.listInspectionOverdue(T0 + 2 * DAY - 1, 10)).map((r) => r.id)).toEqual([]);
      expect((await c.repo.listInspectionOverdue(T0 + 2 * DAY, 10)).map((r) => r.id)).toEqual([a.id]);
      expect((await c.repo.listDisputeWindowElapsed(T0 + 7 * DAY, 10)).map((r) => r.id)).toEqual([]);
      expect((await c.repo.listDisputeWindowElapsed(T0 + 7 * DAY + 1, 10)).map((r) => r.id)).toEqual([b.id]);
      expect((await c.repo.listUnpublishedIntents(10)).map((r) => r.id)).toEqual([d.id]);
      expect(await c.repo.hasOpenReturns(U(1))).toBe(true);
      expect(await c.repo.hasOpenReturns(U(2))).toBe(false);
    });

    it("counts non-terminal returns per line of one seller order, never leaking another order", async () => {
      const L1 = U(2001);
      const L2 = U(2002);
      const S2 = U(3001);
      const a = record(1, { orderLineId: L1 });
      const b = record(2, { orderLineId: L1, priorQty: 1 });
      const d = record(3, { orderLineId: L2 });
      const other = record(4, { orderLineId: U(2003), sellerOrderId: S2 });
      for (const r of [a, b, d, other]) expect((await c.repo.createIfCapacity(r, 3)).kind).toBe("created");
      expect(await c.repo.openReturnCountsBySellerOrder(U(3000))).toEqual(new Map([[L1, 2], [L2, 1]]));
      expect(await c.repo.openReturnCountsBySellerOrder(S2)).toEqual(new Map([[U(2003), 1]]));
      // terminal states (from the machine) stop counting; a state mid-flow (REJECTED, dispute window) still counts
      expect(await c.repo.save({ ...a, state: "CLOSED", version: 1 }, 0)).toBe(true);
      expect(await c.repo.save({ ...d, state: "REJECTED", version: 1 }, 0)).toBe(true);
      expect(await c.repo.save({ ...b, state: "CANCELLED", version: 1 }, 0)).toBe(true);
      expect(await c.repo.openReturnCountsBySellerOrder(U(3000))).toEqual(new Map([[L2, 1]]));
      expect(await c.repo.save({ ...d, state: "REFUNDED", version: 2 }, 1)).toBe(true);
      expect(await c.repo.openReturnCountsBySellerOrder(U(3000))).toEqual(new Map());
      expect(await c.repo.openReturnCountsBySellerOrder("not-a-uuid-or-unknown")).toEqual(new Map());
    });

    it("stores the published serial-returner standing per user", async () => {
      expect(await c.repo.getStanding(U(1))).toBeNull();
      await c.repo.saveStanding({
        userId: U(1),
        deliveredOrders: 10,
        returnedOrders: 7,
        rateBps: 7000,
        freeReturnsRemoved: true,
        noticeSentAtMs: T0,
        evaluatedAtMs: T0,
      });
      await c.repo.saveStanding({
        userId: U(1),
        deliveredOrders: 11,
        returnedOrders: 7,
        rateBps: 6363,
        freeReturnsRemoved: true,
        noticeSentAtMs: T0,
        evaluatedAtMs: T0 + 1000,
      });
      const s = await c.repo.getStanding(U(1));
      expect(s?.deliveredOrders).toBe(11);
      expect(s?.freeReturnsRemoved).toBe(true);
      expect(s?.noticeSentAtMs).toBe(T0);
    });
  });
}
