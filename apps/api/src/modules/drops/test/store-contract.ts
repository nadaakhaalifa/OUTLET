import { describe, expect, it } from "vitest";
import type { Drop } from "../domain/bridge";
import type { DropStore } from "../domain/ports";

export interface StoreFixture {
  readonly store: DropStore;
  readonly ensureUser: (id: string) => Promise<void>;
  readonly eventTypes: () => Promise<readonly string[]>;
}

export const T0 = 1_800_000_000_000;
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const DEVICE = (n: number): string => String(n).padStart(64, "0");

export const drop = (n: number, over: Partial<Drop> = {}): Drop => ({
  id: U(100 + n),
  storeId: U(9001),
  type: "public",
  state: "DRAFT",
  title: `Drop ${n}`,
  startsAtMs: T0 + n * 60_000,
  earlyAccessAtMs: null,
  endsAtMs: T0 + n * 60_000 + 3_600_000,
  items: [
    { skuId: U(7001), stockCap: 10, pricePiastres: 9_007_199_254_740_993n },
    { skuId: U(7002), stockCap: 3, pricePiastres: 5_000n },
  ],
  limits: { perUser: 2, perDevice: 3 },
  ladder: [],
  mystery: null,
  admitPerSec: 25,
  paused: false,
  createdAtMs: T0,
  updatedAtMs: T0,
  version: 1,
  ...over,
});

