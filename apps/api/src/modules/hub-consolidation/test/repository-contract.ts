import { beforeEach, describe, expect, it } from "vitest";
import type { GroupRecord, HubEvent, HubStore, LegRecord, ParcelRecord } from "../domain/ports";

export interface HubStoreContext {
  readonly store: HubStore;
  ensureUser(userId: string): Promise<void>;
  eventTypes(): Promise<string[]>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;
const HUB = U(100);
const GROUP = U(200);
let seq = 0;

const group = (over: Partial<GroupRecord> = {}): GroupRecord => ({
  orderGroupId: GROUP,
  userId: U(1),
  hubId: HUB,
  deliveryFee: 6000n,
  shipTogether: true,
  paidAtMs: T0,
  ...over,
});
const leg = (n: number, over: Partial<LegRecord> = {}): LegRecord => ({
  sellerOrderId: U(300 + n),
  orderGroupId: GROUP,
  hubId: HUB,
  storeId: U(9000 + n),
  state: "AT_HUB_EXPECTED",
  lineIds: [U(400 + n)],
  subtotal: BigInt(1000 * n),
  handoffDueAtMs: T0 + 48 * 3_600_000,
  consolidationId: null,
  version: 0,
  ...over,
});
const receipt = (n: number, condition: "ok" | "damaged" = "ok") => ({
  id: U(500 + n + ++seq),
  sellerOrderId: U(300 + n),
  hubId: HUB,
  operatorId: U(2),
  condition,
  scannedAtMs: T0 + 1000,
});
const ev = (type: HubEvent["type"], n: number): HubEvent =>
  type === "hub.receipt_recorded"
    ? { type, orderGroupId: GROUP, sellerOrderId: U(300 + n), condition: "ok" }
    : { type: "hub.parcel_ready", orderGroupId: GROUP, parcelId: U(600), legCount: 1, split: false };

/** One suite for every HubStore implementation (in-memory and Postgres on PGlite). */
export function runHubStoreContract(name: string, make: () => Promise<HubStoreContext>): void {
  describe(`HubStore contract: ${name}`, () => {
    let c: HubStoreContext;
    beforeEach(async () => {
      c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      await c.store.upsertHub({ id: HUB, name: "Cairo hub", governorate: "Cairo" });
    });

    const open = async (n = 3) => {
      const r = await c.store.openGroup(group(), Array.from({ length: n }, (_, i) => leg(i + 1)));
      expect(r).toBe("opened");
    };

    it("opens a group once and reads it back with exact bigint amounts", async () => {
      await open();
      expect(await c.store.openGroup(group(), [leg(1)])).toBe("exists");
      const g = await c.store.getGroup(GROUP);
      expect(g?.deliveryFee).toBe(6000n);
      const legs = await c.store.listLegs(GROUP);
      expect(legs).toHaveLength(3);
      expect(legs.map((l) => l.subtotal)).toEqual([1000n, 2000n, 3000n]);
      expect((await c.store.getLeg(U(301)))?.lineIds).toEqual([U(401)]);
      expect(await c.store.getLeg(U(999))).toBeNull();
    });

    it("records a receipt once and moves the leg", async () => {
      await open();
      const r = receipt(1);
      expect(await c.store.recordReceipt({ receipt: r, expectedVersion: 0, next: "RECEIVED", events: [ev("hub.receipt_recorded", 1)] })).toBe("ok");
      expect((await c.store.getLeg(U(301)))?.state).toBe("RECEIVED");
      expect((await c.store.getLeg(U(301)))?.version).toBe(1);
      expect(await c.store.recordReceipt({ receipt: receipt(1), expectedVersion: 1, next: "RECEIVED", events: [] })).toBe("duplicate");
      expect((await c.store.getReceipt(U(301)))?.condition).toBe("ok");
      expect(await c.eventTypes()).toEqual(["hub.receipt_recorded"]);
    });

    it("refuses a stale version without writing", async () => {
      await open();
      expect(await c.store.recordReceipt({ receipt: receipt(1), expectedVersion: 5, next: "RECEIVED", events: [ev("hub.receipt_recorded", 1)] })).toBe("conflict");
      expect((await c.store.getLeg(U(301)))?.state).toBe("AT_HUB_EXPECTED");
      expect(await c.store.getReceipt(U(301))).toBeNull();
      expect(await c.eventTypes()).toEqual([]);
    });

    const parcel = (over: Partial<ParcelRecord> = {}): ParcelRecord => ({
      id: U(600),
      orderGroupId: GROUP,
      hubId: HUB,
      sellerOrderIds: [U(301), U(302)],
      status: "READY",
      awb: null,
      courierCode: null,
      shopperFee: 6000n,
      gCo2e: null,
      factorsVersion: null,
      createdAtMs: T0 + 5000,
      dispatchedAtMs: null,
      ...over,
    });

    it("pages parcels newest first and scopes legs to the given stores with a keyset", async () => {
      await open();
      for (const n of [1, 2]) await c.store.recordReceipt({ receipt: receipt(n), expectedVersion: 0, next: "RECEIVED", events: [] });
      await c.store.createParcel({ parcel: parcel(), legs: [{ sellerOrderId: U(301), expectedVersion: 1 }, { sellerOrderId: U(302), expectedVersion: 1 }], events: [] });
      expect((await c.store.listParcelsPage(5, null)).map((p) => p.id)).toEqual([U(600)]);
      expect(await c.store.listParcelsPage(5, { createdAtMs: T0 + 5000, id: U(600) })).toEqual([]);
      const mine = await c.store.listLegsForStores({ storeIds: [U(9001), U(9003)], orderGroupId: null, limit: 10, afterId: null });
      expect(mine.map((l) => l.sellerOrderId)).toEqual([U(301), U(303)]);
      const next = await c.store.listLegsForStores({ storeIds: [U(9001), U(9003)], orderGroupId: GROUP, limit: 10, afterId: U(301) });
      expect(next.map((l) => l.sellerOrderId)).toEqual([U(303)]);
      expect(await c.store.listLegsForStores({ storeIds: [U(9999)], orderGroupId: null, limit: 10, afterId: null })).toEqual([]);
    });

    it("consolidates received legs atomically, then dispatches once", async () => {
      await open();
      for (const n of [1, 2]) {
        await c.store.recordReceipt({ receipt: receipt(n), expectedVersion: 0, next: "RECEIVED", events: [] });
      }
      const p = parcel();
      expect(
        await c.store.createParcel({
          parcel: p,
          legs: [
            { sellerOrderId: U(301), expectedVersion: 1 },
            { sellerOrderId: U(302), expectedVersion: 1 },
          ],
          events: [ev("hub.parcel_ready", 0)],
        }),
      ).toBe("ok");
      expect((await c.store.getLeg(U(301)))?.state).toBe("CONSOLIDATED");
      expect((await c.store.getLeg(U(301)))?.consolidationId).toBe(U(600));
      expect((await c.store.getParcel(U(600)))?.shopperFee).toBe(6000n);
      expect(
        await c.store.dispatchParcel({
          parcelId: U(600),
          awb: "ARX000001",
          courierCode: "aramex",
          estimate: { gCo2e: 120n, method: "distance_estimate", isEstimate: true, factorsVersion: "assumed-1" },
          nowMs: T0 + 9000,
          events: [],
        }),
      ).toBe("ok");
      const done = await c.store.getParcel(U(600));
      expect(done).toMatchObject({ status: "DISPATCHED", awb: "ARX000001", gCo2e: 120n });
      expect((await c.store.getLeg(U(302)))?.state).toBe("DISPATCHED");
      expect(
        await c.store.dispatchParcel({ parcelId: U(600), awb: "X", courierCode: "aramex", estimate: { gCo2e: 1n, method: "distance_estimate", isEstimate: true, factorsVersion: "v" }, nowMs: T0, events: [] }),
      ).toBe("not_ready");
      expect(
        await c.store.dispatchParcel({ parcelId: U(699), awb: "X", courierCode: "aramex", estimate: { gCo2e: 1n, method: "distance_estimate", isEstimate: true, factorsVersion: "v" }, nowMs: T0, events: [] }),
      ).toBe("not_found");
    });

    it("rolls the whole parcel back when one leg moved", async () => {
      await open();
      await c.store.recordReceipt({ receipt: receipt(1), expectedVersion: 0, next: "RECEIVED", events: [] });
      const r = await c.store.createParcel({
        parcel: parcel({ sellerOrderIds: [U(301), U(302)] }),
        legs: [
          { sellerOrderId: U(301), expectedVersion: 1 },
          { sellerOrderId: U(302), expectedVersion: 0 },
        ],
        events: [ev("hub.parcel_ready", 0)],
      });
      expect(r).toBe("conflict");
      expect((await c.store.getLeg(U(301)))?.state).toBe("RECEIVED");
      expect(await c.store.getParcel(U(600))).toBeNull();
    });

    it("lists groups that still hold open legs, oldest first", async () => {
      await open();
      const open1 = await c.store.groupsWithOpenLegs(10);
      expect(open1.map((g) => g.orderGroupId)).toEqual([GROUP]);
    });
  });
}
