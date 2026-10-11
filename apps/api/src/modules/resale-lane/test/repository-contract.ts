import { beforeEach, describe, expect, it } from "vitest";
import type { ProceedsRecord, ResaleStore } from "../domain/ports";
import { START_MS, STORE_A, STORE_B, U, listing } from "./fixtures";

export interface ResaleContract {
  readonly store: ResaleStore;
  ensureUser(id: string): Promise<void>;
  eventTypes(): Promise<readonly string[]>;
}

const proceeds = (id: string, over: Partial<ProceedsRecord> = {}): ProceedsRecord => ({
  listingId: id,
  gross: 80_000n,
  sellerPayable: 68_000n,
  platformRetained: 12_000n,
  ledgerEntryId: null,
  recordedAtMs: START_MS + 5_000,
  ...over,
});

export function runResaleStoreContract(name: string, make: () => Promise<ResaleContract>): void {
  describe(`ResaleStore contract: ${name}`, () => {
    let c: ResaleContract;
    beforeEach(async () => {
      c = await make();
      await c.ensureUser(U(11));
    });
    const ev = (n: number) => [{ type: "resale.listed" as const, listingId: U(4000 + n), storeId: STORE_A, grade: "B" as const }];

    it("round-trips a listing with the outbox event in the same transaction", async () => {
      const l = listing(1);
      expect(await c.store.insertListing(l, ev(1))).toBe("created");
      expect(await c.store.getListing(l.id)).toEqual(l);
      expect(await c.store.getListing("nope")).toBeNull();
      expect(await c.eventTypes()).toEqual(["resale.listed"]);
      expect(await c.store.countForUnit(l.unitRef)).toBe(1);
    });

    it("a return and a physical unit can each be listed once", async () => {
      expect(await c.store.insertListing(listing(1), ev(1))).toBe("created");
      expect(await c.store.insertListing(listing(2, { returnId: listing(1).returnId }), ev(2))).toBe("duplicate_return");
      expect(await c.store.insertListing(listing(3, { unitRef: listing(1).unitRef }), ev(3))).toBe("duplicate_unit");
      expect(await c.eventTypes()).toEqual(["resale.listed"]);
    });

    it("lists live newest first with a stable cursor and scopes by store", async () => {
      for (const n of [1, 2, 3]) await c.store.insertListing(listing(n, n === 2 ? { storeId: STORE_B } : {}), []);
      const first = await c.store.listLive(2, null);
      expect(first.map((l) => l.id)).toEqual([U(4003), U(4002)]);
      const last = first[1];
      if (last === undefined) throw new Error("page");
      const next = await c.store.listLive(2, { listedAtMs: last.listedAtMs, id: last.id });
      expect(next.map((l) => l.id)).toEqual([U(4001)]);
      expect((await c.store.listForStore(STORE_B, 10)).map((l) => l.id)).toEqual([U(4002)]);
    });

    it("sells once: compare-and-set with proceeds and event, a replay is not_listed", async () => {
      const l = listing(1);
      await c.store.insertListing(l, []);
      const p = proceeds(l.id);
      const sold = [{ type: "resale.sold" as const, listingId: l.id, storeId: STORE_A }];
      expect(await c.store.markSold({ listingId: l.id, nowMs: START_MS + 5_000, proceeds: p, events: sold })).toBe("ok");
      expect(await c.store.markSold({ listingId: l.id, nowMs: START_MS + 6_000, proceeds: p, events: sold })).toBe("not_listed");
      expect(await c.store.markSold({ listingId: U(9999), nowMs: 1, proceeds: proceeds(U(9999)), events: [] })).toBe("not_found");
      expect(await c.store.getListing(l.id)).toMatchObject({ status: "SOLD", soldAtMs: START_MS + 5_000 });
      expect(await c.store.getProceeds(l.id)).toEqual(p);
      expect((await c.store.listLive(10, null)).length).toBe(0);
      expect(await c.eventTypes()).toEqual(["resale.sold"]);
      expect(await c.store.withdraw({ listingId: l.id, events: [] })).toBe("not_listed");
    });

    it("withdraws a live listing once and then it cannot be sold", async () => {
      const l = listing(1);
      await c.store.insertListing(l, []);
      expect(await c.store.withdraw({ listingId: l.id, events: [{ type: "resale.withdrawn", listingId: l.id, storeId: STORE_A }] })).toBe("ok");
      expect(await c.store.withdraw({ listingId: l.id, events: [] })).toBe("not_listed");
      expect(await c.store.markSold({ listingId: l.id, nowMs: 1, proceeds: proceeds(l.id), events: [] })).toBe("not_listed");
      expect(await c.store.getListing(l.id)).toMatchObject({ status: "WITHDRAWN" });
      expect(await c.store.getProceeds(l.id)).toBeNull();
    });
  });
}