export function describeDropStoreContract(name: string, make: () => Promise<StoreFixture>): void {
  describe(`drop store contract: ${name}`, () => {
    it("round-trips a drop including ladder, mystery terms and bigint money", async () => {
      const f = await make();
      const d = drop(1, {
        type: "price_ladder",
        ladder: [
          { atMs: T0 + 60_000, pricePiastres: 9_007_199_254_740_993n },
          { atMs: T0 + 120_000, pricePiastres: 8_000n },
        ],
      });
      await f.store.insert(d, []);
      const got = await f.store.get(d.id);
      expect(got).toEqual({ ...d, items: [...d.items].sort((a, b) => (a.skuId < b.skuId ? -1 : 1)) });
      const m = drop(2, {
        type: "mystery_box",
        mystery: { minValuePiastres: 1n, maxValuePiastres: 9n, guaranteedMinPiastres: 2n },
      });
      await f.store.insert(m, []);
      expect((await f.store.get(m.id))?.mystery).toEqual(m.mystery);
      expect(await f.store.get(U(999))).toBeNull();
    });

    it("saves with an optimistic version and emits the event once", async () => {
      const f = await make();
      const d = drop(3);
      await f.store.insert(d, []);
      const next: Drop = { ...d, state: "SCHEDULED", updatedAtMs: T0 + 1 };
      const ev = [{ type: "drop.scheduled" as const, dropId: d.id, storeId: d.storeId, startsAtMs: d.startsAtMs }];
      expect(await f.store.save(next, 1, ev)).toBe("ok");
      expect(await f.store.save(next, 1, ev)).toBe("conflict");
      expect(await f.store.save({ ...next, id: U(998) }, 1, [])).toBe("not_found");
      const got = await f.store.get(d.id);
      expect(got?.state).toBe("SCHEDULED");
      expect(got?.version).toBe(2);
      expect((await f.eventTypes()).filter((t) => t === "drop.scheduled")).toHaveLength(1);
    });

    it("replaces items on save", async () => {
      const f = await make();
      const d = drop(4);
      await f.store.insert(d, []);
      const items = [{ skuId: U(7001), stockCap: 20, pricePiastres: 1n }];
      await f.store.save({ ...d, items }, 1, []);
      expect((await f.store.get(d.id))?.items).toEqual(items);
    });

    it("only a DRAFT can be removed", async () => {
      const f = await make();
      const a = drop(5);
      const b = drop(6, { state: "SCHEDULED" });
      await f.store.insert(a, []);
      await f.store.insert(b, []);
      expect(await f.store.removeDraft(a.id)).toBe(true);
      expect(await f.store.removeDraft(b.id)).toBe(false);
      expect(await f.store.get(a.id)).toBeNull();
    });

    it("lists public drops newest start first with a keyset, hiding DRAFT and ARCHIVED", async () => {
      const f = await make();
      const mk = (n: number, state: Drop["state"]) => drop(n, { state, startsAtMs: T0 + n * 1000, endsAtMs: T0 + n * 1000 + 10_000 });
      for (const [n, s] of [[10, "LIVE"], [11, "SCHEDULED"], [12, "DRAFT"], [13, "ARCHIVED"], [14, "ENDED"]] as const) await f.store.insert(mk(n, s), []);
      const first = await f.store.listPublic(null, 2);
      expect(first.map((d) => d.id)).toEqual([U(114), U(111)]);
      const last = first[1];
      if (last === undefined) throw new Error("no row");
      const second = await f.store.listPublic({ startsAtMs: last.startsAtMs, id: last.id }, 5);
      expect(second.map((d) => d.id)).toEqual([U(110)]);
      const mine = await f.store.listByStores([U(9001)], null, 50);
      expect(mine.map((d) => d.id)).toContain(U(112));
      expect(await f.store.listByStores([], null, 5)).toEqual([]);
    });

    it("active() returns only SCHEDULED, EARLY_ACCESS and LIVE", async () => {
      const f = await make();
      await f.store.insert(drop(20, { state: "LIVE" }), []);
      await f.store.insert(drop(21, { state: "ENDED" }), []);
      await f.store.insert(drop(22, { state: "DRAFT" }), []);
      expect((await f.store.active()).map((d) => d.id)).toEqual([U(120)]);
    });

    it("waitlist is idempotent per user", async () => {
      const f = await make();
      const d = drop(30, { state: "SOLD_OUT" });
      await f.store.insert(d, []);
      await f.ensureUser(U(1));
      const ev = [{ type: "drop.waitlist_joined" as const, dropId: d.id, userId: U(1) }];
      expect(await f.store.addWaitlist(d.id, U(1), T0, ev)).toBe("added");
      expect(await f.store.addWaitlist(d.id, U(1), T0, ev)).toBe("exists");
      expect(await f.store.waitlistSize(d.id)).toBe(1);
      expect((await f.eventTypes()).filter((t) => t === "drop.waitlist_joined")).toHaveLength(1);
    });

    it("tracks allowances per user and device, idempotent per reservation, freed on release", async () => {
      const f = await make();
      const d = drop(31, { state: "LIVE" });
      await f.store.insert(d, []);
      for (const n of [1, 2]) await f.ensureUser(U(n));
      const p = (res: number, user: number, dev: number, qty: number) => ({
        reservationId: U(500 + res),
        dropId: d.id,
        skuId: U(7001),
        userId: U(user),
        deviceHash: DEVICE(dev),
        qty,
        createdAtMs: T0 + res,
      });
      expect(await f.store.recordPurchase(p(1, 1, 1, 2), [])).toBe("recorded");
      expect(await f.store.recordPurchase(p(1, 1, 1, 2), [])).toBe("exists");
      expect(await f.store.recordPurchase(p(2, 2, 1, 1), [])).toBe("recorded");
      expect(await f.store.purchased(d.id, U(7001), U(1), DEVICE(1))).toEqual({ byUser: 2, byDevice: 3 });
      expect(await f.store.purchased(d.id, U(7001), U(2), DEVICE(9))).toEqual({ byUser: 1, byDevice: 0 });
      expect(await f.store.boughtSince(d.id, T0)).toBe(3);
      expect(await f.store.releasePurchase(U(501), T0 + 5)).toMatchObject({ qty: 2, userId: U(1) });
      expect(await f.store.releasePurchase(U(501), T0 + 6)).toBeNull();
      expect(await f.store.purchased(d.id, U(7001), U(1), DEVICE(1))).toEqual({ byUser: 0, byDevice: 1 });
      expect(await f.store.boughtSince(d.id, T0)).toBe(1);
    });
  });
}
