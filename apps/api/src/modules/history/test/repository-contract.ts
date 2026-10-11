import { describe, expect, it } from "vitest";
import type { HistoryEvent } from "../domain/bridge";
import type { HistoryStore } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const E = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
export const T0 = 1_800_000_000_000;

export const event = (n: number, userId: string, over: Partial<HistoryEvent> = {}): HistoryEvent => ({
  id: E(n),
  userId,
  type: "viewed",
  itemId: U(7000 + n),
  storeId: U(9001),
  categoryId: "dress",
  priceMinor: 100_000n,
  detail: null,
  atMs: T0 + n * 1000,
  ...over,
});

export interface ContractCtx {
  readonly store: HistoryStore;
  ensureUser(id: string): Promise<void>;
  outboxTypes(): Promise<string[]>;
}

export function describeHistoryStoreContract(name: string, make: () => Promise<ContractCtx>): void {
  describe(`HistoryStore contract: ${name}`, () => {
    it("appends idempotently and lists newest first with keyset paging", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      for (let n = 1; n <= 5; n++) expect(await c.store.appendEvent(event(n, U(1)))).toBe("recorded");
      expect(await c.store.appendEvent(event(3, U(1)))).toBe("duplicate");
      const p1 = await c.store.listEvents(U(1), null, null, 2);
      expect(p1.map((e) => e.id)).toEqual([E(5), E(4)]);
      const last = p1[1]!;
      const p2 = await c.store.listEvents(U(1), null, { atMs: last.atMs, id: last.id }, 10);
      expect(p2.map((e) => e.id)).toEqual([E(3), E(2), E(1)]);
      expect(p1[0]?.priceMinor).toBe(100_000n);
    });

    it("filters by type and by user", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      await c.store.appendEvent(event(1, U(1)));
      await c.store.appendEvent(event(2, U(1), { type: "bought" }));
      await c.store.appendEvent(event(3, U(2), { type: "bought" }));
      await c.store.appendEvent(event(4, U(1), { type: "searched", itemId: null, detail: "white linen dress" }));
      expect((await c.store.listEvents(U(1), "bought", null, 10)).map((e) => e.id)).toEqual([E(2)]);
      expect((await c.store.listEvents(U(1), "searched", null, 10))[0]?.detail).toBe("white linen dress");
      expect(await c.store.listEvents(U(2), "viewed", null, 10)).toEqual([]);
    });

    it("settings default on and not paused; changes emit outbox events", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      expect(await c.store.getSettings(U(1))).toEqual({ personalization: true, historyPaused: false });
      await c.store.setPaused(U(1), true, T0, [{ type: "history.paused_changed", userId: U(1), paused: true }]);
      const s = await c.store.setPersonalization(U(1), false, T0, [{ type: "personalization.changed", userId: U(1), personalization: false }]);
      expect(s).toEqual({ personalization: false, historyPaused: true });
      expect(await c.outboxTypes()).toEqual(["history.paused_changed", "personalization.changed"]);
    });

    it("features round trip and refuse budget keys", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const f = { categoryAffinity: { dress: 1000 }, storeAffinity: { [U(9001)]: 400 }, builtAtMs: T0 };
      await c.store.putFeatures(U(1), { features: f, modelVersion: "feat-v1" });
      expect(await c.store.getFeatures(U(1))).toEqual({ features: f, modelVersion: "feat-v1" });
      await expect(
        c.store.putFeatures(U(1), {
          features: { categoryAffinity: { remaining_budget: 5 }, storeAffinity: {}, builtAtMs: T0 },
          modelVersion: "x",
        }),
      ).rejects.toThrow();
      expect(await c.store.deleteFeatures(U(1))).toBe(true);
      expect(await c.store.getFeatures(U(1))).toBeNull();
    });

    it("recently viewed: one row per product, newest first, capped", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      for (let n = 1; n <= 5; n++) await c.store.upsertRecentlyViewed(U(1), { productId: U(7000 + n), viewedAtMs: T0 + n, priceMinor: 5n }, 3);
      await c.store.upsertRecentlyViewed(U(1), { productId: U(7003), viewedAtMs: T0 + 99, priceMinor: 7n }, 3);
      const l = await c.store.listRecentlyViewed(U(1), 10);
      expect(l.map((r) => r.productId)).toEqual([U(7003), U(7005), U(7004)]);
      expect(l[0]?.priceMinor).toBe(7n);
    });

    it("clearAll removes events, features and recently viewed for that user only, and records the request", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      await c.store.appendEvent(event(1, U(1)));
      await c.store.appendEvent(event(2, U(1)));
      await c.store.appendEvent(event(3, U(2)));
      await c.store.putFeatures(U(1), { features: { categoryAffinity: {}, storeAffinity: {}, builtAtMs: T0 }, modelVersion: "v" });
      await c.store.upsertRecentlyViewed(U(1), { productId: U(7001), viewedAtMs: T0, priceMinor: null }, 50);
      const r = await c.store.clearAll({
        requestId: E(900),
        userId: U(1),
        nowMs: T0 + 10_000,
        deadlineMs: T0 + 10_000 + 86_400_000,
        events: [{ type: "history.cleared", userId: U(1), requestId: E(900), deadlineMs: T0 + 10_000 + 86_400_000 }],
      });
      expect(r.counts).toEqual({ events: 2, features: 1, recentlyViewed: 1 });
      expect(await c.store.listEvents(U(1), null, null, 10)).toEqual([]);
      expect(await c.store.getFeatures(U(1))).toBeNull();
      expect(await c.store.listRecentlyViewed(U(1), 10)).toEqual([]);
      expect((await c.store.listEvents(U(2), null, null, 10)).length).toBe(1);
      expect((await c.store.pendingClearForUser(U(1))).map((x) => x.id)).toEqual([E(900)]);
      expect(await c.outboxTypes()).toContain("history.cleared");
    });

    it("completeClear re-deletes rebuilt derived rows at or before the request and completes once", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.store.clearAll({ requestId: E(901), userId: U(1), nowMs: T0, deadlineMs: T0 + 1000, events: [] });
      // a batch job rebuilt features and wrote a late event timestamped before the clear
      await c.store.putFeatures(U(1), { features: { categoryAffinity: { a: 1 }, storeAffinity: {}, builtAtMs: T0 - 5 }, modelVersion: "v" });
      await c.store.appendEvent(event(1, U(1), { atMs: T0 - 10 }));
      await c.store.appendEvent(event(2, U(1), { atMs: T0 + 500 }));
      const done = await c.store.completeClear(E(901), T0 + 2000);
      expect(done).toEqual({ events: 1, features: 1, recentlyViewed: 0 });
      expect((await c.store.listEvents(U(1), null, null, 10)).map((e) => e.id)).toEqual([E(2)]);
      expect(await c.store.completeClear(E(901), T0 + 3000)).toBeNull();
      expect(await c.store.pendingClearRequests(10)).toEqual([]);
    });

    it("retention purge removes only events older than the cutoff", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.store.appendEvent(event(1, U(1), { atMs: T0 - 1000 }));
      await c.store.appendEvent(event(2, U(1), { atMs: T0 + 1000 }));
      expect(await c.store.purgeEventsBefore(T0, 100)).toBe(1);
      expect((await c.store.listEvents(U(1), null, null, 10)).map((e) => e.id)).toEqual([E(2)]);
    });

    it("rebuild worklist excludes users with personalization off", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      await c.store.appendEvent(event(1, U(1)));
      await c.store.appendEvent(event(2, U(2)));
      await c.store.setPersonalization(U(2), false, T0, []);
      expect(await c.store.usersWithRecentEvents(T0, 10)).toEqual([U(1)]);
    });
  });
}
